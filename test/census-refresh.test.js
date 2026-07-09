import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockAirtable, noSleep } from './helpers/mock-airtable.js';
import { createAirtableClient } from '../carriers/airtable-client.js';
import { runCensusRefresh } from '../carriers/census-refresh.js';
import { TABLES, CARRIER, STATUS, SOURCE_FMCSA_CENSUS } from '../carriers/schema.js';

const BATCH = 'Blytheville-Atlanta (origin)';
const quiet = () => {};

function censusRecord(overrides = {}) {
  return {
    dotNumber: '1234567',
    mcNumber: '987654',
    legalName: 'OZARK STEEL HAULERS LLC',
    dbaName: null,
    city: 'JONESBORO',
    state: 'AR',
    phone: '(870) 555-0101',
    email: 'dispatch@ozarksteel.example',
    powerUnits: 12,
    ...overrides,
  };
}

function makeClient(mock, { dryRun = false } = {}) {
  return createAirtableClient({
    pat: 'pat_test',
    fetchImpl: mock.fetchImpl,
    sleep: noSleep,
    dryRun,
  });
}

test('new census records are created as Researched / FMCSA Census with lane batch', async () => {
  const mock = createMockAirtable();
  const client = makeClient(mock);
  const stats = await runCensusRefresh({
    client,
    records: [censusRecord()],
    batchLabel: BATCH,
    printer: quiet,
  });
  assert.equal(stats.created, 1);
  const [rec] = mock.getRecords(TABLES.CARRIERS);
  assert.equal(rec.fields[CARRIER.status], STATUS.RESEARCHED);
  assert.equal(rec.fields[CARRIER.source], SOURCE_FMCSA_CENSUS);
  assert.equal(rec.fields[CARRIER.laneBatch], BATCH);
  assert.equal(rec.fields[CARRIER.dotNumber], '1234567');
  assert.equal(rec.fields[CARRIER.carrierName], 'OZARK STEEL HAULERS LLC');
});

test('acceptance: running twice in a row produces zero new records the second time', async () => {
  const mock = createMockAirtable();
  const records = [
    censusRecord(),
    censusRecord({ dotNumber: '7654321', legalName: 'DIXIE FLATBED INC', state: 'GA' }),
  ];
  const first = await runCensusRefresh({
    client: makeClient(mock),
    records,
    batchLabel: BATCH,
    printer: quiet,
  });
  assert.equal(first.created, 2);

  const second = await runCensusRefresh({
    client: makeClient(mock),
    records,
    batchLabel: BATCH,
    printer: quiet,
  });
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 2);
  assert.equal(mock.getRecords(TABLES.CARRIERS).length, 2);
});

test('invariant 3: existing non-blank fields are never overwritten; conflicts go to Notes', async () => {
  const mock = createMockAirtable({
    tables: {
      [TABLES.CARRIERS]: [
        {
          id: 'rec_human',
          fields: {
            [CARRIER.dotNumber]: '1234567',
            [CARRIER.carrierName]: 'Ozark Steel Haulers', // human-entered casing
            [CARRIER.phone]: '870-555-9999', // human-entered, differs from census
            [CARRIER.status]: STATUS.VETTED,
            [CARRIER.notes]: 'Talked to Randy 6/12 — solid outfit.',
          },
        },
      ],
    },
  });
  const client = makeClient(mock);
  const stats = await runCensusRefresh({
    client,
    records: [censusRecord()],
    batchLabel: BATCH,
    now: new Date('2026-07-09T12:00:00Z'),
    printer: quiet,
  });
  assert.equal(stats.created, 0);
  assert.equal(stats.updated, 1);
  assert.ok(stats.conflictsLogged >= 1);

  const [rec] = mock.getRecords(TABLES.CARRIERS);
  // human-entered values untouched
  assert.equal(rec.fields[CARRIER.phone], '870-555-9999');
  assert.equal(rec.fields[CARRIER.status], STATUS.VETTED);
  // blanks filled
  assert.equal(rec.fields[CARRIER.email], 'dispatch@ozarksteel.example');
  assert.equal(rec.fields[CARRIER.powerUnits], 12);
  // conflict logged to Notes, original note preserved
  assert.match(rec.fields[CARRIER.notes], /Talked to Randy 6\/12/);
  assert.match(rec.fields[CARRIER.notes], /\[2026-07-09 census-refresh\] Conflict on Phone/);
  assert.match(rec.fields[CARRIER.notes], /870-555-9999/);
});

test('existing records never have Status, Source, or Lane Batch modified', async () => {
  const mock = createMockAirtable({
    tables: {
      [TABLES.CARRIERS]: [
        {
          id: 'rec_x',
          fields: {
            [CARRIER.dotNumber]: '1234567',
            [CARRIER.status]: STATUS.CONTACTED,
            // Source and Lane Batch deliberately blank — automation must not
            // "helpfully" fill pipeline-meaning fields on existing records.
          },
        },
      ],
    },
  });
  const client = makeClient(mock);
  await runCensusRefresh({
    client,
    records: [censusRecord()],
    batchLabel: BATCH,
    printer: quiet,
  });
  const [rec] = mock.getRecords(TABLES.CARRIERS);
  assert.equal(rec.fields[CARRIER.status], STATUS.CONTACTED);
  assert.equal(rec.fields[CARRIER.source], undefined);
  assert.equal(rec.fields[CARRIER.laneBatch], undefined);
});

test('acceptance: --dry-run writes nothing but reports what it would do', async () => {
  const mock = createMockAirtable();
  const client = makeClient(mock, { dryRun: true });
  const stats = await runCensusRefresh({
    client,
    records: [censusRecord(), censusRecord({ dotNumber: '2222222', legalName: 'B' })],
    batchLabel: BATCH,
    printer: quiet,
  });
  assert.equal(stats.created, 2);
  assert.equal(mock.writesFor(TABLES.CARRIERS).length, 0, 'no writes hit the API');
  assert.equal(mock.getRecords(TABLES.CARRIERS).length, 0);
  assert.equal(client.writeLog.length, 1, 'intended writes are still auditable');
});

test('writes are batched at 10 records per request (Airtable limit)', async () => {
  const mock = createMockAirtable();
  const client = makeClient(mock);
  const records = Array.from({ length: 25 }, (_, i) =>
    censusRecord({ dotNumber: String(3000000 + i), legalName: `CARRIER ${i}` })
  );
  await runCensusRefresh({ client, records, batchLabel: BATCH, printer: quiet });
  const posts = mock.writesFor(TABLES.CARRIERS).filter((r) => r.method === 'POST');
  assert.deepEqual(
    posts.map((p) => p.body.records.length),
    [10, 10, 5]
  );
  assert.equal(mock.getRecords(TABLES.CARRIERS).length, 25);
});

test('duplicate DOTs within one census feed only create one record', async () => {
  const mock = createMockAirtable();
  const client = makeClient(mock);
  const stats = await runCensusRefresh({
    client,
    records: [censusRecord(), censusRecord({ legalName: 'SAME DOT AGAIN' })],
    batchLabel: BATCH,
    printer: quiet,
  });
  assert.equal(stats.created, 1);
  assert.equal(stats.duplicatesInFeed, 1);
});

test('per-state summary counts the filtered pool', async () => {
  const mock = createMockAirtable();
  const client = makeClient(mock);
  const stats = await runCensusRefresh({
    client,
    records: [
      censusRecord(),
      censusRecord({ dotNumber: '5555551', state: 'GA' }),
      censusRecord({ dotNumber: '5555552', state: 'GA' }),
    ],
    batchLabel: BATCH,
    printer: quiet,
  });
  assert.deepEqual(stats.perState, { AR: 1, GA: 2 });
});
