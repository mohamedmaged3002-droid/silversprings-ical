# silversprings-ical

Calendar bridge for **Silver Springs Residence** (serviced apartments, New Cairo).
Reads the operator's Lodgify availability and publishes one `.ics` per unit on GitHub Pages,
which BlueKeys and the OTA channels subscribe to.

> **This repo is public because the feeds must be publicly fetchable** for OTAs to subscribe.
> Keep it that way: no credentials, no commercial terms, no operator performance data.
> Analysis, occupancy figures and commercial detail live in the private ops vault.

```
silverspringsresidence.com (Lodgify)
  ├── JSON-LD on /en/{slug}          → content, photos, amenities, geo
  ├── websiteserver…/rates/…         → roomId, defaultRate, named periods   (throttled)
  └── checkout…/checkout/calendar    → per-date availability + minimalStay  (throttled)
        ↓
  docs/{wp}.ics + docs/index.json + docs/links.csv   (GitHub Pages)
        ↓
  Supabase listing_ical / units / unit_daily_prices
```

## Run

```bash
npm install && npx playwright install chromium

node content.js                      # roster + JSON-LD + rates → output/units/  (LOCAL, on demand)
node scripts/build-roster.js         # → data/units.json (committed; what CI reads)
node scripts/build-insert-sql.js     # → output/*-insert.sql
node scripts/build-prices-sql.js     # → output/*-prices.sql + daily-prices.json
node scripts/photos-to-r2.mjs        # photos → R2 (then run r2-make-derivatives.mjs)
node scripts/load-to-supabase.mjs …  # units | prices | photos | verify
node sync.js                         # calendars → docs/*.ics                   (CI, 3h cron)
node wire.js                         # upsert listing_ical rows
```

`sync.js` is the only thing CI runs. Everything else is local and on demand.

## Endpoint shape

```
roster     /en/properties/            → the advertised unit count, used to reconcile
unit URL   /en/{slug}                 ← SLUG ONLY, no id in the path
propertyId JSON-LD `identifier` on the unit page
roomId     rates API roomTypes[].id   ← the calendar endpoint 400s without it
```

Pagination is client-rendered and **ignores `?page=N`** — pages advance by clicking the numbered
pager buttons, then waiting for the first slug to change (the grid often swaps with no network hit).
`discoverRoster` reconciles its result against the site's own advertised count and warns on a
shortfall, so a partial roster can't pass as complete.

CMS pages share the `/en/{slug}` shape with units and are excluded **by name** (`CMS_SLUGS`) — there
is no structural way to tell them apart here.

## Rates are quoted in USD

The storefront renders EGP but the rates API returns `"currency":"USD"`. FX is **pinned** in
`src/config.js` rather than fetched live, so a re-run is reproducible and an FX move cannot silently
reprice the roster. `build-prices-sql.js` re-checks the currency **per unit** and refuses to convert
if any unit reports something other than USD.

`useSmartPricing:false` on this tenant, so the default rate + named periods are exact — there is no
finer pricing engine to consult.

## wp_post_id assignment

`content.js` deliberately does **not** assign `wp_post_id`. It is derived at build time as
`WP_BASE + index(propertyId ascending)` — stable per unit, and new operator inventory appends
instead of renumbering.

`src/complete.js` refuses to build any wp-numbered artifact unless the scrape count matches the
roster. This is load-bearing: during a partial scrape a lower propertyId can still arrive and shift
every id after it (observed — propertyId 561503 landed at unit 37 and took the first slot), which
would wire prices and feeds to the **wrong units** while every row still looked well-formed.
`FORCE_INCOMPLETE=1` overrides it and prints a loud warning; do not load that output.

## Politeness (non-negotiable, D-003)

Cloudflare challenges plain `curl` on every host here. `src/browser.js` drives real Chromium with an
honest UA, lands on the origin once, then issues in-page `fetch(url, {credentials:'omit'})`.
**No stealth plugins, no UA/IP rotation.**

The **same-origin** unit pages do not throttle. The **cross-origin** rates/calendar hosts do,
surfacing as `Failed to fetch` — it walled us off after 7 units on the first local run. Hence
backoff `[15s, 30s, 60s]`, a 6-consecutive-failure circuit breaker, resume-on-rerun, and
`REQUEST_DELAY_MS=4500` in CI. If honest access stops working, **stop and escalate** rather than
working around it.

## Reading the calendar correctly

**Subtract the advance-booking window before treating blocked nights as occupancy.** Lodgify
expresses "beyond the bookable horizon" with the same `isAvailable:false` it uses for "booked", so a
180-day window reads as six months of solid bookings. The tell is a *trailing* unavailable run that
reaches the horizon end at a round offset from the run date, replicated across units — if two or
more units share a tail-start date it is configuration, not coincidence.

Those dates stay blocked (beyond the window the operator won't take a self-service booking, so
blocking is accurate and fail-safe). What must not happen is *counting* them as occupancy.

**A greyed cell is ambiguous.** `isAvailable:false` and `isCheckInAvailable:false` render
identically; read the flags separately. A stay may legally **end** on a blocked date — that is not a
double-booking. Where the flags actively contradict each other, treat the unit as unknown and hold it.

**Per-date `minimalStay`.** Never collapse it to the first day's value. `parseCalendar` keeps
`minStayByDate`; the single scalar it exposes is the **peak**, which fails safe (quoting a shorter
minimum than the operator enforces means a rejected booking after we've promised the guest).

**Absence of availability data is a refusal to publish, never "open".** Every gate fails closed.

## Downstream gotchas

- `listing_ical` keys the id as **`wordpress_post_id`**, not `wp_post_id`, and has **no `source`
  column** — writing one silently 400s the whole upsert.
- **Order matters when wiring a feed:** commit → push → *poll Pages until the `.ics` returns 200* →
  only then write `listing_ical`. The site fails soft on a 404 feed by treating the unit as fully
  available, i.e. a double-booking window.
- Run `new-site/scripts/r2-make-derivatives.mjs` after uploading photos, or phones decode the
  full-size originals.
- Widening `units.source` also requires widening **`ops.operator.calendar_source`** (it has its own
  CHECK) and adding the `ops.operator` row in the same pass — `ops.health_check` FKs it.
- `units.wp_post_id` has **no unique index**, so `ON CONFLICT (wp_post_id)` is a silent no-op. Use
  `ON CONFLICT (slug)`.
- Photo filenames may contain spaces — percent-encode or downloads 404 silently.
- Insert `unit_translations` `ar` rows or `/ar` serves English.
