// Rate confirmation generator — the dispatch gate lives at the FRONT of this
// path (invariant 1): no gate pass, no rate con, no exceptions.
//
// Airtable stays canonical: the carrier record is fetched live at generation
// time (read-through), so a demotion by verify-carriers takes effect
// immediately.
//
// CLI: node tms/rate-confirmation.js <loadId>
//   Writes data/rate-cons/RC-<loadId>.txt on success; exits 1 with the full
//   punch list if the gate blocks.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv, REPO_ROOT } from '../lib/config.js';
import { log } from '../lib/log.js';
import { createAirtableClient } from '../carriers/airtable-client.js';
import { resolveAuthorityFields } from '../carriers/verify-authority.js';
import { normalizeDot } from '../carriers/filter-carrier-census.js';
import { assertDispatchable, carrierRecordToView } from '../carriers/dispatch-gate.js';
import { TABLES, CARRIER } from '../carriers/schema.js';
import { createLoadStore } from './loads.js';

export const BROKER = {
  name: 'Genesis Logistics Group, LLC',
  mc: 'MC-48921257',
  usdot: 'USDOT 7336402',
  location: 'Georgia',
};

/**
 * Generate the rate confirmation text. Throws (with every gate failure
 * listed) if the carrier is not dispatchable — this is the hard fail.
 */
export function generateRateCon({ load, carrier, now = new Date() }) {
  assertDispatchable(carrier, { now });

  const line = '='.repeat(70);
  const fmtMoney = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  return [
    line,
    'RATE CONFIRMATION',
    `${BROKER.name}  |  ${BROKER.mc}  |  ${BROKER.usdot}`,
    line,
    '',
    `Load ID:          ${load.id}`,
    `Date:             ${now.toISOString().slice(0, 10)}`,
    '',
    'CARRIER',
    `  Name:           ${carrier.carrierName}${carrier.dba ? ` (DBA ${carrier.dba})` : ''}`,
    `  MC / DOT:       MC-${carrier.mcNumber ?? 'N/A'} / DOT ${carrier.dotNumber}`,
    `  Dispatch:       ${carrier.dispatchContact ?? 'N/A'}  ${carrier.phone ?? ''}  ${carrier.email ?? ''}`,
    `  Authority:      verified ${carrier.authorityVerifiedDate} (FMCSA QCMobile)`,
    '',
    'SHIPMENT',
    `  Origin:         ${load.origin}`,
    `  Destination:    ${load.destination}`,
    `  Commodity:      ${load.commodity}`,
    `  Weight:         ${load.weightLbs ? `${load.weightLbs.toLocaleString('en-US')} lbs` : 'TBD'}`,
    `  Pickup:         ${load.pickupDate ?? 'TBD'}`,
    `  Delivery:       ${load.deliveryDate ?? 'TBD'}`,
    '',
    'RATE',
    `  All-in:         ${fmtMoney(load.rate)}`,
    '',
    'TERMS',
    '  - Coil securement per Genesis SOP: racks/cradles required for coils,',
    '    eye-to-the-side unless otherwise instructed; chains + tarps as specified.',
    '  - Driver must present photo ID at pickup matching dispatch info.',
    '  - This confirmation is not valid unless returned signed.',
    '',
    `Notes: ${load.notes || '—'}`,
    line,
  ].join('\n');
}

/** Fetch the live carrier record by DOT (read-through; Airtable canonical). */
export async function fetchCarrierByDot(client, dot) {
  const wanted = normalizeDot(dot);
  const records = await client.listAll(TABLES.CARRIERS);
  return records.find((r) => normalizeDot(r.fields[CARRIER.dotNumber]) === wanted) ?? null;
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  loadEnv();
  const loadId = process.argv[2];
  if (!loadId) {
    console.error('Usage: node tms/rate-confirmation.js <loadId>');
    process.exit(1);
  }
  const store = createLoadStore();
  const load = store.get(loadId);
  if (!load) {
    console.error(`No load ${loadId}. Create one with tms/loads.js first.`);
    process.exit(1);
  }
  const { AIRTABLE_PAT } = requireEnv('AIRTABLE_PAT');
  const client = createAirtableClient({ pat: AIRTABLE_PAT });
  const fieldIds = await resolveAuthorityFields(client);
  const record = await fetchCarrierByDot(client, load.carrierDot);
  if (!record) {
    console.error(`No carrier with DOT ${load.carrierDot} in the Carriers table.`);
    process.exit(1);
  }
  const carrier = carrierRecordToView(record.fields, fieldIds);
  try {
    const text = generateRateCon({ load, carrier });
    const dir = join(REPO_ROOT, 'data', 'rate-cons');
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, `RC-${load.id}.txt`);
    writeFileSync(outPath, text);
    log(`Rate confirmation written to ${outPath}`);
    console.log(text);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
