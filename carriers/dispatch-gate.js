// Phase 3: the dispatch gate — invariant 1, encoded.
//
// Rate confirmation generation MUST hard-fail unless:
//   Status ∈ {Packet Complete, Active}
//   AND Coil Exclusion Status = "Confirmed No Exclusion"
//   AND W-9 Received AND COI Received AND BCA Signed
//   AND authority verification is ≤ 30 days old.
//
// evaluateDispatch is pure and reports EVERY failure with its own code and
// specific message so Kathryn sees the complete punch list at once.

import {
  CARRIER,
  STATUS,
  COIL_EXCLUSION,
  AUTHORITY_STATUS,
} from './schema.js';
import {
  isVerificationFresh,
  VERIFICATION_MAX_AGE_DAYS,
} from './verify-authority.js';

export const GATE = {
  STATUS_NOT_DISPATCHABLE: 'STATUS_NOT_DISPATCHABLE',
  COIL_EXCLUSION_UNCONFIRMED: 'COIL_EXCLUSION_UNCONFIRMED',
  W9_MISSING: 'W9_MISSING',
  COI_MISSING: 'COI_MISSING',
  BCA_UNSIGNED: 'BCA_UNSIGNED',
  VERIFICATION_STALE: 'VERIFICATION_STALE',
  AUTHORITY_NOT_ACTIVE: 'AUTHORITY_NOT_ACTIVE',
};

const DISPATCHABLE_STATUSES = [STATUS.PACKET_COMPLETE, STATUS.ACTIVE];

/**
 * Map a raw Airtable carrier record's fields to the logical view the gate
 * (and rate-con generator) consumes. authorityFieldIds comes from
 * resolveAuthorityFields() since those three fields are per-base.
 */
export function carrierRecordToView(fields, authorityFieldIds = {}) {
  return {
    carrierName: fields[CARRIER.carrierName],
    dba: fields[CARRIER.dba],
    mcNumber: fields[CARRIER.mcNumber],
    dotNumber: fields[CARRIER.dotNumber],
    status: fields[CARRIER.status],
    coilExclusionStatus: fields[CARRIER.coilExclusion],
    w9Received: Boolean(fields[CARRIER.w9Received]),
    coiReceived: Boolean(fields[CARRIER.coiReceived]),
    bcaSigned: Boolean(fields[CARRIER.bcaSigned]),
    cargoLimit: fields[CARRIER.cargoLimit],
    phone: fields[CARRIER.phone],
    email: fields[CARRIER.email],
    dispatchContact: fields[CARRIER.dispatchContact],
    authorityStatus: authorityFieldIds.authorityStatus
      ? fields[authorityFieldIds.authorityStatus]
      : undefined,
    authorityVerifiedDate: authorityFieldIds.authorityVerifiedDate
      ? fields[authorityFieldIds.authorityVerifiedDate]
      : undefined,
    oosFlag: authorityFieldIds.oosFlag
      ? Boolean(fields[authorityFieldIds.oosFlag])
      : undefined,
  };
}

/**
 * @param {object} carrier logical view (see carrierRecordToView)
 * @returns {{ ok: boolean, failures: Array<{code: string, message: string}> }}
 */
export function evaluateDispatch(carrier, { now = new Date() } = {}) {
  const failures = [];
  const name = carrier.carrierName ?? 'carrier';

  if (!DISPATCHABLE_STATUSES.includes(carrier.status)) {
    failures.push({
      code: GATE.STATUS_NOT_DISPATCHABLE,
      message:
        `Status is "${carrier.status ?? '(none)'}" — dispatch requires ` +
        `"${STATUS.PACKET_COMPLETE}" or "${STATUS.ACTIVE}". Complete vetting first.`,
    });
  }

  if (carrier.coilExclusionStatus !== COIL_EXCLUSION.CONFIRMED_NO_EXCLUSION) {
    const current = carrier.coilExclusionStatus ?? COIL_EXCLUSION.NOT_VERIFIED;
    const detail =
      current === COIL_EXCLUSION.COILS_EXCLUDED
        ? 'the cargo policy EXCLUDES coils — this carrier cannot haul coils, full stop.'
        : 'coil exclusion has not been confirmed in writing by the insurance producer.';
    failures.push({
      code: GATE.COIL_EXCLUSION_UNCONFIRMED,
      message: `Coil Exclusion Status is "${current}" — ${detail}`,
    });
  }

  if (!carrier.w9Received) {
    failures.push({
      code: GATE.W9_MISSING,
      message: 'W-9 not on file — request it before dispatch.',
    });
  }
  if (!carrier.coiReceived) {
    failures.push({
      code: GATE.COI_MISSING,
      message:
        'Certificate of Insurance not on file — request it directly from the ' +
        'insurance producer (never from the carrier).',
    });
  }
  if (!carrier.bcaSigned) {
    failures.push({
      code: GATE.BCA_UNSIGNED,
      message: 'Broker-Carrier Agreement not signed — no dispatch without a signed BCA.',
    });
  }

  if (!carrier.authorityVerifiedDate) {
    failures.push({
      code: GATE.VERIFICATION_STALE,
      message:
        'Authority has never been verified — run `npm run verify-carriers` ' +
        'and confirm FMCSA authority before dispatch.',
    });
  } else if (!isVerificationFresh(carrier.authorityVerifiedDate, now)) {
    failures.push({
      code: GATE.VERIFICATION_STALE,
      message:
        `Authority verification is stale (last verified ${carrier.authorityVerifiedDate}, ` +
        `limit ${VERIFICATION_MAX_AGE_DAYS} days) — re-run \`npm run verify-carriers\`.`,
    });
  }

  // Defense in depth beyond the four spec'd conditions: a fresh-but-bad
  // verification result must also block, even if a human moved Status up.
  if (carrier.oosFlag === true) {
    failures.push({
      code: GATE.AUTHORITY_NOT_ACTIVE,
      message: 'FMCSA lists this carrier OUT OF SERVICE — do not dispatch.',
    });
  } else if (
    carrier.authorityStatus !== undefined &&
    carrier.authorityStatus !== null &&
    carrier.authorityStatus !== AUTHORITY_STATUS.ACTIVE
  ) {
    failures.push({
      code: GATE.AUTHORITY_NOT_ACTIVE,
      message: `Authority Status is "${carrier.authorityStatus}" — only "Active" may dispatch.`,
    });
  }

  return { ok: failures.length === 0, failures, carrierName: name };
}

/** Throw a single error listing every gate failure. */
export function assertDispatchable(carrier, opts = {}) {
  const result = evaluateDispatch(carrier, opts);
  if (!result.ok) {
    const lines = result.failures.map((f) => `  - [${f.code}] ${f.message}`);
    const err = new Error(
      `DISPATCH BLOCKED for ${result.carrierName} (${result.failures.length} issue(s)):\n` +
        lines.join('\n')
    );
    err.failures = result.failures;
    throw err;
  }
  return result;
}
