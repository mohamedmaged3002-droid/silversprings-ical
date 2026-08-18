# silversprings-ical

**Silver Springs Residence** — serviced apartments in the Silver Palm compound, New Cairo City.
Operator #12. Forked from `almaza-ical/` on 2026-08-18 (same PMS, same three-endpoint shape).

Scrapes the operator's Lodgify site → per-unit `.ics` on GitHub Pages → wired into Supabase
`listing_ical`, plus content/rates for `units` + `unit_daily_prices` and the OTA listing pack.

```
silverspringsresidence.com (Lodgify 479059)
  ├── JSON-LD on /en/{slug}          → content, photos, amenities, geo
  ├── websiteserver…/rates/…         → roomId, defaultRate, named periods   (throttled)
  └── checkout…/checkout/calendar    → per-date availability + minimalStay  (throttled)
        ↓
  docs/{wp}.ics + docs/index.json + docs/links.csv   (GitHub Pages)
        ↓
  Supabase listing_ical / units / unit_daily_prices
```

## Status

| Stage | State |
|---|---|
| Fingerprint | ✅ verified live 2026-08-18 |
| Roster discovery | ✅ 45/45, reconciled against the site's "45 Results" |
| Content + rates scrape | ⏳ in progress |
| Photos → R2 + `_w800`/`_w1600` derivatives | ☐ |
| EN + AR copy | ☐ |
| Units → Supabase (drafts, 96001–96045) | ☐ |
| Prices → `unit_daily_prices` | ☐ |
| iCal generate + wire | ☐ |
| OTA listing pack | ☐ blocked — see "Open questions" |
| Publish | ☐ **gated**: no unit goes live without a working feed |

## Fingerprint (verified live, 2026-08-18)

```
WEBSITE_ID   479059
tenant slug  silversprings          (from the checkout URL)
ORIGIN       https://silverspringsresidence.com
roster       /en/properties/        → 45 Results
unit URL     /en/{slug}             ← SLUG ONLY, no id in the path
propertyId   JSON-LD `identifier`   (e.g. 561512) — 5615xx block
roomId       rates API `roomTypes[].id` (e.g. 628190)
```

Sample unit 561512 — *Neutral Studio – Pool / Garden Access – GF*:
geo `30.049144, 31.476398` (genuine), 15 photos, 27 amenities, check-in 14:00 / check-out 11:00,
`numberOfBedrooms: 1` (Lodgify reports 1 for a studio), occupancy 2.

### ⚠️ The advance-booking window masquerades as 6 months of occupancy

The first calendar sync reported a median of ~200 blocked nights per unit — an apparent
~55% forward occupancy. **It is not occupancy.** 32 of 45 units share the *identical*
tail-block start date, and the arithmetic is exact:

```
2026-08-18 (run date) + 180 days = 2027-02-14   ← 32 units
2026-08-18             + 270 days = 2027-05-15   ← 1 unit
                                     no tail      ← 11 units (no window limit set)
```

That is Lodgify's per-property **advance-booking window**, not 32 simultaneous six-month
reservations. Confirmed by probing unit 561503 either side of its edge:

| Probe | `isAvailable` | `isCheckInAvailable` |
|---|---|---|
| 2027-01-20 (inside) | 25/90 | 25/90 — real mixed availability |
| 2027-03-01 (outside) | **0/90** | **0/90** — every flag off |

**True in-window occupancy: median 11%, mean 16%.** 6,745 of ~8,600 "blocked" nights were
window artifact.

**We deliberately still emit those dates as BLOCKED.** Beyond the window the operator will
not accept a self-service booking, so blocking them is both accurate and fail-safe in each
direction — the site won't sell them and OTAs won't either. What must NOT happen is
*reporting* them as occupancy: the OTA pack and any occupancy figure has to be computed
inside each unit's window, or it tells the team 32 units are booked solid from February.

Detection heuristic (used for reporting only, never to unblock a date): a trailing
unavailable run that reaches the horizon end **and** is ≥45 nights long is a window edge,
not a booking. A six-month trailing reservation on a serviced apartment is implausible; a
180-day advance-booking window is a Lodgify default.

### ⚠️ Two units report contradictory availability flags

`96026` (prop 628039) and `96041` (prop 644392) report `isAvailable:false` for all 365
nights. 628039 *simultaneously* reports `isCheckInAvailable:true` for those same dates —
flags that cannot both be meaningful. This is the L-090 ambiguity: a greyed Lodgify cell
can mean unavailable OR check-in-restricted, and here they disagree.

Most likely these units are **switched off in Lodgify, not sold out**. Both are tagged
`[zero-availability-hold 2026-08-18]` in `units.notes` and must not publish until the
operator confirms (L-092: absence of availability is a refusal, never a value).

### ⚠️ Rates are USD, not EGP

The storefront renders EGP and the checkout URL carries `currency=EGP`, but the rates API returns
`"currency":"USD"` (`defaultRate.dailyPrice: 104` on 561512). FX is **pinned** in `src/config.js`
(`FX_USD_EGP`, default 50) rather than fetched live, so a re-run is reproducible and a quiet FX move
can't silently reprice 45 units. Same approach as Brassbell.

Their rate card is thin: a flat default plus a small number of named periods (561512 has exactly one
— "Holidays", 25–31 Dec, $114 vs $104). `useSmartPricing: false`, so those numbers are exact.

## Differences from `almaza-ical` (read before porting anything back)

| | Almaza | Silver Springs |
|---|---|---|
| Sanctioned | ❌ unsanctioned scrape | ✅ **deal signed 2026-08-18** |
| `service_fee_percent` | +10% (because unsanctioned) | **0%** — D-048 sanctioned-partner precedent |
| Roster path | `/en/{cmsPageId}/all-properties/` | `/en/properties/` |
| Unit URL | `/en/{propId}/{slug}` | `/en/{slug}` — **no id** |
| propertyId source | roster href | unit page JSON-LD `identifier` |
| CMS-page exclusion | by numeric id | **by slug name** (`CMS_SLUGS`) — unit and CMS URLs are structurally identical here |
| Title encodes | operator unit code (`D08-G03`) | design line / floor / block — **no operator code** |
| Currency | USD ×50 | USD ×50 (same, but verify per unit) |
| `wp_post_id` | baked in at scrape time by roster index | **assigned at SQL-build time from propertyId ascending** — see below |

### wp_post_id assignment (deliberate deviation)

Almaza set `wp = WP_BASE + roster_index` inside `content.js`. That is unstable: roster order is
pagination-dependent, so a re-scrape can silently renumber every unit, and one added unit shifts
every id after it. Here `content.js` writes `wp: null` and `scripts/build-insert-sql.js` assigns
`wp = 96001 + index(sorted by propertyId asc)` — stable per unit, and new operator inventory
appends instead of renumbering.

## Run

```bash
npm install && npx playwright install chromium

node content.js          # roster + JSON-LD + rates → output/units/{propId}.json  (LOCAL, on demand)
node sync.js             # calendars → docs/{wp}.ics + index.json + links.csv     (CI, cron)
node wire.js             # upsert listing_ical rows                                ⚠️ see below
```

⚠️ `wire.js` **does not exist in `almaza-ical`** despite its `package.json` declaring it — the working
implementation is `kennah-ical/wire.js`. Copy that one, don't write a third.

## Politeness (non-negotiable, D-003)

Cloudflare challenges plain `curl` on every host here. `src/browser.js` drives real Chromium with an
honest UA, lands on the origin once, then issues in-page `fetch(url, {credentials:'omit'})`. **No
stealth plugins, no UA/IP rotation** — a signed deal authorises the integration, it does not license
hammering their servers.

The **same-origin** unit pages do not throttle. The **cross-origin** rates/calendar hosts do (L-048),
surfacing as `Failed to fetch`. Hence: backoff `[15s, 30s, 60s]`, a 6-consecutive-failure circuit
breaker, resume-on-rerun, and `REQUEST_DELAY_MS=750` between units. If honest access stops working,
**stop** — the operator can hand over their Lodgify API key, which removes this path entirely.

## Gotchas inherited from prior operators

- **`listing_ical` keys the id as `wordpress_post_id`**, not `wp_post_id`, and has **no `source`
  column** — writing one silently 400s the whole upsert.
- **Per-date `minimalStay`.** Never collapse it by taking the first day's value (L-054). `parseCalendar`
  keeps `minStayByDate`; the single scalar it exposes is the **peak**, which fails safe.
- **A greyed Lodgify cell is ambiguous** — `isAvailable:false` *or* `isCheckInAvailable:false` look
  identical (L-090). A stay may legally *end* on a blocked date; that is not a double-booking.
- **Run `r2-make-derivatives.mjs`** after uploading photos, or phones get 195MB-decoded originals
  (L-117, crashed iOS tabs 2026-08-17).
- **Add the `ops.operator` row** in the same pass as widening `units_source_check` (L-058 — the most
  repeated onboarding miss; it has recurred four times).
- **Insert `unit_translations` `ar` rows** or `/ar` serves English (currently broken for all 48
  published Kennah units).
- **`units.wp_post_id` has no unique index**, so `ON CONFLICT (wp_post_id)` is a no-op. Use
  `ON CONFLICT (slug)`.
- **Photo filenames may contain spaces** — percent-encode (54 silent download failures on Kennah).
- **Empty availability is a refusal to publish, never "open"** (L-092). Gate fails closed.

## Open questions for the operator

1. **Is Lodgify their channel master, and do OTA bookings write back into it?**
   **Are any of these 45 already on Airbnb/Booking under their own account?**
   This gates the OTA pack entirely — Almaza's D1 is open and Kennah's audit returned **NO-GO** for
   exactly this (one-way bridge + already-listed units = double-booking).
2. **Cleaning fee: flat per stay, or per night?** BirdNest bills per night; assuming flat under-quoted
   a 7-night stay by EGP 13.4k (L-065).
3. Their advertised **20% security-deposit pre-authorisation** — surface it or absorb it?
4. Their stated policy *"all arabs must provide family card or marriage certificate"* — does it apply
   to our bookings, and must it appear on the listing?
5. Honour their **weekly (≈−28%) and monthly** discounts, or nightly-only?
6. Their real **Lodgify iCal export URLs** — an upgrade, not a blocker. Fixes the one-way-calendar gap.

See `../silversprings-access-request.md`.
