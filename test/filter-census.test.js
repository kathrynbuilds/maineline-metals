import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveColumns,
  normalizeRow,
  carrierPassesFilter,
  parseCsvStream,
  filterCensusCsv,
  parseCensusDate,
  normalizeDot,
} from '../carriers/filter-carrier-census.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = new Date('2026-07-09T00:00:00Z');
const quiet = () => {};

test('resolveColumns maps legacy MCMIS headers', () => {
  const { columns, missing } = resolveColumns([
    'DOT_NUMBER', 'LEGAL_NAME', 'DBA_NAME', 'CARRIER_OPERATION', 'PHY_CITY',
    'PHY_STATE', 'TELEPHONE', 'EMAIL_ADDRESS', 'NBR_POWER_UNIT',
    'CRGO_METALSHEET', 'MCS150_DATE',
  ]);
  assert.equal(columns.dotNumber, 'DOT_NUMBER');
  assert.equal(columns.state, 'PHY_STATE');
  assert.equal(columns.powerUnits, 'NBR_POWER_UNIT');
  assert.equal(columns.cargoMetal, 'CRGO_METALSHEET');
  assert.equal(columns.mcs150Date, 'MCS150_DATE');
  assert.ok(!missing.includes('dotNumber'));
});

test('resolveColumns maps MOTUS-era headers via candidates and fuzzy match', () => {
  const { columns } = resolveColumns([
    'usdot_number', 'legal_business_name', 'doing_business_as_name',
    'carrier_operation_desc', 'physical_city', 'physical_state',
    'phone_number', 'email', 'total_power_units', 'metal_sheets_coils_rolls',
    'last_mcs150_update',
  ]);
  assert.equal(columns.dotNumber, 'usdot_number');
  assert.equal(columns.legalName, 'legal_business_name');
  assert.equal(columns.state, 'physical_state');
  assert.equal(columns.powerUnits, 'total_power_units');
  assert.equal(columns.cargoMetal, 'metal_sheets_coils_rolls');
  assert.equal(columns.mcs150Date, 'last_mcs150_update');
});

test('parseCensusDate handles MM/DD/YYYY, ISO, and garbage', () => {
  assert.equal(parseCensusDate('03/15/2026').toISOString().slice(0, 10), '2026-03-15');
  assert.equal(parseCensusDate('2026-03-15').toISOString().slice(0, 10), '2026-03-15');
  assert.equal(parseCensusDate('not a date'), null);
  assert.equal(parseCensusDate(''), null);
});

test('normalizeDot strips punctuation and leading zeros', () => {
  assert.equal(normalizeDot('0012345'), '12345');
  assert.equal(normalizeDot(' 123-4567 '), '1234567');
  assert.equal(normalizeDot(''), null);
});

function mcmisRow(overrides = {}) {
  return {
    DOT_NUMBER: '1111111',
    LEGAL_NAME: 'TEST CARRIER',
    CARRIER_OPERATION: 'A',
    PHY_CITY: 'ROME',
    PHY_STATE: 'GA',
    NBR_POWER_UNIT: '10',
    CRGO_METALSHEET: 'X',
    MCS150_DATE: '01/15/2026',
    ...overrides,
  };
}

const { columns: MCMIS_COLS } = resolveColumns(Object.keys(mcmisRow()));

function passes(overrides) {
  const normalized = normalizeRow(mcmisRow(overrides), MCMIS_COLS);
  return carrierPassesFilter(normalized, MCMIS_COLS, { now: NOW });
}

test('filter accepts a qualifying carrier and rejects each disqualifier', () => {
  assert.equal(passes(), true);
  assert.equal(passes({ PHY_STATE: 'KS' }), false, 'out-of-footprint state');
  assert.equal(passes({ NBR_POWER_UNIT: '4' }), false, 'too few power units');
  assert.equal(passes({ NBR_POWER_UNIT: '51' }), false, 'too many power units');
  assert.equal(passes({ CARRIER_OPERATION: 'C' }), false, 'intrastate');
  assert.equal(passes({ CRGO_METALSHEET: '' }), false, 'no metal cargo class');
  assert.equal(passes({ MCS150_DATE: '01/05/2023' }), false, 'MCS-150 older than 24 months');
  assert.equal(passes({ DOT_NUMBER: '' }), false, 'missing DOT');
});

test('parseCsvStream handles quoted commas, embedded newlines, and escaped quotes', async () => {
  const csv = 'a,b,c\r\n"1,5","line1\nline2","she said ""hi"""\r\nplain,2,3\n';
  const rows = [];
  await parseCsvStream(Readable.from([csv]), (r) => rows.push(r));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: '1,5', b: 'line1\nline2', c: 'she said "hi"' });
  assert.deepEqual(rows[1], { a: 'plain', b: '2', c: '3' });
});

test('filterCensusCsv on MCMIS fixture keeps only qualifying carriers', async () => {
  const matched = [];
  const stats = await filterCensusCsv(
    join(FIXTURES, 'census-mcmis.csv'),
    { now: NOW, printer: quiet },
    async (rec) => matched.push(rec)
  );
  assert.equal(stats.scanned, 9);
  const dots = matched.map((r) => r.dotNumber).sort();
  // excluded: 3456789 (4 units), 4567890 (no metal), 5678901 (intrastate),
  // 6789012 (KS), 8901234 (stale MCS-150), 9012345 (55 units)
  assert.deepEqual(dots, ['1234567', '2345678', '7890123']);
  const delta = matched.find((r) => r.dotNumber === '7890123');
  assert.equal(delta.dbaName, 'DELTA\nCOIL', 'embedded newline in quoted field survives');
  const ozark = matched.find((r) => r.dotNumber === '1234567');
  assert.equal(ozark.email, 'dispatch@ozarksteel.example', 'email lowercased');
});

test('filterCensusCsv on MOTUS fixture applies the same filter through new headers', async () => {
  const matched = [];
  await filterCensusCsv(
    join(FIXTURES, 'census-motus.csv'),
    { now: NOW, printer: quiet },
    async (rec) => matched.push(rec)
  );
  const dots = matched.map((r) => r.dotNumber).sort();
  // excluded: 6789012 (KS), 5678901 (intrastate)
  assert.deepEqual(dots, ['1234567', '2345678']);
});

test('filterCensusCsv respects --limit', async () => {
  const matched = [];
  await filterCensusCsv(
    join(FIXTURES, 'census-mcmis.csv'),
    { now: NOW, limit: 1, printer: quiet },
    async (rec) => matched.push(rec)
  );
  assert.equal(matched.length, 1);
});
