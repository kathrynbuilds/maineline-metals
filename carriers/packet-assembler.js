// Phase 3: carrier packet assembler. Renders the W-9 request, BCA cover, and
// producer-direct COI request from packet-templates/ into the approval queue
// (invariant 2: drafts only, never sent).
//
// Per the vetting SOP the COI request is addressed to the INSURANCE PRODUCER,
// never the carrier — a carrier-supplied certificate is a fraud vector.
//
// CLI: node carriers/packet-assembler.js <DOT>

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, requireEnv } from '../lib/config.js';
import { log } from '../lib/log.js';
import { createAirtableClient } from './airtable-client.js';
import { queueDraft } from './approval-queue.js';
import { CARRIER } from './schema.js';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'packet-templates');

export const PRODUCER_EMAIL_PLACEHOLDER =
  '[INSURANCE PRODUCER EMAIL — take it from the carrier’s dec page or ask for the agency, never accept a cert from the carrier]';

export function renderTemplate(name, vars) {
  const raw = readFileSync(join(TEMPLATE_DIR, `${name}.txt`), 'utf8');
  const rendered = raw.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars) || vars[key] === undefined || vars[key] === null) {
      throw new Error(`Template ${name} is missing variable "${key}"`);
    }
    return String(vars[key]);
  });
  const [subjectLine, ...rest] = rendered.split('\n');
  const subject = subjectLine.replace(/^Subject:\s*/i, '').trim();
  return { subject, body: rest.join('\n').trim() };
}

/**
 * Queue the missing-packet-item drafts for one carrier record.
 * Returns the drafts queued (possibly empty when the packet is complete).
 */
export async function assemblePacket({ client, record, now = new Date(), outboxDir }) {
  const f = record.fields;
  const vars = {
    carrierName: f[CARRIER.carrierName] ?? 'your company',
    contactName: f[CARRIER.dispatchContact] || 'there',
    dotNumber: f[CARRIER.dotNumber] ?? 'N/A',
    mcNumber: f[CARRIER.mcNumber] ?? 'N/A',
    paymentTerms: f[CARRIER.paymentPreference] || 'standard',
  };
  const carrierEmail = f[CARRIER.email];
  const queued = [];

  const queue = async (kind, templateName, to) => {
    const { subject, body } = renderTemplate(templateName, vars);
    const result = await queueDraft({
      client,
      outboxDir,
      now,
      draft: {
        kind,
        to,
        subject,
        body,
        carrierRecordId: record.id,
        carrierName: vars.carrierName,
      },
    });
    queued.push({ kind, to, subject, ...result });
  };

  if (!f[CARRIER.w9Received]) {
    await queue('w9-request', 'w9-request', carrierEmail ?? '[carrier email missing]');
  }
  if (!f[CARRIER.bcaSigned]) {
    await queue('bca-cover', 'bca-cover', carrierEmail ?? '[carrier email missing]');
  }
  if (!f[CARRIER.coiReceived]) {
    // SOP: producer-direct, NEVER the carrier's own email.
    await queue('coi-producer-request', 'coi-producer-request', PRODUCER_EMAIL_PLACEHOLDER);
  }
  return queued;
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  loadEnv();
  const dot = process.argv[2];
  if (!dot) {
    console.error('Usage: node carriers/packet-assembler.js <DOT number>');
    process.exit(1);
  }
  const { AIRTABLE_PAT } = requireEnv('AIRTABLE_PAT');
  const client = createAirtableClient({ pat: AIRTABLE_PAT });
  const { fetchCarrierByDot } = await import('../tms/rate-confirmation.js');
  const record = await fetchCarrierByDot(client, dot);
  if (!record) {
    console.error(`No carrier with DOT ${dot}.`);
    process.exit(1);
  }
  const queued = await assemblePacket({ client, record });
  if (queued.length === 0) {
    log('Packet already complete — nothing to request.');
  } else {
    for (const q of queued) log(`Queued ${q.kind} draft -> ${q.outboxPath}`);
    log('Review the drafts in outbox/ and the Draft Activities in Airtable before sending.');
  }
}
