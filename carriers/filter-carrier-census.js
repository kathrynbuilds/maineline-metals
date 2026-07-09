// Streaming filter for the FMCSA Company Census file (dataset az4n-8mr2).
//
// FMCSA is migrating from legacy MCMIS exports to the MOTUS registration
// schema through 2026, so column names shift under us. Everything here
// resolves columns defensively from candidate lists and prints the mapping it
// chose. The same resolver drives both this CSV path and the SODA API path in
// census-refresh.js.
//
// CLI: node carriers/filter-carrier-census.js <census.csv> [--states AR,TN,MS,GA,AL]
//        [--min-units 5] [--max-units 50] [--limit N] [--out file.jsonl]
// Emits one normalized JSON record per matching carrier.

import { createReadStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { parseArgs } from 'node:util';
import { log } from '../lib/log.js';

export const DEFAULT_STATES = ['AR', 'TN', 'MS', 'GA', 'AL'];
export const DEFAULT_MIN_UNITS = 5;
export const DEFAULT_MAX_UNITS = 50;
export const DEFAULT_MCS150_MAX_MONTHS = 24;

// Logical field → candidate column names, legacy MCMIS first, MOTUS-era after.
export const COLUMN_CANDIDATES = {
  dotNumber: ['dot_number', 'usdot_number', 'dot_no', 'usdot', 'dot'],
  mcNumber: ['docket1', 'docket_number', 'mc_number', 'docket', 'mc_mx_ff_number'],
  legalName: ['legal_name', 'carrier_name', 'legal_business_name', 'name'],
  dbaName: ['dba_name', 'dba', 'doing_business_as_name'],
  city: ['phy_city', 'physical_city', 'phy_natn_city', 'business_city', 'city'],
  state: ['phy_state', 'physical_state', 'phy_st', 'business_state', 'state'],
  phone: ['telephone', 'phone', 'telephone_number', 'phone_number', 'business_telephone'],
  email: ['email_address', 'email', 'electronic_mail'],
  powerUnits: [
    'nbr_power_unit',
    'power_units',
    'tot_pwr',
    'total_power_units',
    'num_power_units',
    'number_of_power_units',
  ],
  carrierOperation: [
    'carrier_operation',
    'carrier_op',
    'carrier_operation_desc',
    'operation_classification',
    'interstate_operation',
  ],
  cargoMetal: [
    'crgo_metalsheet',
    'crgo_metal_sheet',
    'cargo_metal_sheets_coils_rolls',
    'metal_sheets_coils_rolls',
    'metal_sheet_coil_roll',
  ],
  mcs150Date: ['mcs150_date', 'recent_mcs150_date', 'mcs_150_date', 'mcs150date', 'last_mcs150_update'],
};

// Substring heuristics used when no candidate matches exactly — keeps us
// working across schema drift without a code change.
const FUZZY_MATCHERS = {
  dotNumber: (n) => n.includes('dot') && n.includes('number'),
  powerUnits: (n) => n.includes('power') && n.includes('unit'),
  cargoMetal: (n) => n.includes('metal') && (n.includes('sheet') || n.includes('coil')),
  mcs150Date: (n) => n.includes('mcs150') || (n.includes('mcs') && n.includes('date')),
  carrierOperation: (n) => n.includes('carrier') && n.includes('operation'),
  state: (n) => n.includes('phy') && n.includes('state'),
  city: (n) => n.includes('phy') && n.includes('city'),
  email: (n) => n.includes('email'),
};

export function normalizeHeader(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Map logical field names to actual column names found in `headers`.
 * Returns { columns, missing }. Missing non-critical columns are tolerated;
 * callers decide what is fatal.
 */
export function resolveColumns(headers) {
  const normalized = new Map();
  for (const h of headers) {
    const n = normalizeHeader(h);
    if (!normalized.has(n)) normalized.set(n, h);
  }
  const columns = {};
  const missing = [];
  for (const [logical, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    let found = null;
    for (const c of candidates) {
      if (normalized.has(c)) {
        found = normalized.get(c);
        break;
      }
    }
    if (!found && FUZZY_MATCHERS[logical]) {
      for (const [n, original] of normalized) {
        if (FUZZY_MATCHERS[logical](n)) {
          found = original;
          break;
        }
      }
    }
    columns[logical] = found;
    if (!found) missing.push(logical);
  }
  return { columns, missing };
}

export function printColumnMapping(columns, printer = log) {
  printer('Census column mapping:');
  for (const [logical, actual] of Object.entries(columns)) {
    printer(`  ${logical.padEnd(18)} -> ${actual ?? '(not found)'}`);
  }
}

export function normalizeDot(value) {
  const digits = String(value ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits || null;
}

function truthyFlag(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'X' || v === 'Y' || v === 'YES' || v === 'TRUE' || v === '1';
}

function isInterstate(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'A' || v.startsWith('INTERSTATE');
}

export function parseCensusDate(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // MM/DD/YYYY
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Normalize one raw census row (object keyed by actual column name). */
export function normalizeRow(row, columns) {
  const get = (logical) => (columns[logical] ? row[columns[logical]] : undefined);
  const clean = (v) => {
    const s = String(v ?? '').trim();
    return s || null;
  };
  const mcRaw = clean(get('mcNumber'));
  return {
    dotNumber: normalizeDot(get('dotNumber')),
    mcNumber: mcRaw ? mcRaw.replace(/^MC[-\s]?/i, '') : null,
    legalName: clean(get('legalName')),
    dbaName: clean(get('dbaName')),
    city: clean(get('city')),
    state: clean(get('state'))?.toUpperCase() ?? null,
    phone: clean(get('phone')),
    email: clean(get('email'))?.toLowerCase() ?? null,
    powerUnits: (() => {
      const n = Number(String(get('powerUnits') ?? '').replace(/[^\d.]/g, ''));
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    carrierOperation: clean(get('carrierOperation')),
    cargoMetal: get('cargoMetal'),
    mcs150Date: parseCensusDate(get('mcs150Date')),
  };
}

/**
 * The Genesis prospecting filter: domicile state, 5–50 power units,
 * interstate, metal sheets/coils/rolls cargo class, MCS-150 filed within
 * 24 months. Any check whose column is missing from the file is treated as
 * unknown and REJECTED only for hard requirements (state, power units); for
 * the rest we keep the row and let a human judge — prospecting data, not
 * vetting (invariant: census data never vets anyone).
 */
export function carrierPassesFilter(normalized, columns, opts = {}) {
  const {
    states = DEFAULT_STATES,
    minUnits = DEFAULT_MIN_UNITS,
    maxUnits = DEFAULT_MAX_UNITS,
    mcs150MaxMonths = DEFAULT_MCS150_MAX_MONTHS,
    now = new Date(),
  } = opts;

  if (!normalized.dotNumber) return false;
  if (!normalized.state || !states.includes(normalized.state)) return false;
  if (
    normalized.powerUnits === null ||
    normalized.powerUnits < minUnits ||
    normalized.powerUnits > maxUnits
  ) {
    return false;
  }
  if (columns.carrierOperation && !isInterstate(normalized.carrierOperation)) return false;
  if (columns.cargoMetal && !truthyFlag(normalized.cargoMetal)) return false;
  if (columns.mcs150Date) {
    if (!normalized.mcs150Date) return false;
    const cutoff = new Date(now);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - mcs150MaxMonths);
    if (normalized.mcs150Date < cutoff) return false;
  }
  return true;
}

/**
 * Minimal streaming CSV parser (quoted fields, embedded commas/newlines,
 * doubled-quote escapes). Calls onRow(objectKeyedByHeader) per data row.
 */
export async function parseCsvStream(readable, onRow) {
  let headers = null;
  let field = '';
  let row = [];
  let inQuotes = false;
  let sawQuoteInQuotes = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = async () => {
    endField();
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    if (!headers) {
      headers = row.map((h) => h.trim());
    } else {
      const obj = {};
      for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? '';
      await onRow(obj);
    }
    row = [];
  };

  for await (const chunk of readable) {
    const text = chunk.toString('utf8');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (sawQuoteInQuotes) {
          sawQuoteInQuotes = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          inQuotes = false;
          // fall through: reprocess ch outside quotes
        } else if (ch === '"') {
          sawQuoteInQuotes = true;
          continue;
        } else {
          field += ch;
          continue;
        }
      }
      if (ch === '"' && field === '') {
        inQuotes = true;
      } else if (ch === ',') {
        endField();
      } else if (ch === '\n') {
        if (field.endsWith('\r')) field = field.slice(0, -1);
        await endRow();
      } else {
        field += ch;
      }
    }
  }
  if (inQuotes && sawQuoteInQuotes) inQuotes = false;
  if (field !== '' || row.length > 0) await endRow();
  return headers ?? [];
}

/**
 * Stream a census CSV file and yield normalized, filtered carrier records.
 * onRecord(normalized) is awaited per match. Returns stats.
 */
export async function filterCensusCsv(path, opts = {}, onRecord) {
  const { limit = Infinity, printer = log } = opts;
  let columns = null;
  let matched = 0;
  let scanned = 0;
  const stream = createReadStream(path);
  await parseCsvStream(stream, async (rawRow) => {
    if (!columns) {
      const { columns: cols, missing } = resolveColumns(Object.keys(rawRow));
      columns = cols;
      printColumnMapping(columns, printer);
      const critical = ['dotNumber', 'legalName', 'state', 'powerUnits'];
      const fatal = critical.filter((c) => missing.includes(c));
      if (fatal.length > 0) {
        throw new Error(
          `Census file is missing critical columns: ${fatal.join(', ')}. ` +
            'Header format may have changed — update COLUMN_CANDIDATES.'
        );
      }
    }
    scanned += 1;
    if (matched >= limit) return;
    const normalized = normalizeRow(rawRow, columns);
    if (carrierPassesFilter(normalized, columns, opts)) {
      matched += 1;
      await onRecord(normalized);
    }
  });
  return { scanned, matched, columns };
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const { values, positionals } = parseArgs({
    options: {
      states: { type: 'string' },
      'min-units': { type: 'string' },
      'max-units': { type: 'string' },
      limit: { type: 'string' },
      out: { type: 'string' },
    },
    allowPositionals: true,
  });
  const csvPath = positionals[0];
  if (!csvPath) {
    console.error(
      'Usage: node carriers/filter-carrier-census.js <census.csv> ' +
        '[--states AR,TN] [--min-units 5] [--max-units 50] [--limit N] [--out file.jsonl]'
    );
    process.exit(1);
  }
  const out = values.out ? createWriteStream(values.out) : process.stdout;
  const opts = {
    states: values.states ? values.states.split(',').map((s) => s.trim().toUpperCase()) : DEFAULT_STATES,
    minUnits: values['min-units'] ? Number(values['min-units']) : DEFAULT_MIN_UNITS,
    maxUnits: values['max-units'] ? Number(values['max-units']) : DEFAULT_MAX_UNITS,
    limit: values.limit ? Number(values.limit) : Infinity,
  };
  const stats = await filterCensusCsv(csvPath, opts, async (rec) => {
    out.write(`${JSON.stringify(rec)}\n`);
  });
  log(`Scanned ${stats.scanned} rows, matched ${stats.matched}.`);
}
