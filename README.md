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
