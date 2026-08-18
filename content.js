// content.js — HEAVY, runs LOCALLY on Maged's Mac (not in CI).
// Walks the roster, pulls JSON-LD + rates for every unit, writes
// output/units/{propId}.json plus output/roster.json. Run on demand, not on a cron.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { openBrowser, fetchJsonInPage, sleep } = require('./src/browser');
const { discoverRoster } = require('./src/discover');
const { parseJsonLd, parseRates } = require('./src/lodgify');
const {
  designLine, floorCode, floorName, block, titleBedrooms,
  inNewCairoBbox, guestsConservative, guestsHouseRule,
} = require('./src/codes');

const OUT = path.join(__dirname, 'output', 'units');

// Read the VacationRental JSON-LD block out of a unit page.
// This host is SAME-ORIGIN and does not throttle (Almaza survived 152 loads);
// only the cross-origin rates host does. Keep the two decoupled.
async function readJsonLd(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page.evaluate(() => {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent);
        if (j['@type'] === 'VacationRental') return j;
      } catch { /* not the block we want */ }
    }
    return null;
  });
}

// The rates host (websiteserver.lodgify.com) rate-limits under sustained load —
// a cross-origin block surfaces as "Failed to fetch". D-003 handling: back off
// POLITELY and retry (no evasion, no UA/IP tricks), per L-048.
const RATE_BACKOFF_MS = [15000, 30000, 60000];
async function fetchRatesPolitely(page, propId) {
  let lastErr;
  for (let attempt = 0; attempt <= RATE_BACKOFF_MS.length; attempt++) {
    try {
      return await fetchJsonInPage(page, cfg.RATES_URL(propId));
    } catch (e) {
      lastErr = e;
      const wait = RATE_BACKOFF_MS[attempt];
      if (wait == null) break; // out of retries
      console.warn(`    rates ${propId} failed (${e.message}); backing off ${wait / 1000}s then retry`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// PII guard (L-093). Kennah's operator endpoint returned guest emails, password
// hashes and passport-scan links; we scrub at the NETWORK BOUNDARY, not at the
// point of use, and assert loudly rather than quietly persisting a leak.
const PII_KEYS = /^(guests?|bookings?|reservations?|users?|customers?|owners?|emails?|phones?|password|passwordHash|documents?|passport|identity)$/i;
function assertNoPii(obj, where) {
  const hits = [];
  const walk = (o, p) => {
    if (!o || typeof o !== 'object' || p.length > 4) return;
    for (const k of Object.keys(o)) {
      if (PII_KEYS.test(k) && o[k] && typeof o[k] === 'object') hits.push([...p, k].join('.'));
      walk(o[k], [...p, k]);
    }
  };
  walk(obj, []);
  if (hits.length) {
    throw new Error(`PII-shaped keys in ${where}: ${hits.join(', ')} — scrub before persisting (L-093)`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { browser, page } = await openBrowser();

  const { units: roster, expected } = await discoverRoster(page);
  fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'output', 'roster.json'), JSON.stringify(roster, null, 2));
  console.log(`roster: ${roster.length} units (site advertises ${expected})`);

  const problems = [];
  let n = 0;
  let consecutiveFails = 0;
  // Circuit breaker: if the rates host walls us off this many units in a row even
  // after backoff, the quota is spent — STOP rather than keep hammering (D-003).
  const MAX_CONSECUTIVE_FAILS = 6;

  for (const r of roster) {
    n += 1;
    const url = `${cfg.ORIGIN}/en/${r.slug}`;
    try {
      const ld = await readJsonLd(page, url);
      if (!ld) throw new Error('no VacationRental JSON-LD on page');
      assertNoPii(ld, `jsonld ${r.slug}`);

      const u = parseJsonLd(ld);
      if (!u.propertyId) throw new Error('JSON-LD carried no identifier (propertyId)');

      // Resume support: skip WITHOUT re-hitting the throttled rates host. Reaching
      // this check costs only a same-origin page load, which is not rate-limited.
      const outFile = path.join(OUT, `${u.propertyId}.json`);
      if (fs.existsSync(outFile)) {
        console.log(`[${n}/${roster.length}] ${u.propertyId} ${u.title} — already scraped, skip`);
        consecutiveFails = 0;
        continue;
      }

      const rates = await fetchRatesPolitely(page, u.propertyId);
      assertNoPii(rates, `rates ${u.propertyId}`);
      const parsedRates = parseRates(rates);
      consecutiveFails = 0;

      // Geo: pin ONLY genuine coords. Out-of-bbox pins are NULLed, never guessed
      // into a centroid (project_geocoding_quality).
      const geoOk = inNewCairoBbox(u.lat, u.lng);
      if (!geoOk && u.lat != null) {
        problems.push({ slug: r.slug, title: u.title, issue: 'geo-out-of-bbox', lat: u.lat, lng: u.lng });
      }

      const line = designLine(u.title);
      const fl = floorCode(u.title);
      const blk = block(u.title);
      if (!fl) problems.push({ slug: r.slug, title: u.title, issue: 'no-floor-token' });
      if (!blk) problems.push({ slug: r.slug, title: u.title, issue: 'no-block' });

      // Cross-check the title's bedroom count against the structured field.
      // Lodgify reports numberOfBedrooms=1 for studios, so studio(0) vs ld(1) is
      // CONSISTENT and deliberately not flagged.
      const tb = titleBedrooms(u.title);
      const ldb = Number(u.bedrooms);
      const studioOk = tb === 0 && ldb === 1;
      if (tb != null && Number.isFinite(ldb) && tb !== ldb && !studioOk) {
        problems.push({ slug: r.slug, title: u.title, issue: 'bedrooms-title-vs-jsonld', title_says: tb, jsonld_says: ldb });
      }

      if (!parsedRates.defaultRate) problems.push({ slug: r.slug, title: u.title, issue: 'no-default-rate' });
      if (!parsedRates.roomId) problems.push({ slug: r.slug, title: u.title, issue: 'no-room-id-calendar-will-400' });
      // Rates are USD on this tenant even though the storefront renders EGP.
      if (parsedRates.currency && parsedRates.currency !== cfg.RATE_CURRENCY) {
        problems.push({ slug: r.slug, title: u.title, issue: `unexpected-currency-${parsedRates.currency}` });
      }
      if (!u.photos.length) problems.push({ slug: r.slug, title: u.title, issue: 'no-photos' });

      const record = {
        ...u,
        // DEVIATION FROM ALMAZA: Almaza baked wp_post_id into the scrape as
        // WP_BASE + roster_index, which is unstable — roster order is pagination-
        // dependent, so a re-scrape can silently renumber every unit, and an added
        // unit shifts all ids after it. We deliberately do NOT assign wp here.
        // scripts/build-insert-sql.js assigns it from propertyId ascending, which
        // is stable per unit and appends cleanly when the operator adds inventory.
        wp: null,
        slug: r.slug,
        rosterIndex: n,
        designLine: line,
        floorCode: fl,
        floorName: floorName(fl),
        block: blk,
        titleBedrooms: tb,
        // House rule (D-022) vs the operator's advertised figure. We publish the
        // conservative minimum; guestsOperator goes to the OTA sheet verbatim.
        guestsHouseRule: guestsHouseRule(u.bedrooms),
        guestsBluekeys: guestsConservative(u.bedrooms, u.guestsOperator),
        lat: geoOk ? u.lat : null,
        lng: geoOk ? u.lng : null,
        rates: parsedRates,
        rateCurrency: parsedRates.currency || cfg.RATE_CURRENCY,
        fxUsdEgp: cfg.FX_USD_EGP,
        scrapedAt: new Date().toISOString(),
      };

      fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
      console.log(
        `[${n}/${roster.length}] ${u.propertyId} ${u.title} — ${u.photos.length} photos, ` +
        `${parsedRates.periods.length} rate periods, default ${parsedRates.defaultRate} ${parsedRates.currency}`,
      );
    } catch (e) {
      console.error(`[${n}/${roster.length}] FAILED ${url}: ${e.message}`);
      problems.push({ slug: r.slug, url, issue: `scrape-failed: ${e.message}` });
      consecutiveFails += 1;
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        console.error(`\nABORTING: ${consecutiveFails} consecutive failures — the rates host is walling us off. ` +
          `Stopping at unit ${n}/${roster.length} to stay polite. Re-run later (quota resets fast) to resume.`);
        problems.push({ issue: 'aborted-circuit-breaker', atUnit: n, of: roster.length });
        break;
      }
    }
    await sleep(cfg.REQUEST_DELAY_MS);
  }

  const done = fs.readdirSync(OUT).length;
  fs.writeFileSync(path.join(__dirname, 'output', 'problems.json'), JSON.stringify(problems, null, 2));
  console.log(`\nDone. ${done}/${roster.length} units scraped, ${problems.length} problems -> output/problems.json`);
  if (expected && done !== expected) {
    console.warn(`WARNING: ${done} scraped vs ${expected} advertised — do NOT treat this run as complete.`);
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
