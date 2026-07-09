# Genesis TMS — Carrier Capacity System

Zero-dependency Node.js TMS and carrier pipeline for Genesis Logistics Group,
LLC (Georgia flatbed brokerage — steel coils, sheet, plate, structural;
MC-48921257 / USDOT 7336402). Strategy: pre-qualify coil-experienced flatbed
carriers per corridor **before** pitching shippers. First corridor:
Blytheville, AR ↔ Atlanta, GA.

Airtable base **Genesis Logistics CRM** (`app2iq77VubxkxxzE`) stays the
canonical carrier database; everything here reads/writes it via the REST API.

## Setup

Requires Node ≥ 22. No `npm install` needed — there are no dependencies.

```
cp .env.example .env   # fill in AIRTABLE_PAT (+ FMCSA_WEBKEY, ANTHROPIC_API_KEY later)
npm test               # everything runs against mocks; no secrets needed
```

## Phase 1 — Census refresh

Refresh the carrier prospect pool from the FMCSA Company Census
(data.transportation.gov dataset `az4n-8mr2`):

```
npm run refresh-census -- --dry-run --limit 25      # always dry-run first
npm run refresh-census -- --batch "Blytheville-Atlanta (origin)"
```

- Filters: AR/TN/MS/GA/AL domicile (override `--states`), 5–50 power units,
  interstate, "Metal: sheets, coils, rolls" cargo class, MCS-150 filed within
  24 months.
- Upserts into the Carriers table keyed on DOT Number. New records enter at
  Status = Researched, Source = FMCSA Census. Existing records: blank fields
  filled only; conflicting values are appended to Notes, never overwritten;
  Status / Source / Lane Batch are never touched.
- If the SODA API route fails (it prints the fallback instructions), download
  the census CSV from the DOT Open Data Portal and run:
  `npm run refresh-census -- --csv /path/to/census.csv`
- `carriers/filter-carrier-census.js` is also a standalone streaming filter:
  `node carriers/filter-carrier-census.js census.csv --out filtered.jsonl`.
  Both routes auto-detect legacy MCMIS vs MOTUS-era column names and print
  the mapping they chose.

## Phase 2 — Authority verification

Continuous SAFER-grade verification via the FMCSA QCMobile API (get a free
webkey at https://mobile.fmcsa.dot.gov/QCDevsite/ → `FMCSA_WEBKEY` in `.env`):

```
npm run verify-carriers -- --provision   # first run only: creates the three
                                         # authority fields on the Carriers
                                         # table (PAT needs schema.bases:write)
npm run verify-carriers                  # daily/weekly run
npm run verify-carriers -- --force       # ignore the 30-day freshness skip
```

- Checks every carrier with Status Researched → Active and writes
  **Authority Status** (Active / Inactive / Not Found / Error),
  **Authority Verified Date**, and **OOS Flag** (fields are resolved by name
  at runtime, so it's fine that they were provisioned per-base).
- Inactive authority or out-of-service → Status = **Do Not Use** with a
  timestamped explanation in Notes. This is the only automated status change
  in the whole system, and it only moves carriers down.
- "Not Found" DOTs are flagged in Notes as a possible fraud signal but left
  for human review; API errors touch nothing and retry next run.
- Results are cached in `.cache/authority.json`; anything verified within
  30 days is skipped unless `--force`. Supports `--dry-run` and `--limit N`.

## Phase 3 — TMS, dispatch gate, carrier packets

Minimal load tracking + the rate confirmation generator with the hard
dispatch gate in front of it:

```
node tms/loads.js create --origin "Blytheville, AR" --destination "Atlanta, GA" \
  --commodity "Steel coils" --weight 47500 --rate 1850 --carrier-dot 1234567 \
  --pickup 2026-07-14
node tms/rate-confirmation.js L-0001    # fetches the carrier live from Airtable
node carriers/packet-assembler.js 1234567
npm run dashboard                        # http://localhost:8642
```

- **Dispatch gate** (`carriers/dispatch-gate.js`): rate-con generation
  hard-fails unless Status is Packet Complete/Active, Coil Exclusion Status
  is "Confirmed No Exclusion", W-9 + COI + signed BCA are on file, and the
  FMCSA authority verification is ≤ 30 days old. Every failure is listed
  with its own message; an OOS flag or non-Active authority also blocks.
- **Packet assembler** drafts whichever of the three packet emails are still
  missing — W-9 request, BCA cover, and the COI request addressed to the
  **insurance producer** (never the carrier, per the fraud SOP) — into the
  approval queue: an Airtable Activity with Email Status = Draft plus a file
  in `outbox/`. Nothing is ever sent by the system.
- Loads live in `data/loads.json` (git-ignored) with a forward-only
  lifecycle: Booked → Dispatched → In Transit → Delivered → Invoiced → Paid.

## Phase 4 — Carrier email intake loop

Inbound replies land as raw `.eml` files in `inbox-drop/` via either adapter
(pick one):

```
node carriers/email-intake/imap-poller.js       # polls IMAP_* inbox for UNSEEN mail
node carriers/email-intake/webhook-receiver.js  # or: inbound-parse webhook on :8643
                                                # (requires INTAKE_WEBHOOK_TOKEN)
npm run intake                                  # classify + extract + update CRM
npm run followups                               # run daily: cadence engine
```

- `npm run intake` matches each message to a carrier (sender email, then a
  DOT/MC number in the body — unmatched mail is quarantined in
  `inbox-drop/unmatched/`, never guessed), then calls the Claude API
  (`ANTHROPIC_API_KEY`, model `claude-sonnet-5`) to classify the reply
  (interested / declined / questions / out-of-office / other) and extract
  intake answers: trailer types, coil racks, tarps, securement, 48K
  capability, cargo limit, new-MC acceptance, payment preference, factoring
  company, rate range, core lanes, trucks/week.
- CRM effects: blank fields filled only (conflicts to Notes), Contacted →
  Responded on a real reply (out-of-office doesn't count), an Activity per
  message with the raw email body, a "Confirm coil exclusion with producer"
  task for any Responded+ carrier still at Not Verified, and an urgent
  fraud-review task when the stated factoring company conflicts with the
  value on file.
- `npm run followups`: day-3 and day-8 bump drafts for silent Contacted
  carriers, Status = Declined after 15 days of silence (noted in Notes), and
  a day-2 packet reminder for responders with missing W-9/COI/BCA. Every
  email is a draft in `outbox/` + Airtable (Email Status = Draft) — nothing
  ever auto-sends.

## Invariants (see CLAUDE.md for the full list)

1. No dispatch without verification — the rate-con generator hard-fails on
   any unverified carrier.
2. No auto-send — drafted outreach goes to the approval queue only.
3. Automation never overwrites human-entered CRM data.
4. Census/API data is prospecting data; only humans move carriers up the
   pipeline.
5. Secrets live in `.env` (git-ignored) only.

## Tests

`npm test` — node:test suite; Airtable, SODA, FMCSA, and Claude calls are all
mocked, so the suite runs anywhere without credentials.
