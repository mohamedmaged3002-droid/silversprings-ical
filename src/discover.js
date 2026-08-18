// src/discover.js
const cfg = require('./config');
const { sleep } = require('./browser');

// DEVIATION FROM ALMAZA: Almaza unit links are '/en/{numericId}/{slug}', so its
// discover could read the propertyId straight off the roster and only had to
// exclude a handful of numeric CMS page ids. Silver Springs unit links are
// SLUG-ONLY ('/en/{slug}') and structurally identical to its CMS pages, so we
// cannot tell a unit from an About page by URL shape. We therefore exclude the
// CMS pages BY NAME (they are a fixed, small set taken from the site nav) and
// resolve each slug's real propertyId later, from the unit page's JSON-LD
// `identifier` (see content.js).
const CMS_SLUGS = new Set([
  'properties', 'about-us', 'amenitiesandservices', 'our-mall', 'near-by',
  'contact-us', 'privacy-policy', 'terms-and-conditions', 'cookie-policy',
  'rental-agreement', 'faq', 'blog', 'gallery', 'reviews',
]);

function extractPropertyLinks(hrefs, cmsSlugs = CMS_SLUGS) {
  const seen = new Set();
  const out = [];
  for (const href of hrefs) {
    // Strip query/hash and any trailing slash before matching.
    const clean = String(href || '').split(/[?#]/)[0].replace(/\/+$/, '');
    const m = clean.match(/^\/en\/([a-z0-9][a-z0-9._-]*)$/i);
    if (!m) continue;
    const slug = m[1];
    const key = slug.toLowerCase();
    if (cmsSlugs.has(key) || seen.has(key)) continue;
    // A bare locale switch ('/en') or a 2-char stub is never a unit.
    if (slug.length < 4) continue;
    seen.add(key);
    out.push({ slug });
  }
  return out;
}

function totalFromResultsText(text) {
  const m = String(text).match(/(\d+)\s+Results|of\s+(\d+)\s+places/i);
  if (!m) return null;
  return Number(m[1] || m[2]);
}

// Read the roster grid currently rendered in the page.
async function readRosterDom(page) {
  return page.evaluate(() => ({
    hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    body: document.body.innerText.slice(0, 400),
  }));
}

// Walk every roster page and return the full unit list.
//
// Pagination behaves exactly as it does on Almaza: the roster is a client-rendered
// SPA that IGNORES `?page=N` (every such URL re-renders page 1), so pages are
// advanced by clicking the numbered pager BUTTONS, which carry no href. After each
// click the grid swaps client-side, often with no network hit, so we wait for the
// first slug to actually change rather than for a load event.
//
// 45 units at 12/page = 4 pages today; the cap is deliberately generous.
async function discoverRoster(page) {
  const all = [];
  const url = `${cfg.ORIGIN}${cfg.ROSTER_PATH}?adults=1&children=0&infants=0&pets=0`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  let { hrefs, body } = await readRosterDom(page);
  const expected = totalFromResultsText(body);

  for (let p = 1; p <= 20; p++) {
    const found = extractPropertyLinks(hrefs);
    const fresh = found.filter((f) => !all.some((a) => a.slug.toLowerCase() === f.slug.toLowerCase()));
    all.push(...fresh);
    console.log(`roster page ${p}: +${fresh.length} (total ${all.length})`);
    if (expected && all.length >= expected) break;      // got them all
    if (p > 1 && !fresh.length) break;                  // grid stopped advancing

    const prevFirst = found.length ? found[0].slug : null;
    const advanced = await page.evaluate((next) => {
      const btns = [...document.querySelectorAll('button, a')].filter(
        (b) => (b.textContent || '').trim() === String(next),
      );
      if (!btns.length) return false;
      btns[btns.length - 1].click();
      return true;
    }, p + 1);
    if (!advanced) break;                               // no further pages

    await page
      .waitForFunction(
        ({ prev, cms }) => {
          const first = [...document.querySelectorAll('a[href]')]
            .map((a) => a.getAttribute('href'))
            .map((h) => {
              const c = String(h || '').split(/[?#]/)[0].replace(/\/+$/, '');
              const m = c.match(/^\/en\/([a-z0-9][a-z0-9._-]*)$/i);
              return m ? m[1] : null;
            })
            .filter((s) => s && s.length >= 4 && !cms.includes(s.toLowerCase()))[0];
          return first && first !== prev;
        },
        { prev: prevFirst, cms: [...CMS_SLUGS] },
        { timeout: 20000 },
      )
      .catch(() => {});
    await sleep(cfg.REQUEST_DELAY_MS);
    ({ hrefs, body } = await readRosterDom(page));
  }

  // Reconcile against the site's own advertised count — a silent shortfall here
  // would mean we quietly onboard fewer units than exist.
  if (expected && all.length !== expected) {
    console.warn(`WARNING: roster found ${all.length} units but the site advertises ${expected}`);
  }
  return { units: all, expected };
}

module.exports = { extractPropertyLinks, totalFromResultsText, discoverRoster, CMS_SLUGS };
