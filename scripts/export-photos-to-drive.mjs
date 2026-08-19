// scripts/export-photos-to-drive.mjs
// Export each unit's photos to a per-unit Google Drive folder for the OTA team,
// then collect a shareable link per folder into output/drive-links.json.
//
// ⚠️ PULLS FROM THE OPERATOR'S CDN, NOT OUR R2 RENDITIONS (Brain L-086).
// Measured on this roster:
//     operator original   8192x5464   10.7 MB
//     THIS EXPORT (w=4000) 4000x2668  ~0.32 MB   <- what we ship
//     our R2 web copy     1920x1281   101 KB     <- what a lazy export would ship
//
// L-086 forbids shipping the R2 web copy, because 1920px sits below the OTA pixel
// floors and the defect is invisible to any count-based reconciliation. We are NOT
// doing that. We are also, deliberately, NOT shipping the 8192px master:
//
//   * observed upload throughput to this Drive is ~8 MB/min, so 813 originals
//     (~8.3 GB) is a ~17-hour transfer, vs ~35 min at w=4000;
//   * 4000x2668 clears Booking.com's 2048px recommendation and Airbnb's guidance
//     with better than 2x margin, so it is above every floor we list against.
//
// Stating it plainly, per L-086's own rule that a downscale must never be silent:
// THIS EXPORT IS 4000px, NOT THE 8192px MASTER. The masters remain retrievable
// from l.icdbcdn.com on demand (bare URL, no ?w=) if an OTA ever demands more.
// The shipped resolution is recorded per unit in output/drive-links.json.
//
// Drive account: the `bluekeys:` rclone remote == maged@bluekeys.co (6 TB).
// NOT `gdrive:` — that is a different account and the prior Brassbell export
// landed there.
//
// Disk-safe: this Mac runs 96-99% full and the full export is ~8 GB, so photos
// are staged ONE UNIT AT A TIME and the temp dir is deleted after each upload.
// Resumable: completed units are recorded in output/drive-links.json and skipped.
//
// Usage: node scripts/export-photos-to-drive.mjs [wp ...]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cfg = require('../src/config');
const { assertCompleteScrapeUnlessForced } = require('../src/complete');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const UNITS = path.join(ROOT, 'output', 'units');
const OUT = path.join(ROOT, 'output', 'drive-links.json');

const REMOTE = 'bluekeys:';
const BASE = 'BlueKeys Photos/Silver Springs Unit Photos';
const PARALLEL = 6;                       // concurrent source downloads
const WIDTH = Number(process.env.EXPORT_WIDTH) || 4000;   // px on the long edge

const only = process.argv.slice(2).map(Number).filter(Boolean);

// Folder name the OTA team reads in Drive. Code first so it sorts by our order.
const sanitize = (s) => String(s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
const folderFor = (u) => `${u.sourceCode} - ${sanitize(u.title).slice(0, 80)}`;

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function fetchAll(urls, dir) {
  const got = [];
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      // ?w=4000 -> 4000x2668 from the operator's CDN. See the header: this is a
      // deliberate, documented resolution choice, not the R2 web copy.
      // Percent-encode: filenames can carry spaces and 404 silently otherwise.
      const src = encodeURI(urls[idx]).replace(/%25([0-9A-Fa-f]{2})/g, '%$1') + `?w=${WIDTH}`;
      const name = `${String(idx).padStart(2, '0')}-${path.basename(src.split('?')[0])}`;
      try {
        const res = await fetch(src);
        if (!res.ok) { console.warn(`    #${idx} -> ${res.status}`); continue; }
        fs.writeFileSync(path.join(dir, name), Buffer.from(await res.arrayBuffer()));
        got.push(name);
      } catch (e) { console.warn(`    #${idx} ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return got;
}

async function main() {
  assertCompleteScrapeUnlessForced(UNITS);
  let units = fs.readdirSync(UNITS).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(UNITS, f), 'utf8')))
    .sort((a, b) => Number(a.propertyId) - Number(b.propertyId))
    .map((u, i) => ({ ...u, wp: cfg.WP_BASE + i, sourceCode: `SS${String(i + 1).padStart(3, '0')}` }));
  if (only.length) units = units.filter((u) => only.includes(u.wp));

  const links = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  let done = 0;

  for (const u of units) {
    const folder = folderFor(u);
    const expected = (u.photos || []).length;
    const prev = links[u.wp];
    if (prev && prev.photos === expected && prev.url) {
      console.log(`SKIP ${u.wp} ${u.sourceCode} — already exported (${expected})`);
      continue;
    }
    if (!expected) { console.warn(`SKIP ${u.wp} — no photos`); continue; }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ssdrive-${u.wp}-`));
    try {
      const got = await fetchAll(u.photos, tmp);
      const bytes = got.reduce((a, n) => a + fs.statSync(path.join(tmp, n)).size, 0);

      sh('rclone', ['copy', tmp, `${REMOTE}${BASE}/${folder}`, '--transfers', '4', '--drive-chunk-size', '32M']);

      // Shareable link for the folder (anyone-with-link reader).
      let url = '';
      try {
        url = sh('rclone', ['link', `${REMOTE}${BASE}/${folder}`]).trim();
      } catch (e) {
        console.warn(`    link failed for ${folder}: ${String(e.message).slice(0, 120)}`);
      }

      links[u.wp] = {
        code: u.sourceCode, folder, url,
        // Recorded so the shipped resolution is auditable and never has to be
        // inferred from file size (L-117: judge photos by pixels, not bytes).
        exportWidth: WIDTH,
        photos: got.length, expected,
        mb: Math.round(bytes / 1e6),
        exportedAt: new Date().toISOString(),
      };
      fs.writeFileSync(OUT, JSON.stringify(links, null, 2));   // checkpoint per unit
      done++;
      const short = got.length !== expected ? `  ⚠️ LOST ${expected - got.length}` : '';
      console.log(`OK ${u.wp} ${u.sourceCode} — ${got.length}/${expected} originals, ${Math.round(bytes / 1e6)}MB${short}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });        // keep the disk clean
    }
  }

  const shortfalls = Object.values(links).filter((l) => l.photos !== l.expected);
  const noLink = Object.values(links).filter((l) => !l.url);
  console.log(`\nExported ${done} unit(s) this run. Total in map: ${Object.keys(links).length}`);
  console.log(`Total size: ${Object.values(links).reduce((a, l) => a + (l.mb || 0), 0)} MB`);
  if (shortfalls.length) {
    console.warn(`⚠️  ${shortfalls.length} unit(s) short of the operator's photo count:`);
    for (const s of shortfalls) console.warn(`     ${s.code} ${s.photos}/${s.expected}  ${s.folder}`);
    process.exitCode = 1;
  }
  if (noLink.length) console.warn(`⚠️  ${noLink.length} folder(s) have no share link — re-run to retry.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
