// Phase 1: npm run refresh-census
//
// Refreshes the carrier prospect pool from the FMCSA Company Census
// (dataset az4n-8mr2 on data.transportation.gov) into the Airtable Carriers
// table. Primary route is the Socrata SODA API with server-side filters;
// fallback is a downloaded census CSV via filter-carrier-census.js (--csv).
//
// Invariants enforced here:
//   3. Upserts fill blank fields only; conflicts are appended to Notes.
//   4. Census data is prospecting data — new records enter at Researched and
//      existing records NEVER have Status touched by this pipeline.
//
// Flags: --dry-run  --batch <lane batch label>  --states AR,TN  --limit N  --csv <path>

import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/config.js';
import { log, warn } from '../lib/log.js';
import { createHttp } from '../lib/http.js';
import {
  createAirtableClient,
  diffBlankFillOnly,
  formatConflictNote,
  appendNote,
} from './airtable-client.js';
import {
  TABLES,
  CARRIER,
  STATUS,
  SOURCE_FMCSA_CENSUS,
  LANE_BATCHES,
} from './schema.js';
import {
  resolveColumns,
  printColumnMapping,
  normalizeRow,
  normalizeDot,
  carrierPassesFilter,
  filterCensusCsv,
  DEFAULT_STATES,
} from './filter-carrier-census.js';

const SODA_METADATA_URL = 'https://data.transportation.gov/api/views/az4n-8mr2.json';
const SODA_RESOURCE_URL = 'https://data.transportation.gov/resource/az4n-8mr2.json';
const SODA_PAGE_SIZE = 5000;

// Human-readable names for conflict notes.
const FIELD_LABELS = {
  [CARRIER.carrierName]: 'Carrier Name',
  [CARRIER.dba]: 'DBA',
  [CARRIER.mcNumber]: 'MC Number',
  [CARRIER.dotNumber]: 'DOT Number',
  [CARRIER.domicileCity]: 'Domicile City',
  [CARRIER.domicileState]: 'Domicile State',
  [CARRIER.phone]: 'Phone',
  [CARRIER.email]: 'Email',
  [CARRIER.powerUnits]: 'Power Units',
};

/** Census record → Airtable field payload (data fields only, no Status). */
export function censusRecordToFields(rec) {
  const fields = {
    [CARRIER.carrierName]: rec.legalName,
    [CARRIER.dba]: rec.dbaName,
    [CARRIER.mcNumber]: rec.mcNumber,
    [CARRIER.dotNumber]: rec.dotNumber,
    [CARRIER.domicileCity]: rec.city,
    [CARRIER.domicileState]: rec.state,
    [CARRIER.phone]: rec.phone,
    [CARRIER.email]: rec.email,
    [CARRIER.powerUnits]: rec.powerUnits,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) delete fields[k];
  }
  return fields;
}

/**
 * Pull filtered census rows via the SODA API. Column names are discovered
 * from dataset metadata at runtime (MOTUS migration keeps renaming them).
 * Server-side: state + power-unit window when the API accepts it; everything
 * else is re-checked client-side with carrierPassesFilter either way.
 */
export async function fetchCensusFromSoda({
  http = createHttp({ minIntervalMs: 100 }),
  states = DEFAULT_STATES,
  minUnits = 5,
  maxUnits = 50,
  limit = Infinity,
  now = new Date(),
  appToken = process.env.SODA_APP_TOKEN,
  printer = log,
} = {}) {
  const headers = appToken ? { 'X-App-Token': appToken } : {};
  const meta = await http.requestJson(SODA_METADATA_URL, { headers });
  const fieldNames = (meta.columns ?? []).map((c) => c.fieldName).filter(Boolean);
  if (fieldNames.length === 0) {
    throw new Error('SODA metadata returned no columns — dataset az4n-8mr2 may have moved.');
  }
  const { columns, missing } = resolveColumns(fieldNames);
  printColumnMapping(columns, printer);
  const critical = ['dotNumber', 'legalName', 'state', 'powerUnits'];
  const fatal = critical.filter((c) => missing.includes(c));
  if (fatal.length > 0) {
    throw new Error(
      `SODA dataset is missing critical columns: ${fatal.join(', ')}. ` +
        'Fall back to --csv with a downloaded census file.'
    );
  }

  const stateList = states.map((s) => `'${s.toUpperCase()}'`).join(',');
  const whereClauses = [
    `upper(${columns.state}) in (${stateList})`,
    // ::number cast tolerates the column being typed as text; if the API
    // rejects the cast we retry with the state filter alone.
    `${columns.powerUnits}::number between ${minUnits} and ${maxUnits}`,
  ];
  const whereVariants = [whereClauses.join(' AND '), whereClauses[0]];

  const filterOpts = { states, minUnits, maxUnits, now };
  const records = [];
  let scanned = 0;

  for (const [variantIdx, where] of whereVariants.entries()) {
    try {
      let offset = 0;
      for (;;) {
        const params = new URLSearchParams({
          $where: where,
          $order: ':id',
          $limit: String(SODA_PAGE_SIZE),
          $offset: String(offset),
        });
        const page = await http.requestJson(`${SODA_RESOURCE_URL}?${params}`, { headers });
        if (!Array.isArray(page)) throw new Error('SODA returned a non-array page');
        for (const row of page) {
          scanned += 1;
          const normalized = normalizeRow(row, columns);
          if (carrierPassesFilter(normalized, columns, filterOpts)) {
            records.push(normalized);
            if (records.length >= limit) return { records, scanned, columns };
          }
        }
        if (page.length < SODA_PAGE_SIZE) return { records, scanned, columns };
        offset += SODA_PAGE_SIZE;
      }
    } catch (err) {
      if (variantIdx < whereVariants.length - 1 && err.status === 400) {
        warn(`SODA rejected server-side filter (${err.message}); retrying with simpler $where.`);
        records.length = 0;
        scanned = 0;
        continue;
      }
      throw err;
    }
  }
  return { records, scanned, columns };
}

/**
 * Core upsert: dedupe census records against the Carriers table keyed on
 * DOT Number. New records enter at Researched with Source/Lane Batch set;
 * existing records get blank-fill-only patches with conflicts logged to
 * Notes. Works identically in dry-run (client records writes, sends none).
 */
export async function runCensusRefresh({
  client,
  records,
  batchLabel,
  now = new Date(),
  printer = log,
}) {
  const fillTargets = Object.keys(FIELD_LABELS);
  const existing = await client.listAll(TABLES.CARRIERS, {
    fields: [...fillTargets, CARRIER.notes, CARRIER.status],
  });
  const byDot = new Map();
  for (const rec of existing) {
    const dot = normalizeDot(rec.fields[CARRIER.dotNumber]);
    if (dot && !byDot.has(dot)) byDot.set(dot, rec);
  }

  const creates = [];
  const updates = [];
  const seen = new Set();
  const stats = {
    created: 0,
    updated: 0,
    skipped: 0,
    duplicatesInFeed: 0,
    conflictsLogged: 0,
    perState: {},
  };

  for (const rec of records) {
    if (!rec.dotNumber) continue;
    if (seen.has(rec.dotNumber)) {
      stats.duplicatesInFeed += 1;
      continue;
    }
    seen.add(rec.dotNumber);
    if (rec.state) stats.perState[rec.state] = (stats.perState[rec.state] ?? 0) + 1;

    const incoming = censusRecordToFields(rec);
    const existingRec = byDot.get(rec.dotNumber);
    if (!existingRec) {
      creates.push({
        fields: {
          ...incoming,
          [CARRIER.status]: STATUS.RESEARCHED,
          [CARRIER.source]: SOURCE_FMCSA_CENSUS,
          ...(batchLabel ? { [CARRIER.laneBatch]: batchLabel } : {}),
        },
      });
      stats.created += 1;
      continue;
    }

    // Invariant 3/4: blank-fill only, and never touch Status/Source/Lane
    // Batch on records that already exist.
    const { patch, conflicts } = diffBlankFillOnly(existingRec.fields, incoming, FIELD_LABELS);
    if (conflicts.length > 0) {
      stats.conflictsLogged += conflicts.length;
      patch[CARRIER.notes] = appendNote(
        existingRec.fields[CARRIER.notes],
        formatConflictNote('census-refresh', conflicts, now)
      );
    }
    if (Object.keys(patch).length > 0) {
      updates.push({ id: existingRec.id, fields: patch });
      stats.updated += 1;
    } else {
      stats.skipped += 1;
    }
  }

  if (creates.length > 0) await client.createRecords(TABLES.CARRIERS, creates);
  if (updates.length > 0) await client.updateRecords(TABLES.CARRIERS, updates);

  const mode = client.dryRun ? ' (DRY RUN — nothing written)' : '';
  printer(`Census refresh summary${mode}:`);
  printer(`  new:      ${stats.created}`);
  printer(`  updated:  ${stats.updated}${stats.conflictsLogged ? ` (${stats.conflictsLogged} conflict(s) logged to Notes)` : ''}`);
  printer(`  skipped:  ${stats.skipped} (already complete)`);
  if (stats.duplicatesInFeed > 0) printer(`  dupes in feed: ${stats.duplicatesInFeed}`);
  printer('  per-state (filtered pool):');
  for (const [state, n] of Object.entries(stats.perState).sort()) {
    printer(`    ${state}: ${n}`);
  }
  return stats;
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      batch: { type: 'string', default: LANE_BATCHES[0] },
      states: { type: 'string' },
      limit: { type: 'string' },
      csv: { type: 'string' },
    },
  });
  const dryRun = values['dry-run'];
  const states = values.states
    ? values.states.split(',').map((s) => s.trim().toUpperCase())
    : DEFAULT_STATES;
  const limit = values.limit ? Number(values.limit) : Infinity;

  if (!LANE_BATCHES.includes(values.batch)) {
    console.error(
      `--batch must be one of the Lane Batch choices:\n  ${LANE_BATCHES.join('\n  ')}`
    );
    process.exit(1);
  }
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) {
    console.error(
      'AIRTABLE_PAT is required (even --dry-run reads the Carriers table to dedupe). ' +
        'Copy .env.example to .env and fill it in.'
    );
    process.exit(1);
  }

  const client = createAirtableClient({ pat, dryRun });
  let records;
  if (values.csv) {
    records = [];
    const stats = await filterCensusCsv(values.csv, { states, limit }, async (rec) => {
      records.push(rec);
    });
    log(`CSV: scanned ${stats.scanned} rows, ${records.length} passed the filter.`);
  } else {
    try {
      const result = await fetchCensusFromSoda({ states, limit });
      records = result.records;
      log(`SODA: scanned ${result.scanned} rows, ${records.length} passed the filter.`);
    } catch (err) {
      console.error(
        `SODA API route failed: ${err.message}\n` +
          'Fallback: download the census CSV from data.transportation.gov ' +
          '(dataset az4n-8mr2) and re-run with --csv <path>.'
      );
      process.exit(1);
    }
  }

  await runCensusRefresh({ client, records, batchLabel: values.batch });
  if (dryRun) log('Dry run complete. Re-run without --dry-run to write.');
}
