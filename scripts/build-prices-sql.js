// scripts/build-prices-sql.js
// Emit daily nightly rates for the Silver Springs units into Supabase
// `unit_daily_prices`. Reads output/units/*.json, prices every date in the
// horizon via dailyPricesForSeason (named period covering the date, else the
// operator's explicit "Default Rate"; Lodgify reports useSmartPricing:false so
// these are exact), converts USD -> EGP at the PINNED rate, and writes
// output/silversprings-prices.sql + output/daily-prices.json. NO network, NO DB.
//
// ── Two deliberate deviations from almaza-ical ──────────────────────────────
//
// 1. NO BOUNDED SEASON. Almaza is a beach resort with a real off-season, so its
//    builder bounds the default-rate fill to [Jun 1, Oct 31] and leaves the rest
//    unpriced (=> BLOCKED), on the principle "don't invent off-season prices".
//    Silver Springs is URBAN New Cairo serviced-apartment inventory: it lets
//    year-round, and its Lodgify "Default Rate" carries no date bounds — it is
//    the operator's standing price for any date not covered by a named period.
//    Pricing a rolling 365 days from the Default Rate is therefore reporting the
//    operator's real rule, not extrapolating one. Bounding it to a season here
//    would wrongly render ~7 months BLOCKED on units that are actually bookable.
//
// 2. FX CONVERSION. Almaza's builder writes the scraped number straight through
//    as EGP. This tenant quotes USD (verified: defaultRate.currency === 'USD'),
//    so every price is converted at cfg.FX_USD_EGP — PINNED, not live, so a
//    re-run is reproducible and an FX move can't silently reprice 45 units.
//
// Schema note: currency + source are BOTH NOT NULL on unit_daily_prices.
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const { dailyPricesForSeason } = require('../src/lodgify');
const { assertCompleteScrapeUnlessForced } = require('../src/complete');

const HORIZON_DAYS = Number(process.env.HORIZON_DAYS) || 365;

const UNITS_DIR = path.join(__dirname, '..', 'output', 'units');
const OUT = path.join(__dirname, '..', 'output', 'silversprings-prices.sql');
const MAP_OUT = path.join(__dirname, '..', 'output', 'daily-prices.json');

function sqlText(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

const iso = (d) => d.toISOString().slice(0, 10);

function horizon() {
  const start = new Date();
  start.setUTCHours(12, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + HORIZON_DAYS - 1);
  return { start: iso(start), end: iso(end) };
}

// Mirrors scripts/build-insert-sql.js exactly — wp from propertyId ascending.
// If these two ever disagree, prices land on the wrong units, so keep them in
// lockstep (same sort key, same base).
function loadUnits() {
  assertCompleteScrapeUnlessForced(UNITS_DIR);
  return fs
    .readdirSync(UNITS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(UNITS_DIR, f), 'utf8')))
    .sort((a, b) => Number(a.propertyId) - Number(b.propertyId))
    .map((u, i) => ({ ...u, wp: cfg.WP_BASE + i }));
}

function main() {
  const units = loadUnits();
  if (!units.length) throw new Error(`no unit JSON in ${UNITS_DIR} — run content.js first`);

  const { start, end } = horizon();
  const rows = [];
  const map = {};                                     // wp -> [{date, price}] in EGP
  const skipped = [];

  for (const u of units) {
    const rates = u.rates || {};
    // A unit with no Default Rate gets NO rows at all — every date renders
    // BLOCKED + WhatsApp CTA. That is the correct fail-closed behaviour; do not
    // substitute a sibling unit's price (L-092: absence is a refusal, not a value).
    if (rates.defaultRate == null) {
      skipped.push({ wp: u.wp, propertyId: u.propertyId, title: u.title });
      map[u.wp] = [];
      continue;
    }

    // Guard the currency per unit rather than trusting the tenant-wide finding —
    // a single unit priced in EGP would otherwise be multiplied by 50.
    const cur = rates.currency || u.rateCurrency;
    if (cur !== cfg.RATE_CURRENCY) {
      throw new Error(
        `unit ${u.propertyId} (${u.title}) is priced in ${cur}, not ${cfg.RATE_CURRENCY} — ` +
        `refusing to apply the USD->EGP conversion blindly. Handle this unit explicitly.`,
      );
    }

    const daily = dailyPricesForSeason(rates, start, end);
    const egp = daily.map(({ date, price }) => ({
      date,
      price: Math.round(Number(price) * cfg.FX_USD_EGP),
      usd: Number(price),
    }));
    map[u.wp] = egp;
    for (const { date, price } of egp) {
      rows.push(`  (${u.wp}, ${sqlText(date)}, ${price}, 'EGP', ${sqlText(cfg.SOURCE)})`);
    }
  }

  const sql =
    `-- Silver Springs Residence — daily nightly rates for \`unit_daily_prices\`\n` +
    `-- Generated ${new Date().toISOString()} by scripts/build-prices-sql.js\n` +
    `-- Horizon ${start} .. ${end} (${HORIZON_DAYS} days, rolling — urban year-round inventory).\n` +
    `-- Named period if covered, else the operator's explicit Default Rate.\n` +
    `-- Prices converted USD -> EGP at PINNED FX ${cfg.FX_USD_EGP}.\n` +
    `INSERT INTO unit_daily_prices (wp_post_id, date, price, currency, source) VALUES\n` +
    rows.join(',\n') +
    `\nON CONFLICT (wp_post_id, date) DO UPDATE SET\n` +
    `  price = EXCLUDED.price,\n` +
    `  currency = EXCLUDED.currency,\n` +
    `  source = EXCLUDED.source;\n`;

  fs.writeFileSync(OUT, sql);
  fs.writeFileSync(MAP_OUT, JSON.stringify(map));

  const priced = units.length - skipped.length;
  console.log(`Wrote ${OUT} + ${MAP_OUT}`);
  console.log(`Horizon: ${start} .. ${end} (${HORIZON_DAYS} days), FX ${cfg.FX_USD_EGP}`);
  console.log(`Price rows: ${rows.length} across ${priced}/${units.length} units`);
  if (skipped.length) {
    console.warn(`\n⚠️  ${skipped.length} unit(s) have NO default rate -> zero price rows -> every date BLOCKED:`);
    for (const s of skipped) console.warn(`     ${s.wp} ${s.propertyId} ${s.title}`);
    console.warn(`   These must NOT be published (L-092 fail-closed).`);
  }
  console.log(`\nNote: unit_daily_prices is per-night only. The operator also advertises weekly`);
  console.log(`(~-28%) and monthly rates — NOT represented here. Confirm whether to honour them.`);
}

main();
