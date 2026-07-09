// Phase 4 acceptance: the five realistic reply fixtures produce the correct
// CRM effects against the mocked Airtable client, with the Claude analysis
// layer mocked per-message (deterministic — no live API in tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockAirtable, noSleep } from './helpers/mock-airtable.js';
import { createAirtableClient } from '../carriers/airtable-client.js';
import { processInbox, matchCarrier, extractedToFields } from '../carriers/email-intake/intake.js';
import { parseMessage } from '../carriers/email-intake/mime.js';
import { readFileSync } from 'node:fs';
import {
  TABLES,
  CARRIER,
  TASK,
  ACTIVITY,
  STATUS,
  COIL_EXCLUSION,
} from '../carriers/schema.js';

const REPLIES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replies');
const NOW = new Date('2026-07-09T12:00:00Z');
const quiet = () => {};

// Deterministic stand-in for the Claude API keyed by sender.
const ANALYSES = {
  'dispatch@ozarksteel.example': {
    classification: 'interested',
    summary: 'Enthusiastic yes; 4-5 trucks/week Blytheville-Atlanta; full equipment details given.',
    extracted: {
      trailer_types: ["Flatbed 48'"],
      coil_racks: 'Yes',
      tarp_sizes: ["4' drop", 'steel tarps'],
      securement_per_truck: '8 chains',
      capable_48k_coils: 'Yes',
      cargo_insurance_limit_usd: 250000,
      new_mc_acceptance: 'Yes',
      payment_preference: 'Quick Pay',
      factoring_company: 'TriumphPay Factoring',
      rate_range: '$2.50-2.90/mi Blytheville-Atlanta',
      trucks_available_per_week: 4,
    },
  },
  'psfdispatch@psf.example': {
    classification: 'interested',
    summary: 'Terse yes with a rate: $2.60/mi Blytheville-Atlanta. Asked for setup packet.',
    extracted: { rate_range: '$2.60/mi Blytheville-Atlanta' },
  },
  'gcm@gulfcoast.example': {
    classification: 'declined',
    summary: 'Declined: will not onboard with an MC younger than one year. Revisit next summer.',
    extracted: { new_mc_acceptance: 'No' },
  },
  'office.deltacoil@gmail.example': {
    classification: 'questions',
    summary: 'Questions about load type, detention policy, and quick pay fee before committing.',
    extracted: {},
  },
  'dispatch@bigriver.example': {
    classification: 'out_of_office',
    summary: 'Automatic out-of-office reply until July 13.',
    extracted: {},
  },
};

const fakeClaude = {
  async classifyAndExtract({ from }) {
    const a = ANALYSES[from];
    if (!a) throw new Error(`no canned analysis for ${from}`);
    return a;
  },
};

function seedCarriers() {
  return [
    {
      id: 'rec_ozark',
      fields: {
        [CARRIER.carrierName]: 'OZARK STEEL HAULERS LLC',
        [CARRIER.dotNumber]: '1234567',
        [CARRIER.mcNumber]: '987654',
        [CARRIER.email]: 'dispatch@ozarksteel.example',
        [CARRIER.status]: STATUS.CONTACTED,
        [CARRIER.coilExclusion]: COIL_EXCLUSION.NOT_VERIFIED,
        [CARRIER.trailerTypes]: ["Flatbed 48'", 'Step Deck'], // human-entered
        [CARRIER.factoringCompany]: 'Apex Capital', // conflicts with reply
      },
    },
    {
      id: 'rec_psf',
      fields: {
        [CARRIER.carrierName]: 'PEACH STATE FLATBED, INC.',
        [CARRIER.dotNumber]: '2345678',
        [CARRIER.email]: 'psfdispatch@psf.example',
        [CARRIER.status]: STATUS.CONTACTED,
        [CARRIER.coilExclusion]: COIL_EXCLUSION.NOT_VERIFIED,
      },
    },
    {
      id: 'rec_gcm',
      fields: {
        [CARRIER.carrierName]: 'GULF COAST METALS LLC',
        [CARRIER.dotNumber]: '4567890',
        [CARRIER.email]: 'gcm@gulfcoast.example',
        [CARRIER.status]: STATUS.CONTACTED,
      },
    },
    {
      id: 'rec_delta',
      // note: sender uses a personal gmail; matching must fall back to the
      // DOT number in the body
      fields: {
        [CARRIER.carrierName]: 'DELTA COIL EXPRESS',
        [CARRIER.dotNumber]: '7890123',
        [CARRIER.email]: 'delta@example.com',
        [CARRIER.status]: STATUS.CONTACTED,
      },
    },
    {
      id: 'rec_bigriver',
      fields: {
        [CARRIER.carrierName]: 'BIG RIVER TRANSPORT',
        [CARRIER.dotNumber]: '3456789',
        [CARRIER.email]: 'dispatch@bigriver.example',
        [CARRIER.status]: STATUS.CONTACTED,
      },
    },
  ];
}

function setupDropDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'genesis-drop-'));
  for (const f of files) copyFileSync(join(REPLIES, f), join(dir, f));
  return dir;
}

async function runIntake({ files, tables }) {
  const mock = createMockAirtable({ tables });
  const client = createAirtableClient({ pat: 'pat_test', fetchImpl: mock.fetchImpl, sleep: noSleep });
  const dropDir = setupDropDir(files);
  const results = await processInbox({
    client,
    claude: fakeClaude,
    dropDir,
    now: NOW,
    printer: quiet,
  });
  return { mock, results, dropDir };
}

const ALL_FIXTURES = [
  'reply-enthusiastic-yes.eml',
  'reply-terse-yes-rate.eml',
  'reply-decline-new-mc.eml',
  'reply-question-only.eml',
  'reply-out-of-office.eml',
];

test('acceptance: all five reply fixtures produce correct field updates', async () => {
  const { mock, results } = await runIntake({
    files: ALL_FIXTURES,
    tables: { [TABLES.CARRIERS]: seedCarriers() },
  });
  assert.equal(results.filter((r) => r.matched).length, 5);
  const rec = (id) => mock.getRecords(TABLES.CARRIERS).find((r) => r.id === id);

  // 1. enthusiastic yes: blanks filled, human data kept, status advanced
  const ozark = rec('rec_ozark');
  assert.equal(ozark.fields[CARRIER.status], STATUS.RESPONDED);
  assert.equal(ozark.fields[CARRIER.coilRacks], 'Yes');
  assert.equal(ozark.fields[CARRIER.cargoLimit], 250000);
  assert.equal(ozark.fields[CARRIER.trucksPerWeek], 4);
  assert.equal(ozark.fields[CARRIER.rateRange], '$2.50-2.90/mi Blytheville-Atlanta');
  assert.deepEqual(
    ozark.fields[CARRIER.trailerTypes],
    ["Flatbed 48'", 'Step Deck'],
    'human-entered trailer list not overwritten'
  );
  assert.equal(
    ozark.fields[CARRIER.factoringCompany],
    'Apex Capital',
    'conflicting factoring answer never overwrites'
  );
  assert.match(ozark.fields[CARRIER.notes], /Conflict on Factoring Company/);
  assert.equal(ozark.fields[CARRIER.lastContact], '2026-07-09');

  // 2. terse yes: rate range recorded, status advanced
  const psf = rec('rec_psf');
  assert.equal(psf.fields[CARRIER.status], STATUS.RESPONDED);
  assert.equal(psf.fields[CARRIER.rateRange], '$2.60/mi Blytheville-Atlanta');

  // 3. decline: New MC Acceptance = No recorded; still advances to Responded
  //    (they replied; the decline itself is a human judgement to log)
  const gcm = rec('rec_gcm');
  assert.equal(gcm.fields[CARRIER.newMcAcceptance], 'No');
  assert.equal(gcm.fields[CARRIER.status], STATUS.RESPONDED);

  // 4. question-only: matched via DOT in body despite personal gmail sender
  const delta = rec('rec_delta');
  assert.equal(delta.fields[CARRIER.status], STATUS.RESPONDED);
  const deltaResult = results.find((r) => r.file === 'reply-question-only.eml');
  assert.equal(deltaResult.matchedBy, 'dot');

  // 5. out-of-office: NOT a real reply — no status change, no field fills
  const bigriver = rec('rec_bigriver');
  assert.equal(bigriver.fields[CARRIER.status], STATUS.CONTACTED);
  assert.equal(bigriver.fields[CARRIER.lastContact], undefined);

  // every message logged as an Activity linked to its carrier, raw body kept
  const activities = mock.getRecords(TABLES.ACTIVITIES);
  assert.equal(activities.length, 5);
  const ozarkActivity = activities.find(
    (a) => a.fields[ACTIVITY.carriers]?.[0] === 'rec_ozark'
  );
  assert.match(ozarkActivity.fields[ACTIVITY.emailBody], /right in our wheelhouse/);
  assert.equal(ozarkActivity.fields[ACTIVITY.loggedBy], 'AI');
});

test('flag rule: Responded + coil exclusion Not Verified creates the producer task', async () => {
  const { mock } = await runIntake({
    files: ['reply-enthusiastic-yes.eml'],
    tables: { [TABLES.CARRIERS]: seedCarriers() },
  });
  const tasks = mock.getRecords(TABLES.TASKS);
  const coilTask = tasks.find((t) =>
    t.fields[TASK.title].startsWith('Confirm coil exclusion with producer')
  );
  assert.ok(coilTask, 'coil exclusion task created');
  assert.match(coilTask.fields[TASK.title], /OZARK STEEL HAULERS LLC/);
  assert.equal(coilTask.fields[TASK.autoCreated], true);
  assert.match(coilTask.fields[TASK.instructions], /FROM THE INSURANCE PRODUCER/);
});

test('fraud rule: conflicting factoring company creates an urgent fraud-review task', async () => {
  const { mock } = await runIntake({
    files: ['reply-enthusiastic-yes.eml'],
    tables: { [TABLES.CARRIERS]: seedCarriers() },
  });
  const fraud = mock
    .getRecords(TABLES.TASKS)
    .find((t) => t.fields[TASK.title].startsWith('Fraud review: factoring mismatch'));
  assert.ok(fraud, 'fraud task created');
  assert.equal(fraud.fields[TASK.priority], 'Urgent');
  assert.match(fraud.fields[TASK.instructions], /TriumphPay Factoring/);
  assert.match(fraud.fields[TASK.instructions], /Apex Capital/);
});

test('tasks are not duplicated when the same reply is processed twice', async () => {
  const tables = { [TABLES.CARRIERS]: seedCarriers() };
  const mock = createMockAirtable({ tables });
  const client = createAirtableClient({ pat: 'pat_test', fetchImpl: mock.fetchImpl, sleep: noSleep });
  for (const round of [1, 2]) {
    const dropDir = setupDropDir(['reply-enthusiastic-yes.eml']);
    await processInbox({ client, claude: fakeClaude, dropDir, now: NOW, printer: quiet });
  }
  const coilTasks = mock
    .getRecords(TABLES.TASKS)
    .filter((t) => t.fields[TASK.title].startsWith('Confirm coil exclusion'));
  assert.equal(coilTasks.length, 1);
});

test('unmatched senders are quarantined for human review — never guessed', async () => {
  const { mock, results, dropDir } = await runIntake({
    files: ['reply-unmatched.eml'],
    tables: { [TABLES.CARRIERS]: seedCarriers() },
  });
  assert.equal(results[0].matched, false);
  assert.equal(mock.writesFor(TABLES.CARRIERS).length, 0);
  assert.equal(mock.getRecords(TABLES.ACTIVITIES).length, 0);
  assert.deepEqual(readdirSync(join(dropDir, 'unmatched')), ['reply-unmatched.eml']);
});

test('a carrier already at Vetted is not moved by a reply (only Contacted -> Responded)', async () => {
  const carriers = seedCarriers();
  carriers[0].fields[CARRIER.status] = STATUS.VETTED;
  const { mock } = await runIntake({
    files: ['reply-enthusiastic-yes.eml'],
    tables: { [TABLES.CARRIERS]: carriers },
  });
  const ozark = mock.getRecords(TABLES.CARRIERS).find((r) => r.id === 'rec_ozark');
  assert.equal(ozark.fields[CARRIER.status], STATUS.VETTED);
});

test('extractedToFields drops Unknown/empty answers', () => {
  const fields = extractedToFields({
    coil_racks: 'Unknown',
    capable_48k_coils: 'Yes',
    tarp_sizes: [],
    rate_range: '',
    trucks_available_per_week: 3,
  });
  assert.deepEqual(fields, {
    [CARRIER.coil48k]: 'Yes',
    [CARRIER.trucksPerWeek]: 3,
  });
});

test('matchCarrier falls back from email to DOT to MC', () => {
  const records = seedCarriers();
  const byEmail = matchCarrier(records, parseMessage(readFileSync(join(REPLIES, 'reply-terse-yes-rate.eml'))));
  assert.equal(byEmail.matchedBy, 'email');
  const byDot = matchCarrier(records, parseMessage(readFileSync(join(REPLIES, 'reply-question-only.eml'))));
  assert.equal(byDot.matchedBy, 'dot');
  assert.equal(byDot.record.id, 'rec_delta');
  const mcMessage = {
    from: { address: 'random@example.com' },
    subject: 'our MC# 987654',
    text: 'checking in',
  };
  assert.equal(matchCarrier(records, mcMessage).matchedBy, 'mc');
});
