// Airtable REST client. PAT auth, list-all pagination, batched writes
// (max 10 records/request), ≤5 requests/sec per base, 429 backoff — per
// https://airtable.com/developers/web/api/rate-limits (5 rps/base, 30s
// penalty on 429).
//
// Invariant 3 lives in diffBlankFillOnly(): automated upserts fill blank
// fields only; conflicting non-blank values are never overwritten — they are
// logged so callers can append them to Notes.

import { createHttp } from '../lib/http.js';
import { BASE_ID } from './schema.js';

const API_ROOT = 'https://api.airtable.com/v0';
const BATCH_SIZE = 10;
const MIN_INTERVAL_MS = 210; // ~4.7 rps, safely under the 5 rps/base limit

export function createAirtableClient({
  pat,
  baseId = BASE_ID,
  fetchImpl,
  sleep,
  dryRun = false,
} = {}) {
  if (!pat && !dryRun) throw new Error('createAirtableClient: pat is required');
  const http = createHttp({ fetchImpl, sleep, minIntervalMs: MIN_INTERVAL_MS });
  const headers = {
    Authorization: `Bearer ${pat}`,
    'Content-Type': 'application/json',
  };
  // Every write the client performs (or would perform, in dry-run) is
  // recorded here so callers/tests can audit exactly what changed.
  const writeLog = [];

  async function listAll(tableId, { fields, filterByFormula, pageSize = 100 } = {}) {
    const records = [];
    let offset;
    do {
      const params = new URLSearchParams({
        returnFieldsByFieldId: 'true',
        pageSize: String(pageSize),
      });
      if (filterByFormula) params.set('filterByFormula', filterByFormula);
      for (const f of fields ?? []) params.append('fields[]', f);
      if (offset) params.set('offset', offset);
      const body = await http.requestJson(
        `${API_ROOT}/${baseId}/${tableId}?${params}`,
        { headers }
      );
      records.push(...(body.records ?? []));
      offset = body.offset;
    } while (offset);
    return records;
  }

  async function writeBatched(tableId, method, records) {
    const results = [];
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      writeLog.push({ tableId, method, records: batch });
      if (dryRun) {
        results.push(...batch.map((r) => ({ ...r, id: r.id ?? 'dry-run' })));
        continue;
      }
      const body = await http.requestJson(`${API_ROOT}/${baseId}/${tableId}`, {
        method,
        headers,
        body: JSON.stringify({ records: batch, typecast: false }),
      });
      results.push(...(body.records ?? []));
    }
    return results;
  }

  // records: [{ fields: { <fieldId>: value } }]
  const createRecords = (tableId, records) => writeBatched(tableId, 'POST', records);
  // records: [{ id, fields }] — PATCH only touches the listed fields
  const updateRecords = (tableId, records) => writeBatched(tableId, 'PATCH', records);

  /** Meta API: full table/field schema for the base (read-only). */
  async function getBaseSchema() {
    return http.requestJson(`${API_ROOT}/meta/bases/${baseId}/tables`, { headers });
  }

  /** Meta API: create a field. Requires a PAT with schema.bases:write. */
  async function createField(tableId, fieldSpec) {
    writeLog.push({ tableId, method: 'META_CREATE_FIELD', fieldSpec });
    if (dryRun) return { id: 'fld_dry_run', ...fieldSpec };
    return http.requestJson(`${API_ROOT}/meta/bases/${baseId}/tables/${tableId}/fields`, {
      method: 'POST',
      headers,
      body: JSON.stringify(fieldSpec),
    });
  }

  return {
    listAll,
    createRecords,
    updateRecords,
    getBaseSchema,
    createField,
    writeLog,
    dryRun,
    baseId,
  };
}

function isBlank(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function sameValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim() === b.trim();
  }
  return a === b;
}

/**
 * Invariant 3: compute the blank-fill-only patch for one record.
 * Returns { patch, conflicts } where patch contains only fields that are
 * currently blank, and conflicts lists incoming values that differ from
 * existing non-blank values (to be logged to Notes, never applied).
 */
export function diffBlankFillOnly(existingFields, incomingFields, fieldNames = {}) {
  const patch = {};
  const conflicts = [];
  for (const [fieldId, incoming] of Object.entries(incomingFields)) {
    if (isBlank(incoming)) continue;
    const existing = existingFields[fieldId];
    if (isBlank(existing)) {
      patch[fieldId] = incoming;
    } else if (!sameValue(existing, incoming)) {
      conflicts.push({
        fieldId,
        fieldName: fieldNames[fieldId] ?? fieldId,
        existing,
        incoming,
      });
    }
  }
  return { patch, conflicts };
}

/** Timestamped Notes line for conflicts (invariant 3: log, don't resolve). */
export function formatConflictNote(source, conflicts, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  const lines = conflicts.map(
    (c) =>
      `[${stamp} ${source}] Conflict on ${c.fieldName}: kept existing ` +
      `${JSON.stringify(c.existing)}, incoming ${JSON.stringify(c.incoming)} not applied.`
  );
  return lines.join('\n');
}

/** Append to a Notes value without disturbing what a human already wrote. */
export function appendNote(existingNotes, addition) {
  if (isBlank(existingNotes)) return addition;
  return `${existingNotes.replace(/\s+$/, '')}\n${addition}`;
}

export { isBlank };
