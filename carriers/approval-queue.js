// Invariant 2: NO AUTO-SEND. This module is the only way outbound email
// leaves the system, and all it does is queue drafts for human review:
//   1. an Airtable Activity (Type=Email, Email Status=Draft, Logged By=System)
//      linked to the carrier, and
//   2. a reviewable text file in outbox/ (git-ignored).
// There is deliberately no SMTP/send code anywhere in this repo.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/config.js';
import { TABLES, ACTIVITY, EMAIL_STATUS, LOGGED_BY_SYSTEM } from './schema.js';

const DEFAULT_OUTBOX = join(REPO_ROOT, 'outbox');

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/**
 * Queue one outbound draft for human approval.
 * draft: { kind, to, subject, body, carrierRecordId, carrierName }
 * Returns { outboxPath, activity } (activity null when no carrierRecordId).
 */
export async function queueDraft({
  client,
  draft,
  outboxDir = DEFAULT_OUTBOX,
  now = new Date(),
}) {
  const stamp = now.toISOString().slice(0, 10);
  const fileName = `${stamp}-${slugify(draft.kind)}-${slugify(draft.carrierName ?? draft.to ?? 'draft')}.txt`;
  const outboxPath = join(outboxDir, fileName);
  mkdirSync(outboxDir, { recursive: true });
  writeFileSync(
    outboxPath,
    [
      '*** DRAFT — REVIEW BEFORE SENDING. THE SYSTEM NEVER SENDS EMAIL. ***',
      '',
      `To:      ${draft.to}`,
      `Subject: ${draft.subject}`,
      '',
      draft.body,
      '',
    ].join('\n')
  );

  let activity = null;
  if (client && draft.carrierRecordId) {
    const [created] = await client.createRecords(TABLES.ACTIVITIES, [
      {
        fields: {
          [ACTIVITY.title]: `Draft: ${draft.subject}`,
          [ACTIVITY.activityType]: 'Email',
          [ACTIVITY.dateTime]: now.toISOString(),
          [ACTIVITY.loggedBy]: LOGGED_BY_SYSTEM,
          [ACTIVITY.emailSubject]: draft.subject,
          [ACTIVITY.emailBody]: `To: ${draft.to}\n\n${draft.body}`,
          [ACTIVITY.emailStatus]: EMAIL_STATUS.DRAFT,
          [ACTIVITY.carriers]: [draft.carrierRecordId],
        },
      },
    ]);
    activity = created;
  }
  return { outboxPath, activity };
}
