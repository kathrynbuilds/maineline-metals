import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp } from '../lib/http.js';
import { fetchCensusFromSoda } from '../carriers/census-refresh.js';

const quiet = () => {};
const NOW = new Date('2026-07-09T00:00:00Z');

const METADATA = {
  name: 'Company Census File',
  columns: [
    'dot_number', 'legal_name', 'dba_name', 'carrier_operation', 'phy_city',
    'phy_state', 'telephone', 'email_address', 'nbr_power_unit',
    'crgo_metalsheet', 'mcs150_date',
  ].map((fieldName) => ({ fieldName })),
};

const ROWS = [
  {
    dot_number: '1234567', legal_name: 'OZARK STEEL HAULERS LLC',
    carrier_operation: 'A', phy_city: 'JONESBORO', phy_state: 'AR',
    telephone: '8705550101', email_address: 'dispatch@ozarksteel.example',
    nbr_power_unit: '12', crgo_metalsheet: 'X', mcs150_date: '2026-03-15',
  },
  { // fails filter: no metal cargo class
    dot_number: '4567890', legal_name: 'GULF COAST DRYVAN LLC',
    carrier_operation: 'A', phy_city: 'MOBILE', phy_state: 'AL',
    telephone: '2515550104', nbr_power_unit: '15', crgo_metalsheet: '',
    mcs150_date: '2026-05-01',
  },
];

function makeSodaFetch({ rejectNumericCast = false } = {}) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const respond = (status, body) => ({
      ok: status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    });
    if (url.includes('/api/views/')) return respond(200, METADATA);
    const params = new URL(url).searchParams;
    const where = params.get('$where') ?? '';
    if (rejectNumericCast && where.includes('::number')) {
      return respond(400, { message: 'Invalid cast' });
    }
    const offset = Number(params.get('$offset') ?? 0);
    return respond(200, offset === 0 ? ROWS : []);
  };
  return { fetchImpl, requests };
}

test('SODA route discovers columns, filters client-side, returns normalized records', async () => {
  const { fetchImpl } = makeSodaFetch();
  const http = createHttp({ fetchImpl, sleep: async () => {} });
  const { records, scanned } = await fetchCensusFromSoda({
    http,
    now: NOW,
    appToken: undefined,
    printer: quiet,
  });
  assert.equal(scanned, 2);
  assert.equal(records.length, 1);
  assert.equal(records[0].dotNumber, '1234567');
  assert.equal(records[0].state, 'AR');
  assert.equal(records[0].powerUnits, 12);
});

test('SODA route falls back to state-only $where when the API rejects the numeric cast', async () => {
  const { fetchImpl, requests } = makeSodaFetch({ rejectNumericCast: true });
  const http = createHttp({ fetchImpl, sleep: async () => {} });
  const { records } = await fetchCensusFromSoda({
    http,
    now: NOW,
    appToken: undefined,
    printer: quiet,
  });
  assert.equal(records.length, 1, 'power-unit window still enforced client-side');
  const resourceCalls = requests.filter((u) => u.includes('/resource/'));
  assert.ok(resourceCalls[0].includes('%3A%3Anumber') || resourceCalls[0].includes('::number'));
  assert.ok(!resourceCalls.at(-1).includes('number'), 'retry dropped the cast clause');
});
