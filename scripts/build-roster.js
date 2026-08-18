// scripts/build-roster.js
// Turn the local content scrape (output/units/*.json) into the small, COMMITTED
// roster that sync.js reads in CI: data/units.json = [{wp, propertyId, roomId, title, slug}].
//
// sync.js runs in GitHub Actions and must NOT re-scrape content — it only needs
// the ids to hit the calendar endpoint. Keeping this roster committed is what
// makes the cron job light.
//
// wp assignment MUST match scripts/build-insert-sql.js exactly (propertyId
// ascending from cfg.WP_BASE) or the .ics feeds get wired to the wrong units.
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const { assertCompleteScrapeUnlessForced } = require('../src/complete');

const UNITS_DIR = path.join(__dirname, '..', 'output', 'units');
const OUT_DIR = path.join(__dirname, '..', 'data');
const OUT = path.join(OUT_DIR, 'units.json');

function main() {
  assertCompleteScrapeUnlessForced(UNITS_DIR);
  const units = fs
    .readdirSync(UNITS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(UNITS_DIR, f), 'utf8')))
    .sort((a, b) => Number(a.propertyId) - Number(b.propertyId));

  if (!units.length) throw new Error(`no unit JSON in ${UNITS_DIR} — run content.js first`);

  const roster = units.map((u, i) => ({
    wp: cfg.WP_BASE + i,
    propertyId: u.propertyId,
    // roomId is REQUIRED by the calendar endpoint — it returns HTTP 400 without
    // one. A null here would fold the unit to a fail-closed SKIP every run, so
    // refuse to emit the roster rather than ship a permanently-broken entry.
    roomId: u.rates && u.rates.roomId,
    title: u.title,
    slug: u.slug,
  }));

  const noRoom = roster.filter((r) => !r.roomId);
  if (noRoom.length) {
    throw new Error(
      `${noRoom.length} unit(s) have no roomId — the calendar endpoint would 400 for them ` +
      `every run: ${noRoom.map((r) => `${r.wp}/${r.propertyId}`).join(', ')}. ` +
      `Re-run content.js for these units before building the roster.`,
    );
  }

  const dupWp = roster.map((r) => r.wp).filter((w, i, a) => a.indexOf(w) !== i);
  if (dupWp.length) throw new Error(`duplicate wp: ${dupWp.join(', ')}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(roster, null, 2));
  console.log(`Wrote ${OUT}`);
  console.log(`Roster: ${roster.length} units, wp ${roster[0].wp}..${roster[roster.length - 1].wp}`);
}

main();
