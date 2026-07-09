import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateDispatch,
  assertDispatchable,
  carrierRecordToView,
  GATE,
} from '../carriers/dispatch-gate.js';
import { STATUS, COIL_EXCLUSION, AUTHORITY_STATUS, CARRIER } from '../carriers/schema.js';

const NOW = new Date('2026-07-09T12:00:00Z');

/** A carrier that passes every gate check. */
function qualifiedCarrier(overrides = {}) {
  return {
    carrierName: 'OZARK STEEL HAULERS LLC',
    status: STATUS.PACKET_COMPLETE,
    coilExclusionStatus: COIL_EXCLUSION.CONFIRMED_NO_EXCLUSION,
    w9Received: true,
    coiReceived: true,
    bcaSigned: true,
    authorityStatus: AUTHORITY_STATUS.ACTIVE,
    authorityVerifiedDate: '2026-07-01',
    oosFlag: false,
    ...overrides,
  };
}

function failureCodes(carrier) {
  return evaluateDispatch(carrier, { now: NOW }).failures.map((f) => f.code);
}

test('fully qualified carrier passes the gate (Packet Complete and Active)', () => {
  assert.equal(evaluateDispatch(qualifiedCarrier(), { now: NOW }).ok, true);
  assert.equal(
    evaluateDispatch(qualifiedCarrier({ status: STATUS.ACTIVE }), { now: NOW }).ok,
    true
  );
});

test('acceptance: each failure mode blocks independently with a distinct message', () => {
  const cases = [
    {
      name: 'wrong status',
      carrier: qualifiedCarrier({ status: STATUS.VETTED }),
      code: GATE.STATUS_NOT_DISPATCHABLE,
      messageMatch: /Status is "Vetted"/,
    },
    {
      name: 'coil exclusion not confirmed',
      carrier: qualifiedCarrier({ coilExclusionStatus: COIL_EXCLUSION.NOT_VERIFIED }),
      code: GATE.COIL_EXCLUSION_UNCONFIRMED,
      messageMatch: /not been confirmed in writing by the insurance producer/,
    },
    {
      name: 'coils excluded outright',
      carrier: qualifiedCarrier({ coilExclusionStatus: COIL_EXCLUSION.COILS_EXCLUDED }),
      code: GATE.COIL_EXCLUSION_UNCONFIRMED,
      messageMatch: /EXCLUDES coils/,
    },
    {
      name: 'missing W-9',
      carrier: qualifiedCarrier({ w9Received: false }),
      code: GATE.W9_MISSING,
      messageMatch: /W-9 not on file/,
    },
    {
      name: 'missing COI',
      carrier: qualifiedCarrier({ coiReceived: false }),
      code: GATE.COI_MISSING,
      messageMatch: /directly from the insurance producer/,
    },
    {
      name: 'unsigned BCA',
      carrier: qualifiedCarrier({ bcaSigned: false }),
      code: GATE.BCA_UNSIGNED,
      messageMatch: /Broker-Carrier Agreement not signed/,
    },
    {
      name: 'stale verification',
      carrier: qualifiedCarrier({ authorityVerifiedDate: '2026-05-01' }),
      code: GATE.VERIFICATION_STALE,
      messageMatch: /stale \(last verified 2026-05-01/,
    },
    {
      name: 'never verified',
      carrier: qualifiedCarrier({ authorityVerifiedDate: undefined }),
      code: GATE.VERIFICATION_STALE,
      messageMatch: /never been verified/,
    },
  ];
  for (const c of cases) {
    const result = evaluateDispatch(c.carrier, { now: NOW });
    assert.equal(result.ok, false, `${c.name} must block`);
    assert.equal(result.failures.length, 1, `${c.name} is the only failure`);
    assert.equal(result.failures[0].code, c.code, c.name);
    assert.match(result.failures[0].message, c.messageMatch, c.name);
  }
  // every message is distinct
  const messages = cases.map(
    (c) => evaluateDispatch(c.carrier, { now: NOW }).failures[0].message
  );
  assert.equal(new Set(messages).size, messages.length);
});

test('verification exactly 30 days old still passes; 31 does not', () => {
  assert.equal(
    evaluateDispatch(qualifiedCarrier({ authorityVerifiedDate: '2026-06-09' }), { now: NOW }).ok,
    true
  );
  assert.deepEqual(
    failureCodes(qualifiedCarrier({ authorityVerifiedDate: '2026-06-08' })),
    [GATE.VERIFICATION_STALE]
  );
});

test('defense in depth: OOS flag or non-Active authority blocks even with packet complete', () => {
  assert.deepEqual(failureCodes(qualifiedCarrier({ oosFlag: true })), [GATE.AUTHORITY_NOT_ACTIVE]);
  assert.deepEqual(
    failureCodes(qualifiedCarrier({ authorityStatus: AUTHORITY_STATUS.INACTIVE })),
    [GATE.AUTHORITY_NOT_ACTIVE]
  );
  // unknown authority status (fields not provisioned) does not double-punish:
  // the stale-verification check already covers it
  const r = evaluateDispatch(
    qualifiedCarrier({ authorityStatus: undefined, oosFlag: undefined }),
    { now: NOW }
  );
  assert.equal(r.ok, true);
});

test('all failures are reported together, not just the first', () => {
  const hopeless = {
    carrierName: 'NOT READY LLC',
    status: STATUS.RESEARCHED,
    coilExclusionStatus: COIL_EXCLUSION.NOT_VERIFIED,
    w9Received: false,
    coiReceived: false,
    bcaSigned: false,
    authorityVerifiedDate: undefined,
  };
  const result = evaluateDispatch(hopeless, { now: NOW });
  assert.deepEqual(
    result.failures.map((f) => f.code).sort(),
    [
      GATE.BCA_UNSIGNED,
      GATE.COIL_EXCLUSION_UNCONFIRMED,
      GATE.COI_MISSING,
      GATE.STATUS_NOT_DISPATCHABLE,
      GATE.VERIFICATION_STALE,
      GATE.W9_MISSING,
    ].sort()
  );
  assert.throws(
    () => assertDispatchable(hopeless, { now: NOW }),
    (err) => {
      assert.match(err.message, /DISPATCH BLOCKED for NOT READY LLC \(6 issue\(s\)\)/);
      assert.match(err.message, /W-9 not on file/);
      assert.match(err.message, /Broker-Carrier Agreement not signed/);
      return true;
    }
  );
});

test('carrierRecordToView maps Airtable fields (incl. runtime authority fields)', () => {
  const fieldIds = {
    authorityStatus: 'fldA',
    authorityVerifiedDate: 'fldB',
    oosFlag: 'fldC',
  };
  const view = carrierRecordToView(
    {
      [CARRIER.carrierName]: 'X TRUCKING',
      [CARRIER.status]: STATUS.ACTIVE,
      [CARRIER.coilExclusion]: COIL_EXCLUSION.CONFIRMED_NO_EXCLUSION,
      [CARRIER.w9Received]: true,
      [CARRIER.coiReceived]: true,
      [CARRIER.bcaSigned]: true,
      fldA: AUTHORITY_STATUS.ACTIVE,
      fldB: '2026-07-01',
      fldC: false,
    },
    fieldIds
  );
  assert.equal(evaluateDispatch(view, { now: NOW }).ok, true);
  assert.equal(view.authorityVerifiedDate, '2026-07-01');
});
