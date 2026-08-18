#!/usr/bin/env node
// Point listing_ical at the feeds we actually published.
//
// listing_ical keys the WordPress id as `wordpress_post_id`, NOT `wp_post_id` —
// mixing the two crashed the drift-detector on 2026-07-09 (reference_listing_ical_column).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { getSupabase } = require('./src/supabase');

async function main() {
  const { properties } = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs', 'index.json'), 'utf8'));
  // Only wire units with a committed .ics. A unit the guard has never let through
  // has no feed to point at, and wiring a 404 would look like a healthy row.
  const entries = properties
    .filter((p) => fs.existsSync(path.join(__dirname, 'docs', `${p.wp}.ics`)))
    // listing_ical columns are: wordpress_post_id (PK), ical_url, listing_slug,
    // sheet_code, notes, updated_at. There is NO `source` column — writing one
    // silently 400s the whole upsert.
    .map((p) => ({
      wordpress_post_id: p.wp,
      ical_url: `${cfg.PAGES_BASE_URL}/${p.wp}.ics`,
      listing_slug: p.slug,
      sheet_code: p.internalName || null,
      notes: `[${cfg.SOURCE}-ical auto]`,
      updated_at: new Date().toISOString(),
    }));

  const sb = getSupabase();
  let upserted = 0;
  for (const e of entries) {
    const { error } = await sb.from('listing_ical').upsert(e, { onConflict: 'wordpress_post_id' });
    if (error) { console.error(`  wire ${e.wordpress_post_id}: ${error.message}`); continue; }
    upserted++;
  }
  console.log(`Wired ${upserted} listing_ical rows (of ${properties.length} indexed).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
