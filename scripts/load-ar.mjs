// scripts/load-ar.mjs
// Merge the Arabic copy batches and upsert them into `unit_translations`.
//
// Without an `ar` row a listing renders ENGLISH on /ar — silently, with no error.
// That is currently the live state for all 48 published Kennah units, which is
// why this is a required onboarding step and not an optional polish pass.
//
// Validates hard before writing: every wp must exist in `units` under our source,
// no field may be empty, and the copy must not describe urban Cairo inventory as
// having a sea/beach/lagoon/marina (the resort-hallucination class that hit 117
// BirdNest urban flats).
//
// Usage: node scripts/load-ar.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const cfg = require('../src/config');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: '/Users/MAGED/inv/new-site/.env.local' });

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !KEY) { console.error('need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

const DRY = process.argv.includes('--dry');

async function rest(q, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${q}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${q} -> ${res.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}

// Urban Cairo has no coastline. Any of these in the Arabic copy means the model
// invented resort features (the L-006 class), and the row must not be written.
const SEA_WORDS = [
  'البحر', 'الشاطئ', 'شاطئ', 'بحري', 'اللاجون', 'لاجون', 'المارينا', 'مارينا',
  'الساحل الشمالي', 'على البحر', 'إطلالة بحرية',
];

async function main() {
  const batches = [1, 2, 3].map((n) => path.join(ROOT, 'output', `ar-out${n}.json`));
  const missing = batches.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`missing batch output: ${missing.map((f) => path.basename(f)).join(', ')}`);

  const rows = batches.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  console.log(`loaded ${rows.length} translated rows from ${batches.length} batches`);

  // --- validation -----------------------------------------------------------
  const live = await rest(`units?source=eq.${cfg.SOURCE}&select=wp_post_id,title&order=wp_post_id`);
  const liveWp = new Set(live.map((r) => r.wp_post_id));

  const problems = [];
  const seen = new Set();
  for (const r of rows) {
    if (!liveWp.has(r.wp)) problems.push(`wp ${r.wp} is not a ${cfg.SOURCE} unit`);
    if (seen.has(r.wp)) problems.push(`wp ${r.wp} appears twice`);
    seen.add(r.wp);
    for (const f of ['title', 'excerpt', 'content']) {
      if (!r[f] || !String(r[f]).trim()) problems.push(`wp ${r.wp}: empty ${f}`);
    }
    // Must actually be Arabic, not an untranslated passthrough.
    if (!/[؀-ۿ]/.test(String(r.title || ''))) problems.push(`wp ${r.wp}: title has no Arabic`);
    if (String(r.content || '').length < 120) problems.push(`wp ${r.wp}: content too short (${String(r.content || '').length})`);
    const blob = `${r.title} ${r.excerpt} ${r.content}`;
    const hit = SEA_WORDS.find((w) => blob.includes(w));
    if (hit) problems.push(`wp ${r.wp}: mentions "${hit}" — urban Cairo has no sea (L-006 hallucination)`);
  }
  const notCovered = [...liveWp].filter((w) => !seen.has(w));
  if (notCovered.length) problems.push(`${notCovered.length} unit(s) have no Arabic row: ${notCovered.join(', ')}`);

  if (problems.length) {
    console.error(`\n${problems.length} validation problem(s) — refusing to write:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`validation passed: ${rows.length} rows cover all ${liveWp.size} units, no sea-words, all Arabic`);

  if (DRY) { console.log('--dry: nothing written'); return; }

  const payload = rows.map((r) => ({
    wp_post_id: r.wp,
    locale: 'ar',
    title: r.title,
    excerpt: r.excerpt,
    content: r.content,
    features: null,
    source: 'agent-mt',
    updated_at: new Date().toISOString(),
  }));

  const out = await rest('unit_translations?on_conflict=wp_post_id,locale', {
    method: 'POST', body: payload, prefer: 'resolution=merge-duplicates,return=representation',
  });
  console.log(`unit_translations upserted: ${out.length} ar rows`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
