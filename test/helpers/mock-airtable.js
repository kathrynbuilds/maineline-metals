// In-memory Airtable REST fake, injected as fetchImpl into
// createAirtableClient. Implements just what the client uses: paginated GET
// list (returnFieldsByFieldId), POST create, PATCH update.

function makeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

export function createMockAirtable({ tables = {} } = {}) {
  // tables: { [tableId]: [{ id, fields }] }
  const store = new Map(Object.entries(tables).map(([t, recs]) => [t, [...recs]]));
  const requests = [];
  let nextId = 1;

  const getTable = (tableId) => {
    if (!store.has(tableId)) store.set(tableId, []);
    return store.get(tableId);
  };

  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url);
    const [, , , tableId] = parsed.pathname.split('/'); // /v0/{base}/{table}
    const method = options.method ?? 'GET';
    requests.push({ method, tableId, url, body: options.body ? JSON.parse(options.body) : null });
    const records = getTable(tableId);

    if (method === 'GET') {
      const pageSize = Number(parsed.searchParams.get('pageSize') ?? 100);
      const offset = Number(parsed.searchParams.get('offset') ?? 0);
      const page = records.slice(offset, offset + pageSize);
      const body = { records: page.map((r) => ({ id: r.id, fields: { ...r.fields } })) };
      if (offset + pageSize < records.length) body.offset = String(offset + pageSize);
      return makeResponse(200, body);
    }
    if (method === 'POST') {
      const incoming = JSON.parse(options.body).records;
      if (incoming.length > 10) return makeResponse(422, { error: 'MAX_RECORDS_EXCEEDED' });
      const created = incoming.map((r) => ({ id: `rec_mock_${nextId++}`, fields: { ...r.fields } }));
      records.push(...created);
      return makeResponse(200, { records: created });
    }
    if (method === 'PATCH') {
      const incoming = JSON.parse(options.body).records;
      if (incoming.length > 10) return makeResponse(422, { error: 'MAX_RECORDS_EXCEEDED' });
      const updated = [];
      for (const patch of incoming) {
        const rec = records.find((r) => r.id === patch.id);
        if (!rec) return makeResponse(404, { error: 'NOT_FOUND' });
        Object.assign(rec.fields, patch.fields);
        updated.push({ id: rec.id, fields: { ...rec.fields } });
      }
      return makeResponse(200, { records: updated });
    }
    return makeResponse(405, { error: 'METHOD_NOT_ALLOWED' });
  }

  return {
    fetchImpl,
    requests,
    getRecords: (tableId) => getTable(tableId).map((r) => ({ id: r.id, fields: { ...r.fields } })),
    writesFor: (tableId) =>
      requests.filter((r) => r.tableId === tableId && r.method !== 'GET'),
  };
}

export const noSleep = async () => {};
