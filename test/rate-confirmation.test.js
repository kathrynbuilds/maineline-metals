import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRateCon, BROKER } from '../tms/rate-confirmation.js';
import { STATUS, COIL_EXCLUSION, AUTHORITY_STATUS } from '../carriers/schema.js';

const NOW = new Date('2026-07-09T12:00:00Z');

const load = {
  id: 'L-0001',
  origin: 'Blytheville, AR',
  destination: 'Atlanta, GA',
  commodity: 'Steel coils (2x 23,750 lbs)',
  weightLbs: 47500,
  rate: 1850,
  carrierDot: '1234567',
  pickupDate: '2026-07-14',
  deliveryDate: '2026-07-15',
  notes: 'Coil racks required. Eye to the side.',
};

const readyCarrier = {
  carrierName: 'OZARK STEEL HAULERS LLC',
  mcNumber: '987654',
  dotNumber: '1234567',
  status: STATUS.ACTIVE,
  coilExclusionStatus: COIL_EXCLUSION.CONFIRMED_NO_EXCLUSION,
  w9Received: true,
  coiReceived: true,
  bcaSigned: true,
  authorityStatus: AUTHORITY_STATUS.ACTIVE,
  authorityVerifiedDate: '2026-07-01',
  oosFlag: false,
  dispatchContact: 'Randy',
  phone: '870-555-0101',
  email: 'dispatch@ozarksteel.example',
};

test('a verified carrier gets a complete rate confirmation', () => {
  const text = generateRateCon({ load, carrier: readyCarrier, now: NOW });
  assert.match(text, /RATE CONFIRMATION/);
  assert.match(text, new RegExp(BROKER.mc));
  assert.match(text, /USDOT 7336402/);
  assert.match(text, /OZARK STEEL HAULERS LLC/);
  assert.match(text, /MC-987654 \/ DOT 1234567/);
  assert.match(text, /Blytheville, AR/);
  assert.match(text, /\$1,850\.00/);
  assert.match(text, /verified 2026-07-01 \(FMCSA QCMobile\)/);
  assert.match(text, /photo ID at pickup/);
});

test('invariant 1: generation hard-fails for an unverified carrier, listing every issue', () => {
  const notReady = {
    ...readyCarrier,
    status: STATUS.RESPONDED,
    coilExclusionStatus: COIL_EXCLUSION.NOT_VERIFIED,
    bcaSigned: false,
  };
  assert.throws(
    () => generateRateCon({ load, carrier: notReady, now: NOW }),
    (err) => {
      assert.match(err.message, /DISPATCH BLOCKED/);
      assert.match(err.message, /Status is "Responded"/);
      assert.match(err.message, /Coil Exclusion Status is "Not Verified"/);
      assert.match(err.message, /Broker-Carrier Agreement not signed/);
      assert.equal(err.failures.length, 3);
      return true;
    }
  );
});

test('acceptance (phase 2/3): a stale authority verification blocks the rate con', () => {
  const stale = { ...readyCarrier, authorityVerifiedDate: '2026-04-01' };
  assert.throws(
    () => generateRateCon({ load, carrier: stale, now: NOW }),
    /stale \(last verified 2026-04-01, limit 30 days\)/
  );
});

test('a coils-excluded policy blocks even a fully-papered Active carrier', () => {
  const excluded = { ...readyCarrier, coilExclusionStatus: COIL_EXCLUSION.COILS_EXCLUDED };
  assert.throws(() => generateRateCon({ load, carrier: excluded, now: NOW }), /EXCLUDES coils/);
});
