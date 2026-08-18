// sync.js — LIGHT, runs in GitHub Actions every 6h.
// Reads the committed data/units.json roster, hits ONLY the checkout calendar
// API per unit, and writes docs/{wp}.ics + docs/index.json + docs/links.csv.
//
// Politeness (D-003): checkout.lodgify.com sits behind Cloudflare and throttles
// under sustained load — the content scrape got walled after a handful of rapid
// calls until we added backoff, and this job hits the SAME host family 152x/run.
// So each unit's calendar fetch is wrapped in polite retry-with-backoff, and a
// consecutive-failure circuit breaker ABORTS the run (rather than hammer an
// unauthorised operator's servers) and exits non-zero so CI surfaces it.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { openBrowser, fetchJsonInPage, sleep } = require('./src/browser');
const { parseCalendar, collapseMinStay } = require('./src/lodgify');
const { collapseBlocked, iso } = require('./src/dates');
const { buildIcal } = require('./src/ical');
const { shouldWrite } = require('./src/guard');

const OUT = path.join(__dirname, 'docs');
const UNITS_FILE = path.join(__dirname, 'data', 'units.json'); // committed: [{wp, propertyId, roomId, title, slug}]

// Polite backoff between retries of a unit's calendar fetch (D-003). Mirrors the
// content-scrape's fetchRatesPolitely: no evasion, no UA/IP tricks — just give
// the quota window time to breathe. One retry per entry, then give up.
const CAL_BACKOFF_MS = [15000, 30000, 60000];
// Circuit breaker: if this many units in a row fail their calendar fetch even
// after backoff, the host is walling us off — STOP, keep the last-good feeds,
// and exit non-zero. Hammering 100+ more units would be both rude and useless.
const MAX_CONSECUTIVE_FAILS = 6;

function loadPrevIndex() {
  const p = path.join(OUT, 'index.json');
  if (!fs.existsSync(p)) return {};                 // legit first run
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // Fail CLOSED: an unreadable index would silently disable the
    // availability-collapse guard. Preserve the last-good docs/ tree.
    throw new Error(`docs/index.json unparseable (${e.message}). Aborting to preserve last-good feeds.`);
  }
  const map = {};
  for (const e of j.properties || []) map[e.wp] = e;
  return map;
}

// The calendar API returns a bounded window per call, so page forward by
// startDate until the horizon is covered. roomId is REQUIRED — without it the
// endpoint returns HTTP 400 (fetchJsonInPage throws on non-200, which folds this
// unit to a fail-closed SKIP via the guard rather than a bogus fully-open feed).
async function fetchCalendar(page, unit, horizonNights) {
  const start = new Date(); start.setHours(12, 0, 0, 0);
  const byDate = new Map();
  let cursor = start;
  let guard = 0;

  while (byDate.size < horizonNights && guard < 12) {
    guard += 1;
    const json = await fetchJsonInPage(page, cfg.CALENDAR_URL(unit.propertyId, unit.roomId, iso(cursor)));
    const days = json.calendar || [];
    if (!days.length) break;
    for (const d of days) if (!byDate.has(d.date)) byDate.set(d.date, d);

    const last = days[days.length - 1].date;
    const next = new Date(last); next.setHours(12, 0, 0, 0); next.setDate(next.getDate() + 1);
    if (iso(next) === iso(cursor)) break;            // no forward progress — bail
    cursor = next;
    await sleep(cfg.REQUEST_DELAY_MS);
  }

  // Parse the FULL merged horizon (was: min-stay taken from the first chunk only,
  // which pinned it to whatever today's date happened to require).
  const days = [...byDate.values()].slice(0, horizonNights);
  return parseCalendar({ calendar: days });
}

// Wrap the per-unit calendar fetch in polite retry-with-backoff. On a thrown
// error ("Failed to fetch", a Cloudflare challenge, HTTP 400/429, etc.) wait out
// the next backoff step and retry; when the backoff list is exhausted, rethrow so
// the caller records the unit as errored (→ fail-closed SKIP via the guard).
async function fetchCalendarPolitely(page, unit, horizonNights) {
  let lastErr;
  for (let attempt = 0; attempt <= CAL_BACKOFF_MS.length; attempt++) {
    try {
      return await fetchCalendar(page, unit, horizonNights);
    } catch (e) {
      lastErr = e;
      const wait = CAL_BACKOFF_MS[attempt];
      if (wait == null) break; // out of retries
      console.warn(`    calendar ${unit.wp} failed (${e.message}); backing off ${wait / 1000}s then retry`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function main(page) {
  fs.mkdirSync(OUT, { recursive: true });
  const units = JSON.parse(fs.readFileSync(UNITS_FILE, 'utf8'));
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  const todo = only.length ? units.filter((u) => only.includes(u.wp)) : units;

  const horizon = Math.round(cfg.HORIZON_MONTHS * 30.4);   // ~213 nights
  const prev = loadPrevIndex();
  const indexMap = { ...prev };                      // carry forward untouched units
  const skipped = [];
  let consecutiveFails = 0;
  let aborted = false;

  for (let i = 0; i < todo.length; i++) {
    const u = todo[i];
    if (i > 0) await sleep(cfg.REQUEST_DELAY_MS);     // inter-unit spacing (politeness)

    let result;
    try {
      result = await fetchCalendarPolitely(page, u, horizon);
      result.ok = true;
      result.errors = horizon - result.covered;
      consecutiveFails = 0;                            // a good fetch resets the breaker
    } catch (e) {
      console.error(`${u.wp} ${u.title}: ${e.message}`);
      result = { ok: false, blocked: [], available: 0, covered: 0, errors: horizon, minStay: null };
      consecutiveFails += 1;
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        console.error(`\nABORTING: ${consecutiveFails} consecutive calendar failures — the host is ` +
          `walling us off. Stopping at unit ${i + 1}/${todo.length} to stay polite (D-003). ` +
          `Last-good docs/*.ics for un-reached units are preserved. Re-run later to refresh the rest.`);
        skipped.push({ wp: u.wp, title: u.title, reason: 'circuit-breaker-abort' });
        aborted = true;
        break;
      }
    }

    const counts = {
      ok: result.ok,
      blocked: result.blocked.length,
      available: result.available,
      errors: result.errors,
    };
    const verdict = shouldWrite(prev[u.wp] || null, counts, horizon);

    if (!verdict.write) {
      // Keep the last-good .ics on disk untouched (fail closed).
      console.warn(`SKIP ${u.wp} ${u.title} — ${verdict.reason}`);
      skipped.push({ wp: u.wp, title: u.title, reason: verdict.reason });
      continue;
    }

    const ics = buildIcal({ wp: u.wp, title: u.title, ranges: collapseBlocked(result.blocked) });
    fs.writeFileSync(path.join(OUT, `${u.wp}.ics`), ics);
    indexMap[u.wp] = {
      wp: u.wp, title: u.title, slug: u.slug,
      availableCount: result.available,
      blockedCount: result.blocked.length,
      // minStay = the PEAK requirement across the horizon (fail-safe single
      // number); min/max expose the spread so a consumer can show "3–7 nights"
      // instead of pretending one value covers the whole season.
      minStay: result.minStay,
      minStayMin: result.minStayMin ?? null,
      minStayMax: result.minStayMax ?? null,
      // Per-date minimums, range-compressed. bluekeys.co reads this so a guest
      // gets the minimum that applies to THEIR check-in date (3 nights in
      // shoulder season) instead of the season's peak everywhere (L-054).
      minStayRanges: collapseMinStay(result.minStayByDate || {}),
      updatedAt: new Date().toISOString(),
    };
    console.log(`OK ${u.wp} ${u.title} — ${result.blocked.length} blocked / ${result.available} open`);
  }

  fs.writeFileSync(
    path.join(OUT, 'index.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), skipped, properties: Object.values(indexMap) }, null, 2),
  );

  // links.csv — the machine-readable twin of the OTA master sheet. Must NOT be
  // gitignored: it is a deliverable (this omission bit the soul-ical build).
  const csv = ['wp_post_id,title,ical_url']
    .concat(Object.values(indexMap).map((e) => `${e.wp},"${String(e.title).replace(/"/g, '""')}",${cfg.PAGES_BASE_URL}/${e.wp}.ics`))
    .join('\n');
  fs.writeFileSync(path.join(OUT, 'links.csv'), csv + '\n');

  console.log(`\nWrote ${Object.keys(indexMap).length} feeds, skipped ${skipped.length}`);

  if (aborted) {
    console.error('ERROR: circuit breaker tripped — exiting non-zero so CI surfaces it.');
    process.exit(1);
  }
  if (skipped.length > todo.length * 0.25) {
    // A broad skip means something systemic (CF challenge, endpoint change).
    console.error('ERROR: >25% of units skipped — failing the run so CI surfaces it.');
    process.exit(1);
  }
}

(async () => {
  const { browser, page } = await openBrowser();
  try {
    await main(page);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
