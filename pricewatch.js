#!/usr/bin/env node
// pricewatch.js — Silver Springs daily price refresh + change watch.
//
// Ported from almaza-ical/pricewatch.js, with the gap that one had CLOSED:
//
//   Almaza's watcher is READ-ONLY. It emails on a change and never touches
//   `unit_daily_prices`, so the DB keeps selling whatever price was captured at
//   onboarding until a human re-runs the builders by hand. This one WRITES the
//   refreshed prices, so the site cannot silently sell a stale rate.
//
// What it does, daily:
//   1. Re-discovers the roster            -> detects ADDED / REMOVED units
//   2. Re-fetches every unit's rate card  -> expands to per-night EGP
//   3. Diffs against the committed baseline (state/prices.json + data/roster.json)
//   4. UPSERTS changed prices into Supabase `unit_daily_prices`   <- the A half
//   5. Emails the team on any price or roster change              <- the B half
//   6. Advances the baseline
//
// Rolling 365-day horizon, recomputed each run — deliberately NOT a fixed season.
// Almaza's fixed [Jun 1, Oct 31] window is why its 152 published units lose all
// pricing on 2026-11-01. A rolling horizon cannot expire.
//
// Modes:
//   (default)     fetch -> diff -> write prices -> email -> advance baseline
//   --dry-run     fetch -> diff -> log; NO DB write, NO email, NO baseline write
//   --seed        establish the baseline from a fresh fetch, silently (first run)
//   --no-db       diff + email but skip the Supabase write (useful when debugging)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { openBrowser, fetchJsonInPage, sleep } = require('./src/browser');
const { discoverRoster } = require('./src/discover');
const { parseRates, dailyPricesForSeason } = require('./src/lodgify');
const { diffAll } = require('./src/changes');
const { fetchEgpPerUsd } = require('./src/fx');

const HORIZON_DAYS = Number(process.env.HORIZON_DAYS) || 365;

const UNITS_PATH = path.join(__dirname, 'data', 'units.json');
const STATE_PATH = path.join(__dirname, 'state', 'prices.json');
const ROSTER_PATH = path.join(__dirname, 'data', 'roster.json');
const DAILY_PATH = path.join(__dirname, 'output', 'daily-prices.json'); // for the OTA pack
const FX_PATH = path.join(__dirname, 'state', 'fx.json');

const OUT_DIR = path.join(__dirname, 'out');
const CHANGE_MSG_PATH = path.join(OUT_DIR, 'change-message.json');   // -> send-alert.js
const CHANGED_UNITS_PATH = path.join(OUT_DIR, 'changed-units.json'); // -> build-changes.py

const DRY = process.argv.includes('--dry-run');
const SEED = process.argv.includes('--seed');
const NO_DB = process.argv.includes('--no-db');

// Politeness (D-003). The rates host throttles under load — it walled us off after
// 7 units on the first local run. Space units far apart, back off, and STOP rather
// than hammer.
const UNIT_SPACING_MS = Number(process.env.UNIT_SPACING_MS) || 4000;
const RATE_BACKOFF_MS = [15000, 30000, 60000];
const MAX_CONSECUTIVE_FAILS = 6;

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

const iso = (d) => d.toISOString().slice(0, 10);
function horizon() {
  const start = new Date(); start.setUTCHours(12, 0, 0, 0);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + HORIZON_DAYS - 1);
  return { start: iso(start), end: iso(end) };
}

// One line per unit -> a single-price change touches ONE line in the committed diff.
function serializePriceMap(map) {
  const wps = Object.keys(map).sort((a, b) => Number(a) - Number(b));
  return '{\n' + wps.map((wp) => `${JSON.stringify(String(wp))}:${JSON.stringify(map[wp])}`).join(',\n') + '\n}\n';
}

// Keep output/daily-prices.json in the OTA pack's shape ({wp:[{date,price,usd}]}).
// `usdMap` is the source of truth; price is the EGP conversion at `fx`.
function writeDailyForSheet(usdMap, fx) {
  fs.mkdirSync(path.dirname(DAILY_PATH), { recursive: true });
  const out = {};
  for (const wp of Object.keys(usdMap)) {
    out[wp] = Object.entries(usdMap[wp]).sort().map(([date, usd]) => ({
      date, price: Math.round(usd * fx), usd,
    }));
  }
  fs.writeFileSync(DAILY_PATH, JSON.stringify(out));
}

// ⚠️ THE BASELINE STORES USD, NOT EGP.
// The operator quotes USD; the EGP we publish is USD x their live FX. If the
// baseline held EGP, every FX tick would look like a price change on all 45 units
// and the team would get a "45 price changes" email every morning until they
// muted it. Diffing USD isolates the thing that actually changed: the rate card.
// FX movement still rewrites the DB (so we keep matching their site) — it just
// doesn't raise an alert.
function writeBaseline(priceMap, roster) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, serializePriceMap(priceMap));
  fs.writeFileSync(ROSTER_PATH, JSON.stringify(roster.map((u) => ({ slug: u.slug })), null, 2) + '\n');
  console.log(`Baseline written: ${Object.keys(priceMap).length} units priced, roster ${roster.length}.`);
}

async function fetchRatesWithBackoff(page, propId) {
  let lastErr;
  for (let attempt = 0; attempt <= RATE_BACKOFF_MS.length; attempt++) {
    try {
      return await fetchJsonInPage(page, cfg.RATES_URL(propId));
    } catch (e) {
      lastErr = e;
      const wait = RATE_BACKOFF_MS[attempt];
      if (wait == null) break;
      console.warn(`    rates ${propId} failed (${e.message}); backing off ${wait / 1000}s then retry`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ---- the A half: push refreshed prices into Supabase --------------------------
async function upsertPrices(changedWps, usdMap, fx) {
  const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL_BASE || !KEY) {
    console.warn('DB: skipped (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)');
    return { written: 0, configured: false };
  }
  const rows = [];
  for (const wp of changedWps) {
    for (const [date, usd] of Object.entries(usdMap[wp] || {})) {
      // EGP = the operator's USD x the operator's OWN live rate. No markup:
      // Silver Springs is 0% (service_fee_percent = 0, cleaning = 0), so the
      // guest total on bluekeys.co equals the total on their own site.
      rows.push({ wp_post_id: Number(wp), date, price: Math.round(usd * fx), currency: 'EGP', source: cfg.SOURCE });
    }
  }
  if (!rows.length) return { written: 0, configured: true };

  const BATCH = 2000;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await fetch(`${URL_BASE}/rest/v1/unit_daily_prices?on_conflict=wp_post_id,date`, {
      method: 'POST',
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`price upsert -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    done += chunk.length;
  }
  console.log(`DB: upserted ${done} price rows across ${changedWps.length} unit(s)`);
  return { written: done, configured: true };
}

// The diff runs on USD (see writeBaseline), so label it USD and show the EGP the
// guest actually sees alongside it. Mislabelling these as EGP would make a $10
// change look like a 10-pound change.
const fmtRange = (r, fx) =>
  `  ${r.from === r.to ? r.from : `${r.from}→${r.to}`}: ` +
  `$${r.oldEgp} → $${r.newEgp}  (EGP ${Math.round(r.oldEgp * fx).toLocaleString()} → ${Math.round(r.newEgp * fx).toLocaleString()})`;

function buildSummary(diff, units, dbNote, fx) {
  const byWp = new Map(units.map((u) => [String(u.wp), u]));
  const n = diff.priceChanges.length;
  const parts = [];
  if (n) parts.push(`${n} price change${n === 1 ? '' : 's'}`);
  if (diff.addedUnits.length) parts.push(`${diff.addedUnits.length} new unit${diff.addedUnits.length === 1 ? '' : 's'}`);
  if (diff.removedUnits.length) parts.push(`${diff.removedUnits.length} removed`);
  const subject = `Silver Springs — ${parts.join(', ')}`;

  const lines = [subject, ''];

  // Roster changes go FIRST: a new or vanished unit is more actionable than a
  // rate tweak, and a removed unit may mean a listing we are still selling.
  if (diff.addedUnits.length) {
    lines.push(`NEW UNITS on their site (${diff.addedUnits.length}) — not yet on BlueKeys:`);
    for (const s of diff.addedUnits) lines.push(`  + ${s}`);
    lines.push('  -> onboard: node content.js && node scripts/build-roster.js && node scripts/build-insert-sql.js');
    lines.push('');
  }
  if (diff.removedUnits.length) {
    lines.push(`REMOVED from their site (${diff.removedUnits.length}) — we may still be selling these:`);
    for (const s of diff.removedUnits) lines.push(`  - ${s}`);
    lines.push('  -> check whether the unit is delisted, then draft/delist it on BlueKeys.');
    lines.push('');
  }
  for (const pc of diff.priceChanges) {
    const u = byWp.get(String(pc.wp));
    lines.push(`[wp${pc.wp}] ${u ? u.title : `wp${pc.wp}`}`);
    for (const r of pc.ranges) lines.push(fmtRange(r, fx));
    lines.push('');
  }
  if (dbNote) lines.push(dbNote, '');
  lines.push(`The operator quotes USD. EGP shown at ${fx} — their own live rate, so bluekeys.co matches`);
  lines.push(`their storefront exactly (no markup: 0% service fee, no cleaning fee).`);
  return { subject, body: lines.join('\n').trimEnd() + '\n' };
}

async function main() {
  const units = loadJson(UNITS_PATH, null);
  if (!Array.isArray(units) || !units.length) throw new Error('data/units.json missing or empty');

  const baseline = loadJson(STATE_PATH, {});
  const oldRoster = loadJson(ROSTER_PATH, []);
  const firstRun = SEED || !fs.existsSync(STATE_PATH);

  const { start, end } = horizon();
  console.log(`horizon: ${start} .. ${end} (${HORIZON_DAYS} days, rolling)`);

  const prevFx = loadJson(FX_PATH, null);
  const { browser, page } = await openBrowser();
  const newPrices = {};          // USD per date — the baseline + diff basis
  let fx = cfg.FX_USD_EGP, fxLive = false, fxWhy = '';
  let newRoster = oldRoster;
  try {
    const fxRes = await fetchEgpPerUsd(page);
    fx = fxRes.rate; fxLive = fxRes.live; fxWhy = fxRes.why || '';
    console.log(`fx: ${fx} EGP/USD ${fxLive ? '(live, from the operator\'s own currency table)' : `(FALLBACK — ${fxWhy})`}`);
    const disc = await discoverRoster(page);
    newRoster = disc.units;
    console.log(`roster: ${newRoster.length} units (site advertises ${disc.expected})`);

    let consecutiveFails = 0;
    let i = 0;
    for (const u of units) {
      i += 1;
      try {
        const rates = parseRates(await fetchRatesWithBackoff(page, u.propertyId));
        // Guard the currency per unit — a unit switched to EGP would otherwise be
        // multiplied by the FX and land 50x too high.
        const cur = rates.currency || cfg.RATE_CURRENCY;
        if (cur !== cfg.RATE_CURRENCY) {
          throw new Error(`priced in ${cur}, not ${cfg.RATE_CURRENCY} — refusing to convert blindly`);
        }
        const daily = dailyPricesForSeason(rates, start, end);
        newPrices[u.wp] = Object.fromEntries(daily.map((r) => [r.date, r.price]));   // USD
        consecutiveFails = 0;
        console.log(`[${i}/${units.length}] ${u.wp} ${u.title} — ${daily.length} priced dates`);
      } catch (e) {
        consecutiveFails += 1;
        console.error(`[${i}/${units.length}] FAILED ${u.wp} (prop ${u.propertyId}): ${e.message}`);
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          throw new Error(
            `circuit-breaker: ${consecutiveFails} consecutive rate fetches failed at unit ${i}/${units.length} — aborting to stay polite`,
          );
        }
      }
      await sleep(UNIT_SPACING_MS);
    }
  } finally {
    await browser.close();
  }

  const diff = diffAll(baseline, newPrices, oldRoster, newRoster);
  const changed =
    diff.priceChanges.length > 0 || diff.addedUnits.length > 0 || diff.removedUnits.length > 0;

  // Merge so a unit that transiently failed to fetch keeps its last-known baseline.
  const nextBaseline = { ...baseline, ...newPrices };
  if (!DRY) writeDailyForSheet(nextBaseline, fx);

  // FX moved (or this is the first run that records it)? Then the EGP we publish
  // is stale even if no rate card changed — rewrite every unit so we keep matching
  // their storefront. This does NOT trigger an email; only rate-card and roster
  // changes do.
  const fxChanged = !prevFx || Number(prevFx.rate) !== Number(fx);

  if (firstRun) {
    console.log(`Seed run: establishing baseline for ${Object.keys(newPrices).length} units — no email sent.`);
    if (DRY) { console.log('[dry-run] seed: NOT writing baseline.'); return 0; }
    writeBaseline(nextBaseline, newRoster);
    fs.mkdirSync(path.dirname(FX_PATH), { recursive: true });
    fs.writeFileSync(FX_PATH, JSON.stringify({ rate: fx, live: fxLive, at: new Date().toISOString() }, null, 2) + '\n');
    return 0;
  }

  // FX-only movement: no alert (nothing the team can act on), but the published
  // EGP is now stale against their storefront, so rewrite every unit.
  if (!changed) {
    if (fxChanged && !DRY && !NO_DB) {
      const all = Object.keys(nextBaseline);
      const { written, configured } = await upsertPrices(all, nextBaseline, fx);
      if (configured) {
        console.log(`FX moved ${prevFx ? prevFx.rate : '(none)'} -> ${fx}: rewrote ${written} rows so we keep matching their site. No email (not actionable).`);
        fs.mkdirSync(path.dirname(FX_PATH), { recursive: true });
        fs.writeFileSync(FX_PATH, JSON.stringify({ rate: fx, live: fxLive, at: new Date().toISOString() }, null, 2) + '\n');
      }
    } else {
      console.log('No price or roster changes — nothing written, no email sent.');
    }
    return 0;
  }

  console.log(`Changes: ${diff.priceChanges.length} priced units, +${diff.addedUnits.length} / -${diff.removedUnits.length} roster.`);

  // ---- A: push the refreshed prices to the DB BEFORE emailing -----------------
  // Order matters: if the write fails we exit non-zero WITHOUT advancing the
  // baseline, so the next run retries the same change instead of forgetting it.
  let dbNote = '';
  if (!DRY && !NO_DB && diff.priceChanges.length) {
    const wps = diff.priceChanges.map((pc) => String(pc.wp));
    const { written, configured } = await upsertPrices(wps, nextBaseline, fx);
    dbNote = configured
      ? `unit_daily_prices updated: ${written} rows across ${wps.length} unit(s) — the site is now quoting these.`
      : 'unit_daily_prices NOT updated (no Supabase credentials in this run) — the site is still quoting the OLD prices.';
  }

  const summary = buildSummary(diff, units, dbNote, fx);
  console.log('---\n' + summary.body + '---');

  if (DRY) { console.log('[dry-run] NOT writing artifacts or baseline.'); return 0; }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Same split the other watchers use: pricewatch DETECTS and drops artifacts,
  // build-changes.py turns them into the attached sheet, send-alert.js delivers.
  // Roster changes go in the payload too — Almaza leaves them in the email body,
  // which means a roster-only day sends a bodyless email once the attachment rule
  // kicks in. Putting them in the sheet keeps every alert attachment-only.
  const byWp = new Map(units.map((u) => [String(u.wp), u]));
  fs.writeFileSync(CHANGED_UNITS_PATH, JSON.stringify({
    dateStr: new Date().toISOString().slice(0, 10),
    fx,
    units: diff.priceChanges.map((pc) => {
      const u = byWp.get(String(pc.wp));
      return {
        wp: pc.wp,
        code: u ? `SS${String(pc.wp - cfg.WP_BASE + 1).padStart(3, '0')}` : null,
        title: u ? u.title : `wp${pc.wp}`,
        // ranges carry USD (the quoted currency); the sheet shows both.
        ranges: pc.ranges,
      };
    }),
    addedUnits: diff.addedUnits,
    removedUnits: diff.removedUnits,
  }));
  fs.writeFileSync(CHANGE_MSG_PATH, JSON.stringify({ subject: summary.subject, body: summary.body }));
  console.log('Artifacts: out/changed-units.json + out/change-message.json');
  writeBaseline(nextBaseline, newRoster);
  fs.mkdirSync(path.dirname(FX_PATH), { recursive: true });
  fs.writeFileSync(FX_PATH, JSON.stringify({ rate: fx, live: fxLive, at: new Date().toISOString() }, null, 2) + '\n');
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => { console.error('FATAL:', err && err.message ? err.message : err); process.exit(1); });
