// Minimal load lifecycle store. JSON file under data/ (git-ignored) — the
// TMS is deliberately tiny; Airtable stays canonical for carriers, this store
// only tracks Genesis's own loads.
//
// CLI: node tms/loads.js list
//      node tms/loads.js create --origin "Blytheville, AR" --destination "Atlanta, GA" \
//        --commodity "Steel coils" --weight 47500 --rate 1850 --carrier-dot 1234567 \
//        --pickup 2026-07-14 [--delivery 2026-07-15]
//      node tms/loads.js status <loadId> <newStatus>

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT } from '../lib/config.js';
import { log } from '../lib/log.js';

export const LOAD_STATUSES = [
  'Booked',
  'Dispatched',
  'In Transit',
  'Delivered',
  'Invoiced',
  'Paid',
  'Cancelled',
];

// Forward-only lifecycle (Cancelled allowed from any non-terminal state).
const NEXT = {
  Booked: ['Dispatched', 'Cancelled'],
  Dispatched: ['In Transit', 'Cancelled'],
  'In Transit': ['Delivered', 'Cancelled'],
  Delivered: ['Invoiced'],
  Invoiced: ['Paid'],
  Paid: [],
  Cancelled: [],
};

const DEFAULT_PATH = join(REPO_ROOT, 'data', 'loads.json');

export function createLoadStore(path = DEFAULT_PATH) {
  let loads = [];
  if (existsSync(path)) {
    loads = JSON.parse(readFileSync(path, 'utf8'));
  }
  const save = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(loads, null, 2));
  };

  return {
    list: () => [...loads],
    get: (id) => loads.find((l) => l.id === id),
    create(attrs, now = new Date()) {
      const required = ['origin', 'destination', 'commodity', 'rate', 'carrierDot'];
      const missing = required.filter((k) => !attrs[k]);
      if (missing.length > 0) {
        throw new Error(`Load is missing required field(s): ${missing.join(', ')}`);
      }
      const id = `L-${String(loads.length + 1).padStart(4, '0')}`;
      const load = {
        id,
        status: 'Booked',
        createdAt: now.toISOString(),
        origin: attrs.origin,
        destination: attrs.destination,
        commodity: attrs.commodity,
        weightLbs: attrs.weightLbs ?? null,
        rate: Number(attrs.rate),
        carrierDot: String(attrs.carrierDot),
        pickupDate: attrs.pickupDate ?? null,
        deliveryDate: attrs.deliveryDate ?? null,
        notes: attrs.notes ?? '',
      };
      loads.push(load);
      save();
      return load;
    },
    setStatus(id, newStatus) {
      const load = loads.find((l) => l.id === id);
      if (!load) throw new Error(`No load with id ${id}`);
      if (!LOAD_STATUSES.includes(newStatus)) {
        throw new Error(`Unknown load status "${newStatus}". Valid: ${LOAD_STATUSES.join(', ')}`);
      }
      if (!NEXT[load.status].includes(newStatus)) {
        throw new Error(
          `Illegal transition ${load.status} -> ${newStatus}. Allowed next: ` +
            (NEXT[load.status].join(', ') || '(terminal)')
        );
      }
      load.status = newStatus;
      load[`${newStatus.toLowerCase().replace(/\s+/g, '_')}_at`] = new Date().toISOString();
      save();
      return load;
    },
  };
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const store = createLoadStore();
  if (command === 'list' || command === undefined) {
    for (const l of store.list()) {
      log(`${l.id}  ${l.status.padEnd(10)}  ${l.origin} -> ${l.destination}  ` +
        `${l.commodity}  $${l.rate}  DOT ${l.carrierDot}`);
    }
    if (store.list().length === 0) log('No loads yet. Use `node tms/loads.js create --help`.');
  } else if (command === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        origin: { type: 'string' },
        destination: { type: 'string' },
        commodity: { type: 'string' },
        weight: { type: 'string' },
        rate: { type: 'string' },
        'carrier-dot': { type: 'string' },
        pickup: { type: 'string' },
        delivery: { type: 'string' },
        notes: { type: 'string' },
      },
    });
    const load = store.create({
      origin: values.origin,
      destination: values.destination,
      commodity: values.commodity,
      weightLbs: values.weight ? Number(values.weight) : null,
      rate: values.rate,
      carrierDot: values['carrier-dot'],
      pickupDate: values.pickup,
      deliveryDate: values.delivery,
      notes: values.notes,
    });
    log(`Created ${load.id} (${load.status}).`);
  } else if (command === 'status') {
    const [id, newStatus] = rest;
    const load = store.setStatus(id, newStatus);
    log(`${load.id} -> ${load.status}`);
  } else {
    console.error(`Unknown command "${command}". Use: list | create | status`);
    process.exit(1);
  }
}
