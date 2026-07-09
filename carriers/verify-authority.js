// Phase 2: npm run verify-carriers
//
// SAFER-grade authority verification against the FMCSA QCMobile API for every
// carrier still in the pipeline (Researched → Active). Writes Authority
// Status / Authority Verified Date / OOS Flag and — the ONLY automated status
// change in the system, and it only ever moves carriers DOWN (invariant 4) —
// demotes inactive/OOS carriers to Do Not Use with a timestamped Notes entry.
//
// The three authority fields are resolved BY NAME via the Meta API because
// they are provisioned per-base (run once with --provision to create them).
//
// Flags: --dry-run  --force (ignore 30-day freshness)  --limit N  --provision

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnv, requireEnv, REPO_ROOT } from '../lib/config.js';
import { log, warn } from '../lib/log.js';
import { createHttp } from '../lib/http.js';
import { createAirtableClient, appendNote } from './airtable-client.js';
import { normalizeDot } from './filter-carrier-census.js';
import {
  TABLES,
  CARRIER,
  STATUS,
  STATUS_ORDER,
  AUTHORITY_FIELD_NAMES,
  AUTHORITY_STATUS,
} from './schema.js';

const QC_ROOT = 'https://mobile.fmcsa.dot.gov/qc/services';
export const VERIFICATION_MAX_AGE_DAYS = 30;

// ---------------------------------------------------------------------------
// QCMobile client

export function createQcClient({ webKey, http = createHttp({ minIntervalMs: 500 }) }) {
  return {
    async getCarrier(dot) {
      const url = `${QC_ROOT}/carriers/${dot}?webKey=${encodeURIComponent(webKey)}`;
      const res = await http.request(url);
      if (res.status === 404) return { notFound: true };
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`QCMobile HTTP ${res.status} for DOT ${dot}: ${text.slice(0, 200)}`);
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`QCMobile returned non-JSON for DOT ${dot}`);
      }
      return body;
    },
  };
}

/**
 * Interpret a QCMobile /carriers/{dot} response defensively.
 * Returns { status: AUTHORITY_STATUS.*, oos: boolean, reason: string }.
 */
export function interpretQcResponse(body) {
  if (!body || body.notFound || body.content === null || body.content === undefined) {
    return {
      status: AUTHORITY_STATUS.NOT_FOUND,
      oos: false,
      reason: 'DOT number not found in FMCSA QCMobile',
    };
  }
  const carrier = body.content?.carrier ?? body.content ?? {};
  const allowed = String(carrier.allowedToOperate ?? '').toUpperCase();
  const oosDate = carrier.oosDate ?? null;
  const oos = Boolean(oosDate);
  if (oos) {
    return {
      status: allowed === 'Y' ? AUTHORITY_STATUS.ACTIVE : AUTHORITY_STATUS.INACTIVE,
      oos: true,
      reason: `carrier is OUT OF SERVICE (oosDate=${oosDate})`,
    };
  }
  if (allowed === 'Y') {
    return { status: AUTHORITY_STATUS.ACTIVE, oos: false, reason: 'authority active' };
  }
  if (allowed === 'N') {
    return {
      status: AUTHORITY_STATUS.INACTIVE,
      oos: false,
      reason: 'not allowed to operate per FMCSA (allowedToOperate=N)',
    };
  }
  return {
    status: AUTHORITY_STATUS.ERROR,
    oos: false,
    reason: `unrecognized QCMobile response (allowedToOperate=${JSON.stringify(carrier.allowedToOperate)})`,
  };
}

// ---------------------------------------------------------------------------
// Authority field resolution / provisioning (Meta API, by name)

export const AUTHORITY_FIELD_SPECS = {
  authorityStatus: {
    name: AUTHORITY_FIELD_NAMES.authorityStatus,
    type: 'singleSelect',
    description:
      'Set automatically by verify-carriers from the FMCSA QCMobile API. Do not edit by hand.',
    options: {
      choices: [
        { name: AUTHORITY_STATUS.ACTIVE, color: 'greenBright' },
        { name: AUTHORITY_STATUS.INACTIVE, color: 'redBright' },
        { name: AUTHORITY_STATUS.NOT_FOUND, color: 'orangeBright' },
        { name: AUTHORITY_STATUS.ERROR, color: 'grayBright' },
      ],
    },
  },
  authorityVerifiedDate: {
    name: AUTHORITY_FIELD_NAMES.authorityVerifiedDate,
    type: 'date',
    description:
      'Last successful FMCSA authority check. The dispatch gate rejects anything older than 30 days.',
    options: { dateFormat: { name: 'iso' } },
  },
  oosFlag: {
    name: AUTHORITY_FIELD_NAMES.oosFlag,
    type: 'checkbox',
    description: 'FMCSA out-of-service flag, set by verify-carriers.',
    options: { icon: 'xCheckbox', color: 'redBright' },
  },
};

/**
 * Resolve the three authority field IDs by name from the live base schema.
 * With provision=true, missing fields are created first.
 */
export async function resolveAuthorityFields(client, { provision = false } = {}) {
  const findIds = async () => {
    const schema = await client.getBaseSchema();
    const table = (schema.tables ?? []).find((t) => t.id === TABLES.CARRIERS);
    if (!table) throw new Error(`Carriers table ${TABLES.CARRIERS} not found in base schema`);
    const byName = new Map(table.fields.map((f) => [f.name.toLowerCase(), f.id]));
    const ids = {};
    const missing = [];
    for (const [logical, name] of Object.entries(AUTHORITY_FIELD_NAMES)) {
      const id = byName.get(name.toLowerCase());
      if (id) ids[logical] = id;
      else missing.push(logical);
    }
    return { ids, missing };
  };

  let { ids, missing } = await findIds();
  if (missing.length > 0 && provision) {
    for (const logical of missing) {
      log(`Provisioning Carriers field "${AUTHORITY_FIELD_NAMES[logical]}"...`);
      await client.createField(TABLES.CARRIERS, AUTHORITY_FIELD_SPECS[logical]);
    }
    ({ ids, missing } = await findIds());
  }
  if (missing.length > 0) {
    const names = missing.map((m) => `"${AUTHORITY_FIELD_NAMES[m]}"`).join(', ');
    throw new Error(
      `Carriers table is missing authority field(s): ${names}. ` +
        'Run `npm run verify-carriers -- --provision` once (PAT needs schema.bases:write), ' +
        'or create them manually with exactly those names.'
    );
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Local cache (resumability across partial runs)

export function createFileCache(path = join(REPO_ROOT, '.cache', 'authority.json')) {
  let data = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      data = {};
    }
  }
  return {
    get: (dot) => data[dot],
    set: (dot, entry) => {
      data[dot] = entry;
    },
    save: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(data, null, 2));
    },
  };
}

export const memoryCache = () => {
  const data = {};
  return { get: (d) => data[d], set: (d, e) => (data[d] = e), save: () => {} };
};

// ---------------------------------------------------------------------------
// Core run

// Calendar-day comparison (Authority Verified Date is a date-only field):
// "verified 30 days ago today" still counts as fresh regardless of time of day.
function utcDay(d) {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
}

export function isVerificationFresh(dateValue, now, maxAgeDays = VERIFICATION_MAX_AGE_DAYS) {
  if (!dateValue) return false;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return false;
  return utcDay(now) - utcDay(d) <= maxAgeDays;
}

/**
 * Verify every pipeline carrier. Skips carriers verified within 30 days
 * (Airtable date or local cache) unless force. Demotion to Do Not Use is the
 * only status write, and only when the carrier is not already there.
 */
export async function runVerifyCarriers({
  client,
  qc,
  fieldIds,
  cache = memoryCache(),
  now = new Date(),
  force = false,
  limit = Infinity,
  printer = log,
}) {
  const carriers = await client.listAll(TABLES.CARRIERS, {
    fields: [
      CARRIER.carrierName,
      CARRIER.dotNumber,
      CARRIER.status,
      CARRIER.notes,
      fieldIds.authorityStatus,
      fieldIds.authorityVerifiedDate,
      fieldIds.oosFlag,
    ],
  });

  const inScope = carriers.filter((r) => STATUS_ORDER.includes(r.fields[CARRIER.status]));
  const stats = {
    inScope: inScope.length,
    checked: 0,
    active: 0,
    demoted: 0,
    notFound: 0,
    errors: 0,
    skippedFresh: 0,
    skippedNoDot: 0,
  };
  const updates = [];
  const todayIso = now.toISOString().slice(0, 10);

  for (const rec of inScope) {
    if (stats.checked >= limit) break;
    const name = rec.fields[CARRIER.carrierName] ?? rec.id;
    const dot = normalizeDot(rec.fields[CARRIER.dotNumber]);
    if (!dot) {
      warn(`Skipping "${name}": no DOT number on record.`);
      stats.skippedNoDot += 1;
      continue;
    }

    const airtableFresh = isVerificationFresh(rec.fields[fieldIds.authorityVerifiedDate], now);
    const cached = cache.get(dot);
    const cacheFresh = cached && isVerificationFresh(cached.checkedAt, now);
    if (!force && (airtableFresh || cacheFresh)) {
      stats.skippedFresh += 1;
      continue;
    }

    stats.checked += 1;
    let verdict;
    try {
      verdict = interpretQcResponse(await qc.getCarrier(dot));
    } catch (err) {
      warn(`QCMobile error for "${name}" (DOT ${dot}): ${err.message}`);
      stats.errors += 1;
      continue; // transient error: touch nothing, retry next run
    }
    cache.set(dot, { checkedAt: now.toISOString(), status: verdict.status, oos: verdict.oos });

    const patch = {
      [fieldIds.authorityStatus]: verdict.status,
      [fieldIds.authorityVerifiedDate]: todayIso,
      [fieldIds.oosFlag]: verdict.oos,
    };

    const shouldDemote =
      verdict.oos || verdict.status === AUTHORITY_STATUS.INACTIVE;
    if (shouldDemote && rec.fields[CARRIER.status] !== STATUS.DO_NOT_USE) {
      patch[CARRIER.status] = STATUS.DO_NOT_USE;
      patch[CARRIER.notes] = appendNote(
        rec.fields[CARRIER.notes],
        `[${todayIso} verify-authority] Status set to Do Not Use: ${verdict.reason}. ` +
          `Source: FMCSA QCMobile, DOT ${dot}.`
      );
      stats.demoted += 1;
      printer(`DEMOTED "${name}" (DOT ${dot}) -> Do Not Use: ${verdict.reason}`);
    } else if (verdict.status === AUTHORITY_STATUS.NOT_FOUND) {
      // Suspicious but possibly transient — flag, don't demote. Humans decide.
      patch[CARRIER.notes] = appendNote(
        rec.fields[CARRIER.notes],
        `[${todayIso} verify-authority] DOT ${dot} not found in FMCSA QCMobile — ` +
          'verify the DOT number; possible fraud signal per vetting SOP.'
      );
      stats.notFound += 1;
    } else {
      stats.active += 1;
    }
    updates.push({ id: rec.id, fields: patch });
  }

  if (updates.length > 0) await client.updateRecords(TABLES.CARRIERS, updates);
  cache.save();

  const mode = client.dryRun ? ' (DRY RUN — nothing written)' : '';
  printer(`Authority verification summary${mode}:`);
  printer(`  in scope:       ${stats.inScope}`);
  printer(`  checked:        ${stats.checked}`);
  printer(`  active:         ${stats.active}`);
  printer(`  demoted:        ${stats.demoted} -> ${STATUS.DO_NOT_USE}`);
  printer(`  not found:      ${stats.notFound} (flagged in Notes, not demoted)`);
  printer(`  errors:         ${stats.errors} (left untouched)`);
  printer(`  skipped fresh:  ${stats.skippedFresh} (verified within ${VERIFICATION_MAX_AGE_DAYS} days)`);
  if (stats.skippedNoDot) printer(`  skipped no-DOT: ${stats.skippedNoDot}`);
  return stats;
}

// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      provision: { type: 'boolean', default: false },
      limit: { type: 'string' },
    },
  });
  const { AIRTABLE_PAT, FMCSA_WEBKEY } = requireEnv('AIRTABLE_PAT', 'FMCSA_WEBKEY');
  const client = createAirtableClient({ pat: AIRTABLE_PAT, dryRun: values['dry-run'] });
  const fieldIds = await resolveAuthorityFields(client, { provision: values.provision });
  const qc = createQcClient({ webKey: FMCSA_WEBKEY });
  await runVerifyCarriers({
    client,
    qc,
    fieldIds,
    cache: createFileCache(),
    force: values.force,
    limit: values.limit ? Number(values.limit) : Infinity,
  });
}
