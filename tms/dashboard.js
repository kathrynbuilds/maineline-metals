// Read-only dashboard: carrier pipeline counts (live from Airtable) + loads.
// node tms/dashboard.js  → http://localhost:8642  (PORT env to override)

import { createServer } from 'node:http';
import { loadEnv, requireEnv } from '../lib/config.js';
import { log } from '../lib/log.js';
import { createAirtableClient } from '../carriers/airtable-client.js';
import { TABLES, CARRIER, STATUS, COIL_EXCLUSION } from '../carriers/schema.js';
import { createLoadStore } from './loads.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function renderDashboard({ client, loadStore }) {
  const carriers = await client.listAll(TABLES.CARRIERS, {
    fields: [CARRIER.status, CARRIER.coilExclusion, CARRIER.laneBatch],
  });
  const byStatus = {};
  let coilConfirmed = 0;
  for (const r of carriers) {
    const s = r.fields[CARRIER.status] ?? '(none)';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    if (r.fields[CARRIER.coilExclusion] === COIL_EXCLUSION.CONFIRMED_NO_EXCLUSION) coilConfirmed += 1;
  }
  const statusRows = Object.values(STATUS)
    .map((s) => `<tr><td>${esc(s)}</td><td style="text-align:right">${byStatus[s] ?? 0}</td></tr>`)
    .join('');
  const loads = loadStore.list();
  const loadRows = loads
    .map(
      (l) =>
        `<tr><td>${esc(l.id)}</td><td>${esc(l.status)}</td><td>${esc(l.origin)} → ${esc(l.destination)}</td>` +
        `<td>${esc(l.commodity)}</td><td style="text-align:right">$${esc(l.rate)}</td><td>${esc(l.carrierDot)}</td></tr>`
    )
    .join('');

  return `<!doctype html><meta charset="utf-8"><title>Genesis TMS</title>
<style>
 body{font:14px/1.5 system-ui;margin:2rem;max-width:60rem}
 h1{font-size:1.3rem} h2{font-size:1.05rem;margin-top:2rem}
 table{border-collapse:collapse;min-width:24rem}
 td,th{border:1px solid #ccc;padding:.3rem .6rem;text-align:left}
</style>
<h1>Genesis Logistics — carrier capacity &amp; loads</h1>
<h2>Carrier pipeline (${carriers.length} carriers, ${coilConfirmed} coil-exclusion-confirmed)</h2>
<table><tr><th>Status</th><th>Count</th></tr>${statusRows}</table>
<h2>Loads (${loads.length})</h2>
<table><tr><th>ID</th><th>Status</th><th>Lane</th><th>Commodity</th><th>Rate</th><th>Carrier DOT</th></tr>
${loadRows || '<tr><td colspan="6">No loads yet</td></tr>'}</table>`;
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  loadEnv();
  const { AIRTABLE_PAT } = requireEnv('AIRTABLE_PAT');
  const client = createAirtableClient({ pat: AIRTABLE_PAT });
  const loadStore = createLoadStore();
  const port = Number(process.env.PORT ?? 8642);
  createServer(async (req, res) => {
    try {
      const html = await renderDashboard({ client, loadStore });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Dashboard error: ${err.message}`);
    }
  }).listen(port, () => log(`Dashboard on http://localhost:${port}`));
}
