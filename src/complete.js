// src/complete.js
// Guard: refuse to build anything wp-numbered from an INCOMPLETE scrape.
//
// Why this exists. wp_post_id is assigned as WP_BASE + index(propertyId ascending)
// — stable and append-friendly, but only ONCE THE ROSTER IS COMPLETE. During a
// partial scrape a lower propertyId can still arrive and shift every id after it.
// Observed live: with 21 of 45 units scraped, wp 96001 mapped to propertyId
// 561505; when 561503 landed at unit 37 it took 96001 and pushed 561505 to 96002.
//
// Building insert/price/roster SQL from a partial scrape would therefore wire
// prices and iCal feeds to the WRONG units — silently, since every row still
// looks well-formed. So every wp-numbered artifact asserts completeness first.
const fs = require('fs');
const path = require('path');

const ROSTER = path.join(__dirname, '..', 'output', 'roster.json');

// Returns { scraped, expected }. Throws unless they match.
function assertCompleteScrape(unitsDir) {
  const scraped = fs.readdirSync(unitsDir).filter((f) => f.endsWith('.json')).length;

  if (!fs.existsSync(ROSTER)) {
    throw new Error(
      `output/roster.json missing — cannot verify the scrape is complete. ` +
      `Run content.js (it writes the roster before scraping).`,
    );
  }
  const expected = JSON.parse(fs.readFileSync(ROSTER, 'utf8')).length;

  if (scraped !== expected) {
    throw new Error(
      `INCOMPLETE SCRAPE: ${scraped} unit JSONs but the roster lists ${expected}.\n` +
      `  wp_post_id is assigned by propertyId ascending, so building from a partial\n` +
      `  scrape would map prices and iCal feeds to the WRONG units.\n` +
      `  Re-run \`node content.js\` (it resumes, skipping units already scraped),\n` +
      `  then build again. Override only if you know why: FORCE_INCOMPLETE=1.`,
    );
  }
  return { scraped, expected };
}

function assertCompleteScrapeUnlessForced(unitsDir) {
  if (process.env.FORCE_INCOMPLETE === '1') {
    const scraped = fs.readdirSync(unitsDir).filter((f) => f.endsWith('.json')).length;
    console.warn(`⚠️  FORCE_INCOMPLETE=1 — building from ${scraped} units without a completeness check.`);
    console.warn(`⚠️  wp_post_id values in this output are NOT trustworthy. Do not load them into Supabase.`);
    return { scraped, expected: null };
  }
  return assertCompleteScrape(unitsDir);
}

module.exports = { assertCompleteScrape, assertCompleteScrapeUnlessForced };
