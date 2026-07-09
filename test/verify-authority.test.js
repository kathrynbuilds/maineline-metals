import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockAirtable, noSleep } from './helpers/mock-airtable.js';
import { createAirtableClient } from '../carriers/airtable-client.js';
import {
  runVerifyCarriers,
  interpretQcResponse,
  resolveAuthorityFields,
  isVerificationFresh,
  memoryCache,
} from '../carriers/verify-authority.js';
import { TABLES, CARRIER, STATUS, AUTHORITY_STATUS } from '../carriers/schema.js';

const quiet = () => {};
const NOW = new Date('2026-07-09T12:00:00Z');
const FIELD_IDS = {
  authorityStatus: 'fldAuthStatusTEST',
  authorityVerifiedDate: 'fldAuthDateTEST00',
  oosFlag: 'fldOosFlagTEST000',
};

const qcActive = { content: { carrier: { allowedToOperate: 'Y', oosDate: null } } };
const qcRevoked = { content: { carrier: { allowedToOperate: 'N', oosDate: null } } };
const qcOos = { content: { carrier: { allowedToOperate: 'Y', oosDate: '2026-05-01' } } };
const qcNotFound = { notFound: true };

function fakeQc(responsesByDot) {
  const calls = [];
  return {
    calls,
    async getCarrier(dot) {
      calls.push(dot);
      const r = responsesByDot[dot];
      if (r instanceof Error) throw r;
      return r ?? qcNotFound;
    },
  };
}

function carrierRec(id, fields) {
  return { id, fields };
}

function makeClient(mock, opts = {}) {
  return createAirtableClient({ pat: 'pat_test', fetchImpl: mock.fetchImpl, sleep: noSleep, ...opts });
}

test('interpretQcResponse maps QCMobile shapes to authority verdicts', () => {
  assert.equal(interpretQcResponse(qcActive).status, AUTHORITY_STATUS.ACTIVE);
  assert.equal(interpretQcResponse(qcRevoked).status, AUTHORITY_STATUS.INACTIVE);
  assert.equal(interpretQcResponse(qcOos).oos, true);
  assert.equal(interpretQcResponse(qcNotFound).status, AUTHORITY_STATUS.NOT_FOUND);
  assert.equal(interpretQcResponse({ content: null }).status, AUTHORITY_STATUS.NOT_FOUND);
  assert.equal(
    interpretQcResponse({ content: { carrier: { allowedToOperate: undefined } } }).status,
    AUTHORITY_STATUS.ERROR
  );
});

test('acceptance: revoked authority ends at Do Not Use with an explanatory note', async () => {
  const mock = createMockAirtable({
    tables: {
      [TABLES.CARRIERS]: [
        carrierRec('rec_revoked', {
          [CARRIER.carrierName]: 'GHOST FREIGHT LLC',
          [CARRIER.dotNumber]: '111',
          [CARRIER.status]: STATUS.CONTACTED,
          [CARRIER.notes]: 'existing human note',
        }),
      ],
    },
  });
  const qc = fakeQc({ 111: qcRevoked });
  const stats = await runVerifyCarriers({
    client: makeClient(mock),
    qc,
    fieldIds: FIELD_IDS,
    now: NOW,
    printer: quiet,
  });
  assert.equal(stats.demoted, 1);
  const [rec] = mock.getRecords(TABLES.CARRIERS);
  assert.equal(rec.fields[CARRIER.status], STATUS.DO_NOT_USE);
  assert.equal(rec.fields[FIELD_IDS.authorityStatus], AUTHORITY_STATUS.INACTIVE);
  assert.equal(rec.fields[FIELD_IDS.authorityVerifiedDate], '2026-07-09');
  assert.match(rec.fields[CARRIER.notes], /existing human note/);
  assert.match(rec.fields[CARRIER.notes], /\[2026-07-09 verify-authority\] Status set to Do Not Use/);
  assert.match(rec.fields[CARRIER.notes], /allowedToOperate=N/);
});

test('out-of-service carrier is demoted and OOS Flag set', async () => {
  const mock = createMockAirtable({
    tables: {
      [TABLES.CARRIERS]: [
        carrierRec('rec_oos', {
          [CARRIER.carrierName]: 'SIDELINED TRUCKING',
          [CARRIER.dotNumber]: '222',
          [CARRIER.status]: STATUS.VETTED,
        }),
      ],
    },
  });
  await runVerifyCarriers({
    client: makeClient(mock),
    qc: fakeQc({ 222: qcOos }),
    fieldIds: FIELD_IDS,
    now: NOW,
    printer: quiet,
  });
  const [rec] = mock.getRecords(TABLES.CARRIERS);
  assert.equal(rec.fields[CARRIER.status], STATUS.DO_NOT_USE);
  assert.equal(rec.fields[FIELD_IDS.oosFlag], true);
  assert.match(rec.fields[CARRIER.notes], /OUT OF SERVICE/);
});

test('acceptance: verified-active carrier gets its date refreshed and status untouched', async () => {
  const mock = createMockAirtable({
    tables: {
      [TABLES.CARRIERS]: [
        carrierRec('rec_ok', {
          [CARRIER.carrierName]: 'OZARK STEEL HAULERS LLC',
          [CARRIER.dotNumber]: '333',
          [CARRIER.status]: STATUS.PACKET_COMPLETE,
          [FIELD_IDS.authorityVerifiedDate]: '2026-01-01', // stale
        }),
      ],
    },
  });
  const stats = await runVerifyCarriers({
    client: makeClient(mock),
    qc: fakeQc({ 333: qcActive }),
    fieldIds: FIELD_IDS,
    now: NOW,
    printer: quiet,
  });
  assert.equal(stats.active, 1);
  const [rec] = mock.getRecords(TABLES.CARRIERS);
  assert.equal(rec.fields[CARRIER.status], STATUS.PACKET_COMPLETE, 'no promotion, no demotion');
  assert.equal(rec.fields[FIELD_IDS.authorityStatus], AUTHORITY_STATUS.ACTIVE);
  assert.equal(rec.fields[FIELD_IDS.authorityVerifiedDate], '2026-07-09');
});

test('carriers verified within 30 days are skipped unless --force', async () => {
  const fresh = carrierRec('rec_fresh', {
    [CARRIER.carrierName]: 'FRESHLY CHECKED INC',
    [CARRIER.dotNumber]: '444',
    [CARRIER.status]: STATUS.RESEARCHED,
    [FIELD_IDS.authorityVerifiedDate]: '2026-07-01',
  });
  {
    const mock = createMockAirtable({ tables: { [TABLES.CARRIERS]: [fresh] } });
    const qc = fakeQc({ 444: qcActive });
    const stats = await runVerifyCarriers({
      client: makeClient(mock),
      qc,
      fieldIds: FIELD_IDS,
      now: NOW,
      printer: quiet,
    });
    assert.equal(stats.skippedFresh, 1);
    assert.equal(qc.calls.length, 0, 'no API call for fresh verification');
  }
  {
    const mock = createMockAirtable({ tables: { [TABLES.CARRIERS]: [structuredClone(fresh)] } });
    const qc = fakeQc({ 444: qcActive });
    const stats = await runVerifyCarriers({
      client: makeClient(mock),
      qc,
      fieldIds: FIELD_IDS,
      now: NOW,
      force: true,
      printer: quiet,
    });
    assert.equal(stats.checked, 1);
    assert.equal(qc.calls.length, 1);
  }
});

test('local cache prevents re-querying a DOT across runs', async () => {
  const rec = () =>
    carrierRec('rec_c', {
      [CARRIER.carrierName]: 'CACHED CARRIER',
      [CARRIER.dotNumber]: '555',
      [CARRIER.status]: STATUS.RESEARCHED,
    });
  const cache = memoryCache();
  const mock1 = createMockAirtable({ tables: { [TABLES.CARRIERS]: [rec()] } });
  const qc1 = fakeQc({ 555: qcActive });
  await runVerifyCarriers({
    client: makeClient(mock1),
    qc: qc1,
    fieldIds: FIELD_IDS,
    cache,
    now: NOW,
    printer: quiet,
  });
  assert.equal(qc1.calls.length, 1);

  // second run: Airtable record (dry, unwritten copy) still has no date, but
  // the cache remembers the check
  const mock2 = createMockAirtable({ tables: { [TABLES.CARRIERS]: [rec()] } });
  const qc2 = fakeQc({ 555: qcActive });
  const stats = await runVerifyCarriers({
    client: makeClient(mock2),
    qc: qc2,
    fieldIds: FIELD_IDS,
    cache,
    now: NOW,
    printer: quiet,
  });
  assert.equal(qc2.calls.length, 0);
  assert.equal(stats.skippedFresh, 1);
});

test('Not Found is flagged in Notes but NOT auto-demoted; API errors touch nothing', async () => {
  const mock = createMockAirtable({
    tables: {
      [TABLES.CARRIERS]: [
        carrierRec('rec_nf', {
          [CARRIER.carrierName]: 'MYSTERY DOT LLC',
          [CARRIER.dotNumber]: '666',
          [CARRIER.status]: STATUS.RESPONDED,
        }),
        carrierRec('rec_err', {
          [CARRIER.carrierName]: 'FLAKY API VICTIM',
          [CARRIER.dotNumber]: '777',
          [CARRIER.status]: STATUS.RESPONDED,
        }),
      ],
    },
  });
  const stats = await runVerifyCarriers({
    client: makeClient(mock),
    qc: fakeQc({ 666: qcNotFound, 777: new Error('QCMobile timeout') }),
    fieldIds: FIELD_IDS,
    now: NOW,
    printer: quiet,
  });
  assert.equal(stats.notFound, 1);
  assert.equal(stats.errors, 1);
  const [nf, err] = mock.getRecords(TABLES.CARRIERS);
  assert.equal(nf.fields[CARRIER.status], STATUS.RESPONDED, 'not demoted');
  assert.match(nf.fields[CARRIER.notes], /not found in FMCSA QCMobile/);
  assert.match(nf.fields[CARRIER.notes], /fraud signal/);
  assert.equal(err.fields[CARRIER.notes], undefined, 'error case left untouched');
  assert.equal(err.fields[FIELD_IDS.authorityVerifiedDate], undefined);
});

test('out-of-scope statuses (Declined, Do Not Use) are never queried', async () => {
  const mock = createMockAirtable({
    tables: {
      [TABLES.CARRIERS]: [
        carrierRec('rec_dnu', {
          [CARRIER.dotNumber]: '888',
          [CARRIER.status]: STATUS.DO_NOT_USE,
        }),
        carrierRec('rec_dec', {
          [CARRIER.dotNumber]: '999',
          [CARRIER.status]: STATUS.DECLINED,
        }),
      ],
    },
  });
  const qc = fakeQc({});
  const stats = await runVerifyCarriers({
    client: makeClient(mock),
    qc,
    fieldIds: FIELD_IDS,
    now: NOW,
    printer: quiet,
  });
  assert.equal(stats.inScope, 0);
  assert.equal(qc.calls.length, 0);
});

test('dry-run performs no Airtable writes', async () => {
  const mock = createMockAirtable({
    tables: {
      [TABLES.CARRIERS]: [
        carrierRec('rec_dry', {
          [CARRIER.dotNumber]: '123',
          [CARRIER.status]: STATUS.CONTACTED,
        }),
      ],
    },
  });
  await runVerifyCarriers({
    client: makeClient(mock, { dryRun: true }),
    qc: fakeQc({ 123: qcRevoked }),
    fieldIds: FIELD_IDS,
    now: NOW,
    printer: quiet,
  });
  assert.equal(mock.writesFor(TABLES.CARRIERS).length, 0);
  const [rec] = mock.getRecords(TABLES.CARRIERS);
  assert.equal(rec.fields[CARRIER.status], STATUS.CONTACTED);
});

test('isVerificationFresh: 30-day boundary', () => {
  assert.equal(isVerificationFresh('2026-07-01', NOW), true);
  assert.equal(isVerificationFresh('2026-06-09', NOW), true, 'exactly 30 days is still fresh');
  assert.equal(isVerificationFresh('2026-06-08', NOW), false);
  assert.equal(isVerificationFresh(undefined, NOW), false);
  assert.equal(isVerificationFresh('garbage', NOW), false);
});

test('resolveAuthorityFields finds fields by name and provisions missing ones', async () => {
  const created = [];
  let provisioned = false;
  const fakeClient = {
    async getBaseSchema() {
      const fields = [
        { id: 'fldName', name: 'Carrier Name' },
        ...(provisioned
          ? [
              { id: 'fldA', name: 'Authority Status' },
              { id: 'fldB', name: 'Authority Verified Date' },
              { id: 'fldC', name: 'OOS Flag' },
            ]
          : [{ id: 'fldA', name: 'Authority Status' }]),
      ];
      return { tables: [{ id: TABLES.CARRIERS, fields }] };
    },
    async createField(tableId, spec) {
      created.push(spec.name);
      if (created.length === 2) provisioned = true;
      return { id: `fld_${spec.name}` };
    },
  };

  await assert.rejects(
    () => resolveAuthorityFields(fakeClient),
    /missing authority field\(s\).*--provision/s
  );
  const ids = await resolveAuthorityFields(fakeClient, { provision: true });
  assert.deepEqual(created, ['Authority Verified Date', 'OOS Flag']);
  assert.deepEqual(ids, {
    authorityStatus: 'fldA',
    authorityVerifiedDate: 'fldB',
    oosFlag: 'fldC',
  });
});
