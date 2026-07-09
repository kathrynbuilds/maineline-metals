import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoadStore } from '../tms/loads.js';

const tmpStore = () => createLoadStore(join(mkdtempSync(join(tmpdir(), 'genesis-loads-')), 'loads.json'));

const attrs = {
  origin: 'Blytheville, AR',
  destination: 'Atlanta, GA',
  commodity: 'Steel coils',
  rate: 1850,
  carrierDot: '1234567',
};

test('loads are created as Booked and persist', () => {
  const store = tmpStore();
  const load = store.create(attrs);
  assert.equal(load.id, 'L-0001');
  assert.equal(load.status, 'Booked');
  assert.equal(store.get('L-0001').origin, 'Blytheville, AR');
});

test('lifecycle moves forward only', () => {
  const store = tmpStore();
  const { id } = store.create(attrs);
  store.setStatus(id, 'Dispatched');
  store.setStatus(id, 'In Transit');
  store.setStatus(id, 'Delivered');
  store.setStatus(id, 'Invoiced');
  store.setStatus(id, 'Paid');
  assert.equal(store.get(id).status, 'Paid');
  assert.throws(() => store.setStatus(id, 'Booked'), /Illegal transition/);
});

test('illegal jumps and unknown statuses are rejected', () => {
  const store = tmpStore();
  const { id } = store.create(attrs);
  assert.throws(() => store.setStatus(id, 'Delivered'), /Illegal transition/);
  assert.throws(() => store.setStatus(id, 'Teleported'), /Unknown load status/);
  assert.throws(() => store.create({ origin: 'x' }), /missing required field/);
});
