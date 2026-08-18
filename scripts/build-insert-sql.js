// scripts/build-insert-sql.js
// Emit an idempotent INSERT for the Silver Springs DRAFT units into Supabase
// `units`. Reads output/units/*.json (the completed content scrape) and writes
// output/silversprings-insert.sql. NO network, NO DB — pure file generation.
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const { assertCompleteScrapeUnlessForced } = require('../src/complete');

const UNITS_DIR = path.join(__dirname, '..', 'output', 'units');
const R2MAP = path.join(__dirname, '..', 'output', 'r2-photos.json');
const OUT = path.join(__dirname, '..', 'output', 'silversprings-insert.sql');
const NOTES_TAG = '[silversprings-stage 2026-08-18]';

// wp -> [R2 photo urls]. Empty {} if the upload hasn't run.
const R2 = fs.existsSync(R2MAP) ? JSON.parse(fs.readFileSync(R2MAP, 'utf8')) : {};

// --- SQL literal helpers -----------------------------------------------------
// A text literal: wrap in single quotes, doubling any internal single quote.
// Load-bearing: apostrophes occur in real titles/descriptions.
function sqlText(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlTextOrNull(v) {
  return v == null || v === '' ? 'NULL' : sqlText(v);
}
// Numeric or NULL. Rejects non-finite so a stray NaN never lands in SQL.
function sqlNum(v) {
  if (v == null) return 'NULL';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}
// Postgres text[] as ARRAY[...]::text[] — each element a normally escaped string.
function sqlTextArray(arr) {
  const items = (arr || []).map(sqlText);
  return items.length ? `ARRAY[${items.join(',')}]::text[]` : `ARRAY[]::text[]`;
}

// DEVIATION FROM ALMAZA: wp_post_id is assigned HERE, from propertyId ascending,
// not baked into the scrape by roster index. Roster order is pagination-dependent,
// so Almaza's scheme silently renumbers every unit on a re-scrape and shifts all
// ids after any newly added unit. propertyId is stable per unit and monotonic in
// creation order, so new operator inventory appends cleanly.
function loadUnits() {
  assertCompleteScrapeUnlessForced(UNITS_DIR);
  const units = fs
    .readdirSync(UNITS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(UNITS_DIR, f), 'utf8')))
    .sort((a, b) => Number(a.propertyId) - Number(b.propertyId));

  return units.map((u, i) => ({ ...u, wp: cfg.WP_BASE + i, sourceCode: `SS${String(i + 1).padStart(3, '0')}` }));
}

const COLUMNS = [
  'wp_post_id', 'source', 'source_code', 'operator_unit_code',
  'title', 'slug', 'short_description', 'the_property',
  'beds', 'baths', 'guests',
  'compound', 'area', 'city',
  'lat', 'lng', 'source_url',
  'status', 'pricing_model', 'price_currency',
  'service_fee_percent', 'cleaning_fee_egp', 'cleaning_fee_per_night',
  'amenities', 'photo_urls', 'cover_url', 'min_nights', 'notes',
];

function rowTuple(u) {
  const desc = String(u.description || '');
  // operator_unit_code: Silver Springs titles carry no operator code, so we
  // synthesise a readable one from the facets we CAN read — e.g. "SP-GF-Neutral".
  // Null when the floor is unreadable rather than inventing a placeholder.
  const opCode = u.floorCode
    ? [u.block === 'Silver Springs Residence' ? 'SSR' : 'SP', u.floorCode, u.designLine || null]
        .filter(Boolean).join('-')
    : null;

  const vals = [
    sqlNum(u.wp),                          // wp_post_id
    sqlText(cfg.SOURCE),                   // source
    sqlTextOrNull(u.sourceCode),           // source_code   SS001..SS045
    sqlTextOrNull(opCode),                 // operator_unit_code
    sqlText(u.title),                      // title
    sqlText('silversprings-' + u.slug),    // slug
    sqlText(desc.slice(0, 200)),           // short_description
    sqlText(desc),                         // the_property
    sqlNum(u.bedrooms),                    // beds
    sqlNum(u.bathrooms),                   // baths
    sqlNum(u.guestsBluekeys),              // guests — conservative min (D-022)
    sqlText('Silver Palm'),                // compound
    sqlText('New Cairo'),                  // area — EXISTING facet value, do not fragment
    sqlText('Cairo'),                      // city
    sqlNum(u.lat),                         // lat — NULL unless genuine + in bbox
    sqlNum(u.lng),                         // lng
    sqlTextOrNull(u.sourceUrl),            // source_url
    sqlText('draft'),                      // status
    sqlText('nightly'),                    // pricing_model
    sqlText('EGP'),                        // price_currency — daily rows are converted at pinned FX
    '0',                                   // service_fee_percent — 0% sanctioned partner (D-048)
    // cleaning_fee_egp: DELIBERATELY NULL. Their site advertises no cleaning fee
    // and we have not confirmed one with the operator. Writing 0 would assert
    // "there is no cleaning fee", which we do not know. The publish gate requires
    // this to be non-NULL, so a unit cannot go live on an unconfirmed fee.
    'NULL',                                // cleaning_fee_egp
    // cleaning_fee_per_night: false is the column default, but that default is an
    // ASSERTION (flat per stay) and getting it wrong under-quoted a BirdNest
    // 7-night stay by EGP 13.4k (L-065). Emitted explicitly so the assumption is
    // visible in the SQL, and it must be confirmed before publish.
    'false',                               // cleaning_fee_per_night — UNCONFIRMED
    sqlTextArray(u.amenities),             // amenities
    sqlTextArray(R2[u.wp]),                // photo_urls (R2; empty until upload runs)
    (R2[u.wp] && R2[u.wp][0]) ? sqlText(R2[u.wp][0]) : 'NULL', // cover_url
    sqlNum(u.minStay),                     // min_nights — from calendar; NULL if unknown
    sqlText(NOTES_TAG),                    // notes
  ];
  if (vals.length !== COLUMNS.length) {
    throw new Error(`tuple/column mismatch: ${vals.length} values vs ${COLUMNS.length} columns`);
  }
  return `  (${vals.join(', ')})`;
}

function main() {
  const units = loadUnits();
  if (!units.length) throw new Error(`no unit JSON in ${UNITS_DIR} — run content.js first`);

  // Content gate (L-002): never emit a row that could later be published empty.
  // We still emit photo-less rows (photos land in a later step) but we refuse to
  // emit a row with no description or no title at all.
  const junk = units.filter((u) => !u.title || String(u.description || '').trim().length < 40);
  if (junk.length) {
    throw new Error(
      `${junk.length} unit(s) have no title or a <40-char description — refusing to emit ` +
      `(L-002 empty-scrape-published-live): ${junk.map((u) => u.propertyId).join(', ')}`,
    );
  }

  // wp block must stay inside the allocated range.
  const maxWp = cfg.WP_BASE + units.length - 1;
  if (maxWp >= cfg.WP_BASE + 1000) throw new Error(`wp block overflow: ${maxWp}`);

  const dupSlug = units.map((u) => u.slug).filter((s, i, a) => a.indexOf(s) !== i);
  if (dupSlug.length) throw new Error(`duplicate slugs: ${dupSlug.join(', ')}`);

  const rows = units.map(rowTuple);
  for (const r of rows) {
    const n = (r.match(/'draft'/g) || []).length;
    if (n !== 1) throw new Error(`row does not have exactly one 'draft' literal (${n})`);
  }

  const sql =
    `-- Silver Springs Residence — ${units.length} DRAFT units for Supabase \`units\`\n` +
    `-- Generated ${new Date().toISOString()} by scripts/build-insert-sql.js\n` +
    `-- wp_post_id ${cfg.WP_BASE}..${maxWp}, assigned by propertyId ascending.\n` +
    `--\n` +
    `-- Idempotent on SLUG, not wp_post_id: units.wp_post_id has NO unique index,\n` +
    `-- so ON CONFLICT (wp_post_id) is a silent no-op (it never fires and duplicates\n` +
    `-- are inserted anyway). Kennah's ON CONFLICT (slug) is the working idiom.\n` +
    `--\n` +
    `-- PREREQUISITE — run these first or the insert fails / half-works:\n` +
    `--   ALTER TABLE public.units DROP CONSTRAINT IF EXISTS units_source_check;\n` +
    `--   ALTER TABLE public.units ADD CONSTRAINT units_source_check CHECK (source = ANY (ARRAY[\n` +
    `--     'mynt','birdnest','manual','soul','brassbell','ali','whiteglove','almaza',\n` +
    `--     'kennah','xuru','zenstays','vesta','silversprings']::text[]));\n` +
    `--   INSERT INTO ops.operator (code, name, ...) VALUES ('silversprings', ...);  -- L-058\n` +
    `INSERT INTO units (\n  ${COLUMNS.join(', ')}\n) VALUES\n` +
    rows.join(',\n') +
    `\nON CONFLICT (slug) DO NOTHING;\n`;

  fs.writeFileSync(OUT, sql);
  console.log(`Wrote ${OUT}`);
  console.log(`Rows: ${units.length} (all status='draft'), wp ${cfg.WP_BASE}..${maxWp}`);
  console.log(`⚠️  cleaning_fee_egp=NULL and cleaning_fee_per_night=false are UNCONFIRMED — confirm with operator before publish (L-065).`);
}

main();
