# Carrier Base Strategy — Building Lane-Dedicated Flatbed Capacity as a New Metals Broker

**For:** Genesis Logistics Group, LLC (2-person team)
**Anchor lane:** Blytheville, AR → Atlanta/Acworth, GA (~400 mi)
**Date:** 2026-07-10

---

## 1. Honest evaluation of the proposed approach (big list + BCC rate blast)

**What it gets right:** you need a list, you need rate intelligence, and email scales. Building the list is unambiguously correct — that work is done (58 carriers, tiered).

**Where it fails, concretely:**

- **How carriers read it.** Small flatbed fleets get dozens of broker blasts a week. An email from an unknown MC asking "what would you charge for a coil load Blytheville→Atlanta?" pattern-matches to (a) a broker with no freight fishing for rates to build a shipper pitch — which is exactly what we are — or (b) a double-brokering scam probing for targets. Dispatchers at the carriers we most want (10–50 trucks, coil-experienced, busy) are the least likely to answer. The ones who answer blasts fastest are disproportionately the desperate and the fraudulent — an adverse-selection machine.
- **Response rates.** Cold B2B email to dispatch inboxes realistically returns low single-digit percentages; a 100-carrier BCC blast might produce 3–8 replies, several of them junk. That is not a capacity base; it's noise with a spam-complaint tail.
- **The BCC itself.** One address-line mistake (CC instead of BCC) leaks your entire prospect list — your actual work product — to every recipient. Even done correctly, identical boilerplate trips spam filters, and a brand-new domain sending 100 identical emails in an hour can get the domain blacklisted before the business has sent its first rate con.
- **Rates from blasts aren't capacity.** A number typed in reply to a hypothetical is an opening position with zero commitment: no truck, no date, no driver, no coil racks confirmed. Quoting a shipper off those numbers builds the pitch on sand — the first real tender will discover the real market. If you need a rate band for the pitch, DAT/Greenscreens-style lane data plus 5 phone conversations with Tier A carriers beats 100 emailed guesses.
- **Fraud exposure.** Publishing "new brokerage seeks carriers, here's our MC" to 100 unvetted inboxes invites identity harvesters. Replies claiming to be a listed carrier may not be — reply-to spoofing against rate blasts is a standard double-brokering entry vector.

**Verdict:** keep the list, kill the blast as the *opening* move. A narrow version survives below as a Tier-C-only instrument, correctly labeled as market research rather than capacity building.

## 2. Recommended sequence: tiered, honest, call-first

**Tier A (10 carriers — personal phone calls, ~2 weeks).**
One call per carrier per week max. Call dispatch at the number *we sourced independently* (directory/FMCSA — never a number from an inbound email; the sheet's phones are flagged unverified until cross-checked). Goal of call #1 is not a rate — it's qualification + a relationship opening: coil experience, racks/chains/tarps or Conestoga, trucks/week that touch the corridor, rate expectations *offered voluntarily*, dispatch contact name, preferred contact channel.

**The pre-award honesty script — this matters more than anything else in this memo.** We do not have this freight yet, and implying otherwise burns the exact carriers we need to keep. Working script:

> "We're Genesis Logistics, a new flatbed brokerage that only does steel and metals — I'll be straight with you, we're pre-qualifying capacity on Blytheville-to-Atlanta *before* we sign the shipper, because we pitch proven trucks instead of promises. I'm not offering you a load today. What I'm asking is: if we land steady coil freight on that lane at a market rate, are you the kind of fleet that wants 2–3 committed loads a week, and what would that need to look like for you?"

Honesty here is also a *filter*: carriers who stay on the phone after "I'm not offering you a load today" are relationship-builders — precisely the retention profile in §3. And when the shipper freight does land, the callback ("remember me? we got it") converts at a rate no cold offer ever will. The same call flags problems early: BEC Transport's DOT mismatch and A C Wright's below-threshold insurance listing (see sheet notes) are exactly what call #1 resolves.

**Tier B (16 — personalized email, then call the responders.)** One at a time (no BCC), 4–6 sentences, referencing something true about *them* ("you're in Booneville running coils up US-45..."), same pre-award honesty, one question, one ask (15-minute call). Send 5–8/day from the working inbox — human volume, human text. Per the system's hard rule, every outbound drafts to the approval queue; nothing auto-sends.

**Tier C (32 — the rate-discovery email, correctly scoped.)** Once — and only once — Tier A calls have produced a real rate band, a short individually-addressed note to Tier C is acceptable *as market research*: "we're building a dedicated-lane program, Blytheville→Atlanta coil freight, ~46k coils, tarped; if you run this corridor, what's your all-in number and how many trucks/week could you commit?" Expect little; treat replies as leads to vet, not capacity. Never quote the shipper off Tier C numbers alone.

**Sequencing with the shipper pitch:** Tier A calls (weeks 1–2) → rate band + 5–8 verbally committed fleets → pitch Mainline's traffic contacts at Blytheville (870-763-3000) and Acworth (770-917-9000) with named, verified capacity → on award, first tenders go to the carriers who took the honest call.

## 3. Retention: what makes a small fleet loyal to a small broker

A 15-truck coil fleet doesn't need another broker; it needs a *better week*. Loyalty levers, in rough order of power:

1. **Consistency beats rate.** 2 committed loads/week every week outranks a hot spot rate once. Publish a weekly schedule as soon as volume exists; let carriers plan drivers around it.
2. **Fast pay, no games.** Quickpay (1–2 day, 1.5–2%) or net-15 standard, zero "lost invoice" friction. For fleets running factoring (many will — the sheet's factoring-mismatch fraud check stays), being the broker whose paperwork never bounces is a moat.
3. **Coil-competent ops.** Correct weights on the rate con, securement/tarp requirements stated up front, no surprise re-tarps, appointment windows that reflect mill reality. Steel carriers rank brokers by whether dispatch "speaks coil." Our niche *is* the differentiator — act like it.
4. **No detention games.** Publish the detention clock (e.g., 2 hours free, then $X/hr, no argument under $150) and pay it unprompted. Word travels fast in a 400-mile corridor.
5. **Direct dispatch relationships.** Same two humans every time, cell numbers exchanged, no portal-only communication. The Airtable/TMS is our memory (racks, tarp sizes, coil weight limits, preferred days per carrier — fields already exist), so every call starts warm.
6. **Backhaul awareness.** L1 carriers with an Atlanta-area return load quote cheaper and stay longer. Even before Genesis books backhauls, knowing who covers them (and eventually adding an ATL→Memphis/Blytheville board) strengthens the round trip.

## 4. Fraud protection at onboarding scale

Aligned with the vetting SOP and what's already enforced in the Genesis system (dispatch gate; producer-direct COI; factoring mismatch checks):

- **Authority & age:** verify MC/DOT directly against FMCSA (SAFER/QCMobile) at onboarding and re-verify ≤30 days before first dispatch — the system already hard-fails dispatch without this. MC younger than 6–12 months = enhanced screening (the sheet flags one: Dalton Truck Industries, authority Jan 2023).
- **Insurance certs from the producer only.** COI requested from the insurance agency, never accepted from the carrier's inbox. Confirm $1M auto liability and cargo appropriate to 48k steel ($100k+ with **no metals/coil exclusion** — the Coil Exclusion Status gate already blocks dispatch without "Confirmed No Exclusion").
- **Phone cross-checks:** call back on the FMCSA-registered or independently sourced number before the first tender. Never onboard purely over email; never use contact info supplied in an inbound reply as the verification channel.
- **Identity consistency:** W-9 legal name = FMCSA legal name = COI insured = factoring NOA. Any mismatch is a stop (the email-intake system already opens fraud tasks on factoring mismatches). Note the two entity traps already in the sheet: Utley Inc vs Utley Logistics, and Tweedy Transport vs Tweedy Transport Logistics (carrier vs brokerage affiliates) — always contract with the entity that holds *carrier* authority.
- **At pickup: driver photo ID + truck/trailer plate photographed and matched to the onboarded carrier** before the BOL is signed — the single most effective double-brokering kill switch. Dispatcher confirms driver name/cell with the carrier's known dispatch line the morning of pickup.
- **No load boards for the anchor lane** while the program is small: every truck comes off the vetted list. Double-brokering enters through the "just cover it" moment; a dedicated lane never needs it.
- **Mill-site readiness as a quality signal:** Nucor requires carriers to sign its master contract and meet insurance/safety/PPE rules for mill pickup ([nucor.com/transportation-logistics](https://nucor.com/transportation-logistics/)). Asking "are you Nucor-approved?" on call #1 both qualifies for L6/L1 mill work and smokes out pretenders.

## 5. Weekly cadence for a 2-person team (pre-award phase)

**Person 1 — Calls (relationship owner).** Mon: 4–5 Tier A calls (new + follow-ups). Tue: 4–5 more; log every fact in Airtable same-day. Wed: callbacks + Tier B responders. Thu: 3–4 calls + update tier assignments (promote/demote on evidence). Fri: 30-min review — who moved, who's silent (15-day silence auto-declines per system), next week's call list.

**Person 2 — Ops/systems (verification owner).** Mon: queue the week's Tier B emails into the approval queue; approve/send Tue–Thu mornings. Tue: FMCSA verification runs on everyone touched last week (once web access/webkey available — see README runbook); chase COIs producer-direct. Wed: Airtable hygiene — dedupe, DOT/MC fills from calls, packet status. Thu: rate intelligence (DAT lane pulls, call notes → rate band memo). Fri: metrics — calls made, connects, qualified fleets, packets complete, Tier A coverage vs. the 8–10 target.

**Weekly targets that matter:** 8–12 meaningful carrier conversations, 2–3 new fully-vetted packets, 1 rate-band update, zero unverified carriers promoted (the system enforces this; don't fight it).

---

### Bottom line

The list is an asset; the blast is a liability. Call the ten best carriers, tell them the truth, verify everything through FMCSA and producers, and let consistency + fast pay + coil-literate ops do the retention work. A new broker's only durable edge on a dense steel lane is being *the easiest 400 miles in the carrier's week*.
