// Phase 4: npm run followups — the outreach cadence engine. Run daily.
//
//   Contacted + silent  day 3  -> bump draft #1        (approval queue only)
//   Contacted + silent  day 8  -> bump draft #2        (approval queue only)
//   Contacted + silent  day 15 -> Status = Declined    (spec'd downward move)
//   Responded + packet incomplete, day 2 since last contact -> packet reminder
//
// Drafts NEVER send (invariant 2). Already-drafted bumps are remembered in
// .cache/followups.json so re-running the command doesn't duplicate them.
//
// Flags: --dry-run

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv, requireEnv, REPO_ROOT } from '../../lib/config.js';
import { log } from '../../lib/log.js';
import { createAirtableClient, appendNote } from '../airtable-client.js';
import { TABLES, CARRIER, STATUS } from '../schema.js';
import { renderTemplate } from '../packet-assembler.js';
import { queueDraft } from '../approval-queue.js';

export const CADENCE = { BUMP1_DAYS: 3, BUMP2_DAYS: 8, DECLINE_DAYS: 15, PACKET_REMINDER_DAYS: 2 };

export function createFollowupState(path = join(REPO_ROOT, '.cache', 'followups.json')) {
  let data = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      data = {};
    }
  }
  return {
    has: (recordId, kind) => Boolean(data[recordId]?.[kind]),
    mark: (recordId, kind, when) => {
      data[recordId] = { ...data[recordId], [kind]: when };
    },
    save: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(data, null, 2));
    },
  };
}

export const memoryFollowupState = () => {
  const data = {};
  return {
    has: (id, kind) => Boolean(data[id]?.[kind]),
    mark: (id, kind, when) => (data[id] = { ...data[id], [kind]: when }),
    save: () => {},
  };
};

function daysSince(dateValue, now) {
  if (!dateValue) return null;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

function missingPacketItems(fields) {
  const missing = [];
  if (!fields[CARRIER.w9Received]) missing.push('W-9');
  if (!fields[CARRIER.coiReceived]) missing.push('insurance certificate (from your producer)');
  if (!fields[CARRIER.bcaSigned]) missing.push('signed Broker-Carrier Agreement');
  return missing;
}

export async function runFollowups({
  client,
  state = memoryFollowupState(),
  now = new Date(),
  outboxDir,
  printer = log,
}) {
  const carriers = await client.listAll(TABLES.CARRIERS);
  const todayIso = now.toISOString().slice(0, 10);
  const stats = { bump1: 0, bump2: 0, declined: 0, packetReminders: 0 };
  const statusUpdates = [];

  const queueTemplated = async (record, templateName, kind, extraVars = {}) => {
    const f = record.fields;
    const vars = {
      carrierName: f[CARRIER.carrierName] ?? 'your company',
      contactName: f[CARRIER.dispatchContact] || 'there',
      laneHint: f[CARRIER.laneBatch]?.includes('Blytheville')
        ? 'Blytheville, AR ↔ Atlanta, GA'
        : 'our Southeast steel lanes',
      ...extraVars,
    };
    const { subject, body } = renderTemplate(templateName, vars);
    await queueDraft({
      client,
      outboxDir,
      now,
      draft: {
        kind,
        to: f[CARRIER.email] ?? '[carrier email missing]',
        subject,
        body,
        carrierRecordId: record.id,
        carrierName: vars.carrierName,
      },
    });
    state.mark(record.id, kind, todayIso);
  };

  for (const record of carriers) {
    const f = record.fields;
    const status = f[CARRIER.status];

    if (status === STATUS.CONTACTED) {
      const silentDays = daysSince(
        f[CARRIER.lastContact] ?? f[CARRIER.dateFirstContacted],
        now
      );
      if (silentDays === null) continue;

      if (silentDays >= CADENCE.DECLINE_DAYS) {
        // Spec'd cadence end: 15 days of silence closes the file (downward
        // move — invariant 4 allows it).
        statusUpdates.push({
          id: record.id,
          fields: {
            [CARRIER.status]: STATUS.DECLINED,
            [CARRIER.notes]: appendNote(
              f[CARRIER.notes],
              `[${todayIso} followups] No response after ${silentDays} days (bumps at day 3 and 8) — Status set to Declined.`
            ),
          },
        });
        stats.declined += 1;
        printer(`DECLINED (day ${silentDays} silence): ${f[CARRIER.carrierName]}`);
      } else if (silentDays >= CADENCE.BUMP2_DAYS && !state.has(record.id, 'followup-day8')) {
        await queueTemplated(record, 'followup-day8', 'followup-day8');
        stats.bump2 += 1;
      } else if (silentDays >= CADENCE.BUMP1_DAYS && !state.has(record.id, 'followup-day3')) {
        await queueTemplated(record, 'followup-day3', 'followup-day3');
        stats.bump1 += 1;
      }
    }

    if (status === STATUS.RESPONDED) {
      const missing = missingPacketItems(f);
      const sinceContact = daysSince(f[CARRIER.lastContact], now);
      if (
        missing.length > 0 &&
        sinceContact !== null &&
        sinceContact >= CADENCE.PACKET_REMINDER_DAYS &&
        !state.has(record.id, 'packet-reminder-day2')
      ) {
        await queueTemplated(record, 'packet-reminder-day2', 'packet-reminder-day2', {
          missingItems: missing.join(', '),
        });
        stats.packetReminders += 1;
      }
    }
  }

  if (statusUpdates.length > 0) await client.updateRecords(TABLES.CARRIERS, statusUpdates);
  state.save();

  const mode = client.dryRun ? ' (DRY RUN — nothing written)' : '';
  printer(`Follow-up run${mode}: day-3 bumps ${stats.bump1}, day-8 bumps ${stats.bump2}, ` +
    `declined ${stats.declined}, packet reminders ${stats.packetReminders}. ` +
    'All drafts are in outbox/ + Airtable (Email Status = Draft) awaiting review.');
  return stats;
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  loadEnv();
  const { values } = parseArgs({
    options: { 'dry-run': { type: 'boolean', default: false } },
  });
  const { AIRTABLE_PAT } = requireEnv('AIRTABLE_PAT');
  const client = createAirtableClient({ pat: AIRTABLE_PAT, dryRun: values['dry-run'] });
  await runFollowups({
    client,
    state: values['dry-run'] ? memoryFollowupState() : createFollowupState(),
  });
}
