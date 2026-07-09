# Genesis TMS — carrier capacity system

Custom TMS + carrier pipeline for Genesis Logistics Group, LLC (GA flatbed
brokerage, steel/metals; MC-48921257, USDOT 7336402). Airtable base
"Genesis Logistics CRM" (`app2iq77VubxkxxzE`) is the canonical carrier store;
this repo automates prospecting, verification, dispatch gating, and email
intake around it.

## Hard rules — never soften these

1. **No dispatch without verification.** Rate confirmation generation must
   hard-fail unless Status ∈ {Packet Complete, Active} AND Coil Exclusion
   Status = "Confirmed No Exclusion" AND W-9/COI/BCA all on file AND
   authority verification ≤ 30 days old (`carriers/dispatch-gate.js`).
2. **No auto-send.** Outbound email only ever lands in the approval queue
   (Airtable Activity with Email Status = Draft + `outbox/` file). The system
   never sends anything.
3. **Never overwrite human-entered data.** Automated upserts fill blank
   fields only; conflicts are appended to Notes
   (`diffBlankFillOnly` in `carriers/airtable-client.js`).
4. **Automation never promotes carriers.** Census/API data is prospecting
   data. The only automated status changes are demotions
   (verify-authority → Do Not Use; 15-day silence → Declined) and
   Contacted → Responded when a reply actually arrives.
5. **Secrets live in `.env` (git-ignored)**: `AIRTABLE_PAT`, `FMCSA_WEBKEY`,
   `ANTHROPIC_API_KEY`. Never hardcode or commit them.

## Conventions

- Zero-dependency Node ≥ 22, ESM (`"type": "module"`). Ask before adding any
  dependency.
- Airtable reads/writes go by **field ID** (`returnFieldsByFieldId=true`);
  all IDs and choice names live in `carriers/schema.js` only.
- All network I/O goes through `lib/http.js` (`createHttp`) so tests can
  inject `fetchImpl`/`sleep`; Airtable writes are batched at 10 records and
  throttled under 5 req/s per base.
- Tests: `npm test` (node:test, files in `test/*.test.js`); the in-memory
  Airtable fake is `test/helpers/mock-airtable.js`.
- FMCSA census column names drift (MCMIS → MOTUS migration through 2026):
  resolve columns via `resolveColumns()` in
  `carriers/filter-carrier-census.js`, never hardcode header names elsewhere.
- After each shipped phase, append a one-paragraph summary to
  `docs/ops-log.md`.

## Commands

- `npm run refresh-census -- [--dry-run] [--batch <label>] [--states AR,GA] [--limit N] [--csv path]`
- `npm run verify-carriers` (Phase 2)
- `npm run intake` / `npm run followups` (Phase 4)
- `npm run dashboard` (Phase 3)
- `npm test`
