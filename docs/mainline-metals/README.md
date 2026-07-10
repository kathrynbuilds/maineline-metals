# Mainline Metals — Lane Research & Carrier Capacity Deliverables

Produced 2026-07-10 by the Genesis TMS automation project. Three deliverables:

| File | What it is |
|---|---|
| `mainline-metals-research-brief.md` | Freight-network profile of Mainline Metals (locations, products, inbound/outbound, lane map, load characteristics), every claim cited and flagged Confirmed vs. Inference |
| `carriers-lane-capacity.csv` | 58 flatbed carriers positioned for the Blytheville AR → Atlanta GA corridor and spoke lanes, tiered A/B/C, 20 columns |
| `carrier-base-strategy.md` | Strategy memo: honest critique of the BCC rate-blast plan, tiered call-first outreach with a pre-award honesty script, retention mechanics, fraud controls, weekly 2-person cadence |

## Summary counts (carriers-lane-capacity.csv)

- **Total: 58** — Tier A: 10 · Tier B: 16 · Tier C: 32
- **By state:** TN 18 · AL 12 · AR 11 · GA 7 · MS 5 · MO 2 · KY 1 · OH 1 · PA 1
- **Coil/steel evidence (Y):** 45 of 58
- **DOT number identified:** 32 of 58 (the rest need a lookup before outreach — noted per row)
- **Contact info:** 5 phones, 1 email — all from public directories/company sites, **all unverified**. 53 rows have no contact info yet; blanks are deliberate (see Data integrity below).
- **Existing relationships included:** 4 Airtable seed carriers (Tweedy, Harold Bibbs & Sons, Equity of Arkansas, Taylor Transport) + 2 lane-relevant Active carriers (Ronnie Bledsoe, BEC Transport), marked in Notes.

## Why 58 and not 100 — the honest gap

The project brief asked for 100 carriers and anticipated FMCSA census data as the primary source. **This session's environment blocked every FMCSA/DOT data source** (`data.transportation.gov`, `safer.fmcsa.gov`, `mobile.fmcsa.dot.gov`, and general web fetching — network-policy 403s), and no `FMCSA_WEBKEY` was configured. The only working research tool was web search (snippets, no page fetches).

Under the brief's own rule — *"deliver what qualifies and explain the gap rather than padding with weak fits"* — 58 web-sourced, individually identified carriers beats 100 rows padded with fabricated or memory-guessed data. Every row traces to a specific public source captured in the Source column.

**To close the gap to 100+:** run the census pipeline below; the repo's filter (`carriers/filter-carrier-census.js`) typically yields hundreds of matches for AR/TN/MS/GA/AL at 5–50 power units with the metal-coil cargo flag.

## Data sources & integrity rules applied

- Web search only (retrieved 2026-07-10): carrier directory sites (QuickTransportSolutions, CarrierSource, LoadWrap, bubba.ai, carriernetwork.ai, roserocket), company websites, trade press, plus the existing Airtable base for seeds.
- **Nothing fabricated.** No MC/DOT/phone/email was written from model memory; blank cells mean "not found in a source." Directory-sourced phones/emails are flagged unverified.
- **Authority Status and Safety Rating columns are NOT verified** — they restate directory claims and say so. The `Verified Date` column is intentionally empty for every row: no FMCSA verification was possible this session, and per the system's hard rules no carrier may be dispatched (or promoted) until it passes.
- Known data-quality flags are carried in Notes rather than silently dropped: BEC Transport DOT mismatch, Harold Bibbs domicile discrepancy (MO vs. AR), Utley and Tweedy carrier-vs-brokerage entity twins, A C Wright's below-threshold insurance listing, one directory equipment count that is obviously erroneous.

## Verification runbook (do this before any outreach → dispatch)

1. **Enable data access** (either): add `data.transportation.gov`, `mobile.fmcsa.dot.gov`, `safer.fmcsa.gov` to this environment's network allowlist, or run locally with a `.env` containing `FMCSA_WEBKEY` (and `AIRTABLE_PAT`).
2. **Top up the list from the census:** `npm run refresh-census -- --states AR,TN,MS,GA,AL --dry-run` (then without `--dry-run` to upsert into Airtable as Researched).
3. **Verify authority:** import the CSV's carriers into Airtable (Status=Researched, Source=Web), then `npm run verify-carriers` — QCMobile check, auto-demotes not-authorized/OOS to Do Not Use, stamps Authority Verified Date. Tier A first.
4. **Manual SAFER snapshot for every Tier A carrier** before call #1 (authority, safety rating, insurance on file), and resolve the flagged rows: BEC's DOT, Bibbs' domicile, the Utley/Tweedy operating entities.
5. Dispatch gating stays as-is: Packet Complete/Active + Confirmed No Exclusion + W-9/COI/BCA + authority ≤30 days — `carriers/dispatch-gate.js` enforces this and nothing in these deliverables changes it.

## Known limitations

- Distances are straight-line (haversine) from Blytheville, rounded to 10 mi — road miles run ~15–20% longer.
- Fleet counts from directories may count trailers or stale MCS-150 data; treat as order-of-magnitude.
- Several Tier C rows have a name + state but no city/DOT yet (flagged) — resolve before contacting.
- Mainline Metals' actual lane volumes are inferred, not confirmed; the research brief's §7 lists the open questions to resolve on the qualification call.
- No XLSX was produced (zero-dependency repo policy; the CSV opens cleanly in Excel/Sheets).
