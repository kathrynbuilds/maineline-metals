// Phase 4: npm run intake
//
// Consumes raw RFC-822 messages from the drop directory (inbox-drop/), which
// the IMAP poller or webhook receiver fills. For each message:
//   1. match the sender to a Carriers record (Email, then MC/DOT in the body;
//      no match -> unmatched/ for human review, never guessed)
//   2. classify + extract via the Claude API
//   3. blank-fill-only upsert of extracted answers (invariant 3)
//   4. Contacted -> Responded (the only upward-looking transition, and it
//      fires because a reply actually arrived; out-of-office doesn't count)
//   5. log an Activity with the raw email body, linked to the carrier
//   6. flag rules: coil-exclusion task at Responded+, factoring mismatch ->
//      fraud-review task
//
// Flags: --dry-run  --drop-dir <path>

import { readdirSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv, requireEnv, REPO_ROOT } from '../../lib/config.js';
import { log, warn } from '../../lib/log.js';
import {
  createAirtableClient,
  diffBlankFillOnly,
  formatConflictNote,
  appendNote,
  isBlank,
} from '../airtable-client.js';
import {
  TABLES,
  CARRIER,
  TASK,
  ACTIVITY,
  STATUS,
  STATUS_ORDER,
  COIL_EXCLUSION,
} from '../schema.js';
import { normalizeDot } from '../filter-carrier-census.js';
import { parseMessage } from './mime.js';
import { createClaudeClient } from './claude-client.js';

export const DROP_DIR = join(REPO_ROOT, 'inbox-drop');

const EXTRACT_LABELS = {
  [CARRIER.trailerTypes]: 'Trailer Types',
  [CARRIER.coilRacks]: 'Coil Racks',
  [CARRIER.tarpSizes]: 'Tarp Sizes',
  [CARRIER.securement]: 'Securement Per Truck',
  [CARRIER.coil48k]: '48K Coil Capable',
  [CARRIER.cargoLimit]: 'Cargo Insurance Limit',
  [CARRIER.newMcAcceptance]: 'New MC Acceptance',
  [CARRIER.paymentPreference]: 'Payment Preference',
  [CARRIER.factoringCompany]: 'Factoring Company',
  [CARRIER.rateRange]: 'Rate Range (Target Lane)',
  [CARRIER.coreLanes]: 'Core Lanes',
  [CARRIER.trucksPerWeek]: 'Trucks Available Per Week',
};

/** Extracted JSON -> Airtable field payload. "Unknown"/empty answers are dropped. */
export function extractedToFields(extracted) {
  const skipUnknown = (v) => (v === 'Unknown' ? undefined : v);
  const fields = {
    [CARRIER.trailerTypes]: extracted.trailer_types,
    [CARRIER.coilRacks]: skipUnknown(extracted.coil_racks),
    [CARRIER.tarpSizes]: extracted.tarp_sizes,
    [CARRIER.securement]: extracted.securement_per_truck,
    [CARRIER.coil48k]: skipUnknown(extracted.capable_48k_coils),
    [CARRIER.cargoLimit]: extracted.cargo_insurance_limit_usd,
    [CARRIER.newMcAcceptance]: extracted.new_mc_acceptance,
    [CARRIER.paymentPreference]: extracted.payment_preference,
    [CARRIER.factoringCompany]: extracted.factoring_company,
    [CARRIER.rateRange]: extracted.rate_range,
    [CARRIER.coreLanes]: extracted.core_lanes,
    [CARRIER.trucksPerWeek]: extracted.trucks_available_per_week,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (isBlank(v) || v === undefined) delete fields[k];
  }
  return fields;
}

/** Match a parsed email to a carrier record: sender email first, then MC/DOT in the body. */
export function matchCarrier(records, message) {
  const sender = message.from.address;
  if (sender) {
    const byEmail = records.find(
      (r) => String(r.fields[CARRIER.email] ?? '').trim().toLowerCase() === sender
    );
    if (byEmail) return { record: byEmail, matchedBy: 'email' };
  }
  const text = `${message.subject}\n${message.text}`;
  const dotMatch = text.match(/\b(?:USDOT|DOT)\s*#?\s*:?\s*(\d{5,8})\b/i);
  if (dotMatch) {
    const dot = normalizeDot(dotMatch[1]);
    const byDot = records.find((r) => normalizeDot(r.fields[CARRIER.dotNumber]) === dot);
    if (byDot) return { record: byDot, matchedBy: 'dot' };
  }
  const mcMatch = text.match(/\bMC\s*#?\s*:?\s*(\d{5,8})\b/i);
  if (mcMatch) {
    const mc = mcMatch[1].replace(/^0+/, '');
    const byMc = records.find(
      (r) => String(r.fields[CARRIER.mcNumber] ?? '').replace(/\D/g, '').replace(/^0+/, '') === mc
    );
    if (byMc) return { record: byMc, matchedBy: 'mc' };
  }
  return { record: null, matchedBy: null };
}

async function taskExists(client, title) {
  const tasks = await client.listAll(TABLES.TASKS, { fields: [TASK.title, TASK.status] });
  return tasks.some((t) => t.fields[TASK.title] === title && t.fields[TASK.status] !== 'Completed');
}

async function createTask(client, { title, instructions, priority = 'Normal', dueDate }) {
  if (await taskExists(client, title)) return null;
  const [task] = await client.createRecords(TABLES.TASKS, [
    {
      fields: {
        [TASK.title]: title,
        [TASK.taskType]: 'Other',
        [TASK.priority]: priority,
        [TASK.status]: 'Pending',
        [TASK.instructions]: instructions,
        [TASK.autoCreated]: true,
        ...(dueDate ? { [TASK.dueDate]: dueDate } : {}),
      },
    },
  ]);
  return task;
}

/**
 * Apply one classified reply to the CRM. Exported for tests.
 * Returns { patch, classification, tasksCreated: string[] }.
 */
export async function applyReplyToCrm({
  client,
  record,
  message,
  analysis, // { classification, summary, extracted }
  now = new Date(),
}) {
  const { classification, summary, extracted } = analysis;
  const f = record.fields;
  const carrierName = f[CARRIER.carrierName] ?? '(unnamed carrier)';
  const todayIso = now.toISOString().slice(0, 10);
  const tasksCreated = [];

  const patch = {};
  const isRealReply = classification !== 'out_of_office';

  if (isRealReply) {
    const { patch: fillPatch, conflicts } = diffBlankFillOnly(
      f,
      extractedToFields(extracted),
      EXTRACT_LABELS
    );
    Object.assign(patch, fillPatch);
    if (conflicts.length > 0) {
      patch[CARRIER.notes] = appendNote(
        f[CARRIER.notes],
        formatConflictNote('email-intake', conflicts, now)
      );
    }

    // The one upward transition automation may make — an actual reply arrived.
    if (f[CARRIER.status] === STATUS.CONTACTED) {
      patch[CARRIER.status] = STATUS.RESPONDED;
    }
    patch[CARRIER.lastContact] = todayIso;

    // Fraud cross-check per vetting SOP: stated factoring company conflicts
    // with what we already have on file.
    const factoringConflict = conflicts.find((c) => c.fieldId === CARRIER.factoringCompany);
    if (factoringConflict) {
      const title = `Fraud review: factoring mismatch — ${carrierName}`;
      const task = await createTask(client, {
        title,
        priority: 'Urgent',
        instructions:
          `Stated factoring company "${factoringConflict.incoming}" conflicts with the value ` +
          `on file "${factoringConflict.existing}". Cross-check against FMCSA contact data and ` +
          'the vetting SOP before any dispatch. Source email logged as an Activity.',
      });
      if (task) tasksCreated.push(title);
    }
  }

  // Activity log with the raw email (always, even for out-of-office).
  await client.createRecords(TABLES.ACTIVITIES, [
    {
      fields: {
        [ACTIVITY.title]: `Carrier reply (${classification}): ${message.subject}`,
        [ACTIVITY.activityType]: 'Email',
        [ACTIVITY.dateTime]: now.toISOString(),
        [ACTIVITY.loggedBy]: 'AI',
        [ACTIVITY.aiSummary]: summary,
        [ACTIVITY.keyDetails]: JSON.stringify(extracted, null, 2),
        [ACTIVITY.emailSubject]: message.subject,
        [ACTIVITY.emailBody]: message.text,
        [ACTIVITY.carriers]: [record.id],
      },
    },
  ]);

  if (Object.keys(patch).length > 0) {
    await client.updateRecords(TABLES.CARRIERS, [{ id: record.id, fields: patch }], {
      typecast: true, // free-form tarp sizes etc. map onto select choices
    });
  }

  // Flag rule: Responded or beyond with coil exclusion still unverified.
  const effectiveStatus = patch[CARRIER.status] ?? f[CARRIER.status];
  const coilStatus = f[CARRIER.coilExclusion] ?? COIL_EXCLUSION.NOT_VERIFIED;
  const respondedOrBeyond =
    STATUS_ORDER.indexOf(effectiveStatus) >= STATUS_ORDER.indexOf(STATUS.RESPONDED);
  if (respondedOrBeyond && coilStatus === COIL_EXCLUSION.NOT_VERIFIED) {
    const title = `Confirm coil exclusion with producer — ${carrierName}`;
    const task = await createTask(client, {
      title,
      priority: 'Urgent',
      dueDate: todayIso,
      instructions:
        'Get written confirmation FROM THE INSURANCE PRODUCER (not the carrier) that the ' +
        'cargo policy does not exclude metal coils. The dispatch gate blocks this carrier ' +
        'until Coil Exclusion Status = "Confirmed No Exclusion".',
    });
    if (task) tasksCreated.push(title);
  }

  return { patch, classification, tasksCreated };
}

/** Process every .eml in dropDir. Returns per-message results. */
export async function processInbox({
  client,
  claude,
  dropDir = DROP_DIR,
  now = new Date(),
  printer = log,
}) {
  const processedDir = join(dropDir, 'processed');
  const unmatchedDir = join(dropDir, 'unmatched');
  mkdirSync(processedDir, { recursive: true });
  mkdirSync(unmatchedDir, { recursive: true });

  const files = readdirSync(dropDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.eml$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) {
    printer('Inbox drop directory is empty — nothing to process.');
    return [];
  }

  const carriers = await client.listAll(TABLES.CARRIERS);
  const results = [];

  for (const file of files) {
    const path = join(dropDir, file);
    const message = parseMessage(readFileSync(path));
    const { record, matchedBy } = matchCarrier(carriers, message);
    if (!record) {
      warn(`No carrier match for "${message.from.address ?? '?'}" (${file}) — moved to unmatched/ for review.`);
      if (!client.dryRun) renameSync(path, join(unmatchedDir, basename(file)));
      results.push({ file, matched: false });
      continue;
    }
    const analysis = await claude.classifyAndExtract({
      from: message.from.address,
      subject: message.subject,
      text: message.text,
    });
    const outcome = await applyReplyToCrm({ client, record, message, analysis, now });
    printer(
      `${file}: ${record.fields[CARRIER.carrierName]} (matched by ${matchedBy}) -> ` +
        `${analysis.classification}; ${Object.keys(outcome.patch).length} field(s) updated` +
        (outcome.tasksCreated.length ? `; tasks: ${outcome.tasksCreated.join(' | ')}` : '')
    );
    if (!client.dryRun) renameSync(path, join(processedDir, basename(file)));
    results.push({ file, matched: true, matchedBy, ...outcome });
  }
  return results;
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'drop-dir': { type: 'string' },
    },
  });
  const { AIRTABLE_PAT, ANTHROPIC_API_KEY } = requireEnv('AIRTABLE_PAT', 'ANTHROPIC_API_KEY');
  const client = createAirtableClient({ pat: AIRTABLE_PAT, dryRun: values['dry-run'] });
  const claude = createClaudeClient({ apiKey: ANTHROPIC_API_KEY });
  await processInbox({ client, claude, dropDir: values['drop-dir'] ?? DROP_DIR });
}
