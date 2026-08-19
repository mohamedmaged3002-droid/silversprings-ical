// src/fx.js — the operator's OWN USD→EGP rate, read from the same table their
// storefront converts with.
//
// WHY NOT A PINNED RATE
// Silver Springs quotes USD and displays EGP. Their storefront converts through
// Lodgify's currency table (`euroForex`, i.e. units per EUR), so:
//
//     egpPerUsd = euroForex(EGP) / euroForex(USD)
//
// Measured 2026-08-19: 58.5352 / 1.1584 = 50.5311.
//
// The brief is "same price as their website, no markup". A pinned rate cannot do
// that for long: pinning 50 put us 1.05% BELOW their own EGP prices, and pinning
// today's 50.5311 would drift the moment Lodgify's table moves. Since the price
// watch already runs daily and rewrites unit_daily_prices, reading their live rate
// each run keeps our EGP tracking theirs instead of slowly diverging.
//
// FALLBACK: if the table is unreachable we return the pinned rate and say so, and
// the caller must NOT silently treat that as authoritative — a stale FX applied to
// a fresh rate card is how you quietly misprice a whole roster.
const cfg = require('./config');

const CURRENCIES_URL = 'https://websiteserver.lodgify.com/v2/websites/currencies';

// Reads via the page context (Cloudflare challenges plain clients on this host).
async function fetchEgpPerUsd(page) {
  const out = await page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) return { status: r.status };
    const rows = await r.json();
    const pick = (code) => {
      const row = (rows || []).find((x) => x && x.code === code);
      return row ? row.euroForex : null;
    };
    return { status: 200, egp: pick('EGP'), usd: pick('USD') };
  }, CURRENCIES_URL);

  if (out.status !== 200 || !out.egp || !out.usd) {
    return { rate: cfg.FX_USD_EGP, live: false, why: `currencies table unavailable (status ${out.status})` };
  }
  const rate = out.egp / out.usd;
  // Sanity band. EGP has moved a long way historically, so the band is wide — it
  // exists to catch a garbage payload (0, NaN, a EUR-denominated figure), not to
  // second-guess a real devaluation.
  if (!Number.isFinite(rate) || rate < 20 || rate > 200) {
    return { rate: cfg.FX_USD_EGP, live: false, why: `implausible rate ${rate}` };
  }
  return { rate: Number(rate.toFixed(4)), live: true, euroForex: { egp: out.egp, usd: out.usd } };
}

module.exports = { fetchEgpPerUsd, CURRENCIES_URL };
