import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockAirtable, noSleep } from './helpers/mock-airtable.js';
import { createAirtableClient } from '../carriers/airtable-client.js';
import { runFollowups, memoryFollowupState } from '../carriers/email-intake/followups.js';
import { TABLES, CARRIER, ACTIVITY, EMAIL_STATUS, STATUS } from '../carriers/schema.js';

const quiet = () => {};
const NOW = new Date('2026-07-16T12:00:00Z');
const daysAgo = (n) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const tmpOutbox = () => mkdtempSync(join(tmpdir(), 'genesis-fu-'));

function contacted(id, silentDays, extra = {}) {
  return {
    id,
    fields: {
      [CARRIER.carrierName]: `CARRIER ${id}`,
      [CARRIER.email]: `${id}@example.com`,
      [CARRIER.status]: STATUS.CONTACTED,
      [CARRIER.lastContact]: daysAgo(silentDays),
      [CARRIER.laneBatch]: 'Blytheville-Atlanta (origin)',
      ...extra,
    },
  };
}

async function run(records, { state = memoryFollowupState(), outboxDir = tmpOutbox() } = {}) {
  const mock = createMockAirtable({ tables: { [TABLES.CARRIERS]: records } });
  const client = createAirtableClient({ pat: 'pat_test', fetchImpl: mock.fetchImpl, sleep: noSleep });
  const stats = await runFollowups({ client, state, now: NOW, outboxDir, printer: quiet });
  return { mock, stats, state, outboxDir };
}

test('cadence: day-3 and day-8 silence produce bump drafts in the approval queue only', async () => {
  const { mock, stats, outboxDir } = await run([
    contacted('rec_day1', 1),
    contacted('rec_day4', 4),
    contacted('rec_day9', 9),
  ]);
  assert.equal(stats.bump1, 1);
  assert.equal(stats.bump2, 1);
  assert.equal(stats.declined, 0);

  // drafts exist as Activities with Email Status = Draft…
  const activities = mock.getRecords(TABLES.ACTIVITIES);
  assert.equal(activities.length, 2);
  for (const a of activities) {
    assert.equal(a.fields[ACTIVITY.emailStatus], EMAIL_STATUS.DRAFT);
  }
  // …and as outbox files; but no status changes happened
  assert.equal(readdirSync(outboxDir).length, 2);
  for (const r of mock.getRecords(TABLES.CARRIERS)) {
    assert.equal(r.fields[CARRIER.status], STATUS.CONTACTED);
  }
});

test('cadence: 15 days of silence sets Status = Declined with a Notes explanation', async () => {
  const { mock, stats } = await run([
    contacted('rec_gone', 16, { [CARRIER.notes]: 'left vm 7/1' }),
  ]);
  assert.equal(stats.declined, 1);
  const [rec] = mock.getRecords(TABLES.CARRIERS);
  assert.equal(rec.fields[CARRIER.status], STATUS.DECLINED);
  assert.match(rec.fields[CARRIER.notes], /left vm 7\/1/);
  assert.match(rec.fields[CARRIER.notes], /No response after 16 days .* Status set to Declined/);
});

test('bumps are not duplicated across runs (state remembers what was drafted)', async () => {
  const state = memoryFollowupState();
  const outboxDir = tmpOutbox();
  const records = () => [contacted('rec_dup', 5)];
  const first = await run(records(), { state, outboxDir });
  assert.equal(first.stats.bump1, 1);
  const second = await run(records(), { state, outboxDir });
  assert.equal(second.stats.bump1, 0, 'no second draft for the same carrier');
  assert.equal(readdirSync(outboxDir).length, 1);
});

test('day-8 bump is not sent twice either, and day-8 supersedes day-3', async () => {
  const state = memoryFollowupState();
  const { stats } = await run([contacted('rec_9d', 9)], { state });
  assert.equal(stats.bump2, 1);
  assert.equal(stats.bump1, 0, 'day-8 window sends the day-8 template, not both');
});

test('Responded carriers with incomplete packets get the day-2 reminder listing missing items', async () => {
  const { mock, stats } = await run([
    {
      id: 'rec_resp',
      fields: {
        [CARRIER.carrierName]: 'PEACH STATE FLATBED, INC.',
        [CARRIER.email]: 'ops@psf.example',
        [CARRIER.status]: STATUS.RESPONDED,
        [CARRIER.lastContact]: daysAgo(3),
        [CARRIER.w9Received]: true, // W-9 done; COI + BCA still missing
      },
    },
  ]);
  assert.equal(stats.packetReminders, 1);
  const [activity] = mock.getRecords(TABLES.ACTIVITIES);
  assert.match(activity.fields[ACTIVITY.emailSubject], /just missing/);
  assert.match(activity.fields[ACTIVITY.emailBody], /insurance certificate \(from your producer\)/);
  assert.match(activity.fields[ACTIVITY.emailBody], /signed Broker-Carrier Agreement/);
  assert.ok(!activity.fields[ACTIVITY.emailBody].includes('W-9,'), 'received items not re-requested');
});

test('complete packets, fresh contacts, and other statuses are left alone', async () => {
  const { mock, stats } = await run([
    // Responded but packet complete -> nothing
    {
      id: 'rec_done',
      fields: {
        [CARRIER.carrierName]: 'DONE LLC',
        [CARRIER.status]: STATUS.RESPONDED,
        [CARRIER.lastContact]: daysAgo(5),
        [CARRIER.w9Received]: true,
        [CARRIER.coiReceived]: true,
        [CARRIER.bcaSigned]: true,
      },
    },
    // Responded yesterday, packet incomplete -> too soon
    {
      id: 'rec_soon',
      fields: {
        [CARRIER.carrierName]: 'SOON LLC',
        [CARRIER.status]: STATUS.RESPONDED,
        [CARRIER.lastContact]: daysAgo(1),
      },
    },
    // Vetted / Declined / Do Not Use are outside the cadence entirely
    { id: 'rec_vetted', fields: { [CARRIER.status]: STATUS.VETTED, [CARRIER.lastContact]: daysAgo(20) } },
    { id: 'rec_dnu', fields: { [CARRIER.status]: STATUS.DO_NOT_USE, [CARRIER.lastContact]: daysAgo(20) } },
    // Contacted with no contact dates at all -> skipped (nothing to measure)
    { id: 'rec_nodate', fields: { [CARRIER.status]: STATUS.CONTACTED } },
  ]);
  assert.deepEqual(stats, { bump1: 0, bump2: 0, declined: 0, packetReminders: 0 });
  assert.equal(mock.getRecords(TABLES.ACTIVITIES).length, 0);
});

test('falls back to Date First Contacted when Last Contact is blank', async () => {
  const { stats } = await run([
    {
      id: 'rec_fc',
      fields: {
        [CARRIER.carrierName]: 'FIRST CONTACT LLC',
        [CARRIER.email]: 'fc@example.com',
        [CARRIER.status]: STATUS.CONTACTED,
        [CARRIER.dateFirstContacted]: daysAgo(4),
      },
    },
  ]);
  assert.equal(stats.bump1, 1);
});

test('dry-run queues nothing to Airtable and changes no statuses', async () => {
  const mock = createMockAirtable({
    tables: { [TABLES.CARRIERS]: [contacted('rec_dry', 16)] },
  });
  const client = createAirtableClient({
    pat: 'pat_test',
    fetchImpl: mock.fetchImpl,
    sleep: noSleep,
    dryRun: true,
  });
  const stats = await runFollowups({
    client,
    state: memoryFollowupState(),
    now: NOW,
    outboxDir: tmpOutbox(),
    printer: quiet,
  });
  assert.equal(stats.declined, 1, 'reported');
  assert.equal(mock.writesFor(TABLES.CARRIERS).length, 0, 'but nothing written');
  assert.equal(mock.getRecords(TABLES.CARRIERS)[0].fields[CARRIER.status], STATUS.CONTACTED);
});
