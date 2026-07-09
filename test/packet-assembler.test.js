import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockAirtable, noSleep } from './helpers/mock-airtable.js';
import { createAirtableClient } from '../carriers/airtable-client.js';
import { queueDraft } from '../carriers/approval-queue.js';
import {
  assemblePacket,
  renderTemplate,
  PRODUCER_EMAIL_PLACEHOLDER,
} from '../carriers/packet-assembler.js';
import { TABLES, CARRIER, ACTIVITY, EMAIL_STATUS, LOGGED_BY_SYSTEM } from '../carriers/schema.js';

const NOW = new Date('2026-07-09T12:00:00Z');
const tmpOutbox = () => mkdtempSync(join(tmpdir(), 'genesis-outbox-'));

function makeClient(mock) {
  return createAirtableClient({ pat: 'pat_test', fetchImpl: mock.fetchImpl, sleep: noSleep });
}

const carrierRecord = (fields = {}) => ({
  id: 'rec_carrier1',
  fields: {
    [CARRIER.carrierName]: 'OZARK STEEL HAULERS LLC',
    [CARRIER.dotNumber]: '1234567',
    [CARRIER.mcNumber]: '987654',
    [CARRIER.email]: 'dispatch@ozarksteel.example',
    [CARRIER.dispatchContact]: 'Randy',
    ...fields,
  },
});

test('invariant 2: queueDraft creates a Draft Activity and an outbox file — nothing is sent', async () => {
  const mock = createMockAirtable();
  const outboxDir = tmpOutbox();
  const { outboxPath, activity } = await queueDraft({
    client: makeClient(mock),
    outboxDir,
    now: NOW,
    draft: {
      kind: 'w9-request',
      to: 'dispatch@ozarksteel.example',
      subject: 'W-9 needed',
      body: 'Please send your W-9.',
      carrierRecordId: 'rec_carrier1',
      carrierName: 'OZARK STEEL HAULERS LLC',
    },
  });

  const file = readFileSync(outboxPath, 'utf8');
  assert.match(file, /\*\*\* DRAFT — REVIEW BEFORE SENDING/);
  assert.match(file, /To: {6}dispatch@ozarksteel\.example/);

  const [act] = mock.getRecords(TABLES.ACTIVITIES);
  assert.equal(act.fields[ACTIVITY.emailStatus], EMAIL_STATUS.DRAFT);
  assert.equal(act.fields[ACTIVITY.loggedBy], LOGGED_BY_SYSTEM);
  assert.equal(act.fields[ACTIVITY.activityType], 'Email');
  assert.deepEqual(act.fields[ACTIVITY.carriers], ['rec_carrier1']);
  assert.equal(activity.id, act.id);
});

test('renderTemplate substitutes variables and throws on missing ones', () => {
  const { subject, body } = renderTemplate('w9-request', {
    carrierName: 'OZARK STEEL HAULERS LLC',
    contactName: 'Randy',
    dotNumber: '1234567',
  });
  assert.match(subject, /W-9 needed to set you up — OZARK STEEL HAULERS LLC/);
  assert.match(body, /Hi Randy,/);
  assert.match(body, /DOT 1234567/);
  assert.ok(!body.includes('{{'));
  assert.throws(() => renderTemplate('w9-request', { contactName: 'x' }), /missing variable/);
});

test('assemblePacket queues one draft per missing item (all three when packet is empty)', async () => {
  const mock = createMockAirtable();
  const outboxDir = tmpOutbox();
  const queued = await assemblePacket({
    client: makeClient(mock),
    record: carrierRecord(),
    now: NOW,
    outboxDir,
  });
  assert.deepEqual(
    queued.map((q) => q.kind),
    ['w9-request', 'bca-cover', 'coi-producer-request']
  );
  assert.equal(readdirSync(outboxDir).length, 3);
  assert.equal(mock.getRecords(TABLES.ACTIVITIES).length, 3);
});

test('assemblePacket skips items already on file; complete packet queues nothing', async () => {
  const mock = createMockAirtable();
  const partial = await assemblePacket({
    client: makeClient(mock),
    record: carrierRecord({ [CARRIER.w9Received]: true, [CARRIER.coiReceived]: true }),
    now: NOW,
    outboxDir: tmpOutbox(),
  });
  assert.deepEqual(partial.map((q) => q.kind), ['bca-cover']);

  const complete = await assemblePacket({
    client: makeClient(createMockAirtable()),
    record: carrierRecord({
      [CARRIER.w9Received]: true,
      [CARRIER.coiReceived]: true,
      [CARRIER.bcaSigned]: true,
    }),
    now: NOW,
    outboxDir: tmpOutbox(),
  });
  assert.equal(complete.length, 0);
});

test('SOP: the COI request is addressed to the producer, never the carrier', async () => {
  const mock = createMockAirtable();
  const queued = await assemblePacket({
    client: makeClient(mock),
    record: carrierRecord({ [CARRIER.w9Received]: true, [CARRIER.bcaSigned]: true }),
    now: NOW,
    outboxDir: tmpOutbox(),
  });
  assert.equal(queued.length, 1);
  const coi = queued[0];
  assert.equal(coi.kind, 'coi-producer-request');
  assert.equal(coi.to, PRODUCER_EMAIL_PLACEHOLDER);
  assert.notEqual(coi.to, 'dispatch@ozarksteel.example');
  const file = readFileSync(coi.outboxPath, 'utf8');
  assert.match(file, /exclusion for METAL COILS/);
  assert.match(file, /sent directly from\nthe producer/);
});
