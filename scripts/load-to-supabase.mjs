// scripts/load-to-supabase.mjs
// Load the generated Silver Springs rows into Supabase over the service-role REST
// API, in batches. Deliberately NOT by streaming the .sql through MCP
// execute_sql: the prices payload is ~884KB and bulk literals that size are what
// L-112 warns about.
//
// Usage:
//   node scripts/load-to-supabase.mjs units     # 45 draft unit rows
//   node scripts/load-to-supabase.mjs prices    # 16,425 unit_daily_prices rows
//   node scripts/load-to-supabase.mjs photos    # patch photo_urls/cover_url after R2
//   node scripts/load-to-supabase.mjs verify    # read back and report
//
// Idempotent throughout: units upsert on slug, prices on (wp_post_id,date).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const cfg = require('../src/config');
const { assertCompleteScrapeUnlessForced } = require('../src/complete');

// Order matters: dotenv does NOT override an already-set var, so the repo-local
// .env is loaded FIRST and wins. new-site/.env.local is loaded only for R2 creds —
// its SUPABASE_SERVICE_ROLE_KEY is present but deliberately BLANK on this machine
// (the documented local-dev scrub), and loading it first would pin the key to ''.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });
dotenv.config({ path: '/Users/MAGED/inv/new-site/.env.local' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const UNITS_DIR = path.join(ROOT, 'output', 'units');

const URL_BASE = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !KEY) {
  console.error('need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (checked new-site/.env.local)');
  process.exit(1);
}

async function rest(pathAndQuery, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// Same wp derivation as every other builder — propertyId ascending from WP_BASE.
function loadScrape() {
  assertCompleteScrapeUnlessForced(UNITS_DIR);
  return fs
    .readdirSync(UNITS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(UNITS_DIR, f), 'utf8')))
    .sort((a, b) => Number(a.propertyId) - Number(b.propertyId))
    .map((u, i) => ({ ...u, wp: cfg.WP_BASE + i, sourceCode: `SS${String(i + 1).padStart(3, '0')}` }));
}

const r2map = () => {
  const p = path.join(ROOT, 'output', 'r2-photos.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
};

function unitRow(u, R2) {
  const desc = String(u.description || '');
  const opCode = u.floorCode
    ? [u.block === 'Silver Springs Residence' ? 'SSR' : 'SP', u.floorCode, u.designLine || null]
        .filter(Boolean).join('-')
    : null;
  const photos = R2[u.wp] || [];
  return {
    wp_post_id: u.wp,
    source: cfg.SOURCE,
    source_code: u.sourceCode,
    operator_unit_code: opCode,
    title: u.title,
    slug: `silversprings-${u.slug}`,
    short_description: desc.slice(0, 200),
    the_property: desc,
    beds: u.bedrooms,
    baths: u.bathrooms,
    guests: u.guestsBluekeys,
    compound: 'Silver Palm',
    area: 'New Cairo',
    city: 'Cairo',
    lat: u.lat,
    lng: u.lng,
    source_url: u.sourceUrl,
    status: 'draft',
    pricing_model: 'nightly',
    price_currency: 'EGP',
    service_fee_percent: 0,          // 0% sanctioned partner (D-048)
    cleaning_fee_egp: null,          // UNCONFIRMED — publish gate requires non-NULL
    cleaning_fee_per_night: false,   // UNCONFIRMED assumption (L-065)
    amenities: u.amenities || [],
    photo_urls: photos,
    cover_url: photos[0] || null,
    min_nights: null,                // filled from the calendar by sync
    notes: '[silversprings-stage 2026-08-18]',
  };
}

async function doUnits() {
  const units = loadScrape();
  const R2 = r2map();
  const rows = units.map((u) => unitRow(u, R2));

  // Refuse to write anything non-draft from this script, ever.
  const bad = rows.filter((r) => r.status !== 'draft');
  if (bad.length) throw new Error(`refusing: ${bad.length} non-draft row(s)`);

  const out = await rest('units?on_conflict=slug', {
    method: 'POST',
    body: rows,
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  console.log(`units upserted: ${out.length} (wp ${rows[0].wp_post_id}..${rows[rows.length - 1].wp_post_id}, all draft)`);
  const withPhotos = out.filter((r) => (r.photo_urls || []).length).length;
  console.log(`  with photo_urls: ${withPhotos}/${out.length}${withPhotos ? '' : '  (run photos-to-r2 then `load photos`)'}`);
}

async function doPrices() {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'output', 'daily-prices.json'), 'utf8'));
  const rows = [];
  for (const [wp, days] of Object.entries(map)) {
    for (const d of days) {
      rows.push({ wp_post_id: Number(wp), date: d.date, price: d.price, currency: 'EGP', source: cfg.SOURCE });
    }
  }
  console.log(`prices to load: ${rows.length}`);
  const BATCH = 2000;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await rest('unit_daily_prices?on_conflict=wp_post_id,date', {
      method: 'POST',
      body: chunk,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    done += chunk.length;
    process.stdout.write(`\r  upserted ${done}/${rows.length}`);
  }
  console.log(`\nprices done: ${done}`);
}

// After photos-to-r2.mjs has run, patch photo_urls + cover_url onto the live rows.
async function doPhotos() {
  const R2 = r2map();
  const wps = Object.keys(R2).map(Number).sort((a, b) => a - b);
  if (!wps.length) throw new Error('output/r2-photos.json is empty — run scripts/photos-to-r2.mjs first');
  let n = 0;
  for (const wp of wps) {
    const photos = R2[wp] || [];
    if (!photos.length) { console.warn(`  skip ${wp} — no photos in map`); continue; }
    await rest(`units?wp_post_id=eq.${wp}&source=eq.${cfg.SOURCE}`, {
      method: 'PATCH',
      body: { photo_urls: photos, cover_url: photos[0] },
      prefer: 'return=minimal',
    });
    n++;
  }
  console.log(`photo_urls patched on ${n} units`);
}

async function doVerify() {
  const u = await rest(
    `units?source=eq.${cfg.SOURCE}&select=wp_post_id,slug,status,beds,guests,lat,cleaning_fee_egp,min_nights,photo_urls,area,compound&order=wp_post_id`,
  );
  const statuses = u.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  const noPhotos = u.filter((r) => !(r.photo_urls || []).length).length;
  const noGeo = u.filter((r) => r.lat == null).length;
  const noClean = u.filter((r) => r.cleaning_fee_egp == null).length;

  const p = await rest(
    `unit_daily_prices?wp_post_id=gte.${cfg.WP_BASE}&wp_post_id=lte.${cfg.WP_BASE + 999}&select=wp_post_id&limit=1`,
    { prefer: 'count=exact' },
  );

  console.log(`units          : ${u.length}  ${JSON.stringify(statuses)}`);
  console.log(`  no photos    : ${noPhotos}`);
  console.log(`  no geo       : ${noGeo}`);
  console.log(`  no clean fee : ${noClean}  <- publish gate blocks these`);
  console.log(`  areas        : ${JSON.stringify([...new Set(u.map((r) => r.area))])}`);
  console.log(`  compounds    : ${JSON.stringify([...new Set(u.map((r) => r.compound))])}`);
  console.log(`price rows     : (see count header) sample wp ${p[0] && p[0].wp_post_id}`);
}

const cmd = process.argv[2];
const table = { units: doUnits, prices: doPrices, photos: doPhotos, verify: doVerify }[cmd];
if (!table) {
  console.error('usage: node scripts/load-to-supabase.mjs units|prices|photos|verify');
  process.exit(1);
}
table().catch((e) => { console.error(e.message); process.exit(1); });
