// src/lodgify.js
// Pure parsers over already-fetched Lodgify payloads. No network in here — that
// is what makes them testable.
const { iso, parseIso, addDays } = require('./dates');

const stripHtml = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

// JSON-LD `image` may be a single string, an array of strings, or an array of
// { url } objects. Normalize all three shapes to a plain string[] and drop
// anything empty.
function normalizeImages(image) {
  if (!image) return [];
  const arr = Array.isArray(image) ? image : [image];
  return arr.map((x) => (typeof x === 'string' ? x : x && x.url)).filter(Boolean);
}

// JSON-LD "VacationRental" -> our unit record.
function parseJsonLd(ld = {}) {
  const cp = (ld && ld.containsPlace) || {};
  return {
    propertyId: ld.identifier,
    title: ld.name,
    sourceUrl: ld.url,
    description: stripHtml(ld.description),
    // Coerce non-finite coords to null so a record never carries NaN downstream.
    lat: ld.geo && Number.isFinite(Number(ld.geo.latitude)) ? Number(ld.geo.latitude) : null,
    lng: ld.geo && Number.isFinite(Number(ld.geo.longitude)) ? Number(ld.geo.longitude) : null,
    photos: normalizeImages(ld.image),
    // The REAL amenity list. Ground the copy model in this — do NOT let it invent
    // amenities (project_birdnest_resort_copy_hallucination).
    amenities: (ld.amenityFeature || []).map((a) => a.name),
    checkinTime: ld.checkinTime || null,
    checkoutTime: ld.checkoutTime || null,
    bedrooms: cp.numberOfBedrooms ?? null,
    bathrooms: cp.numberOfBathroomsTotal ?? null,
    // The operator's ADVERTISED occupancy. Goes to the OTA sheet verbatim; the
    // BlueKeys units.guests value uses the bedrooms x 2 house rule instead.
    guestsOperator: cp.occupancy ? (cp.occupancy.maxValue ?? cp.occupancy.value) : null,
  };
}

// v3 rates payload -> { roomId, currency, defaultRate, periods[] }.
// NOTE: rates come from the API ONLY. The rendered page is CDN-cached and has
// been observed serving a stale July price (20,000 vs the live 15,000).
function parseRates(json = {}) {
  const roomTypes = (json && json.roomTypes) || {};
  const key = Object.keys(roomTypes)[0];
  if (!key) return { roomId: null, currency: null, defaultRate: null, periods: [] };
  const rt = roomTypes[key];
  const periods = [];
  for (const rate of rt.rates || []) {
    for (const p of rate.periods || []) {
      periods.push({
        name: rate.name,
        price: rate.dailyPrice,
        start: String(p.startDate).slice(0, 10),
        end: String(p.endDate).slice(0, 10),
      });
    }
  }
  return {
    roomId: rt.id ?? Number(key),
    currency: (rt.defaultRate && rt.defaultRate.currency) || null,
    defaultRate: rt.defaultRate ? rt.defaultRate.dailyPrice : null,
    periods,
  };
}

// Expand seasonal periods into per-date rows — COVERED DATES ONLY.
// The default rate is deliberately NOT extrapolated across the year: a date with
// no operator-defined rate has no price, and renders BLOCKED + WhatsApp CTA.
// Inventing a winter price from a default rate would either lose money or lose
// the guest. (Mirrors the no-monthly-fallback rule in new-site/src/lib/pricing.ts.)
function ratePeriodsToDaily({ periods }) {
  const byDate = new Map();
  for (const p of periods || []) {
    let d = parseIso(p.start);
    const end = parseIso(p.end);
    while (d <= end) {
      byDate.set(iso(d), p.price); // later periods win on overlap
      d = addDays(d, 1);
    }
  }
  return [...byDate.entries()].sort().map(([date, price]) => ({ date, price }));
}

// Price EVERY date in [seasonStart, seasonEnd] using the operator's real rules:
// the named period covering the date (later periods win on overlap), else the
// operator's explicit "Default Rate". Lodgify reports useSmartPricing:false for
// this tenant, so this IS the exact per-night price — there is no finer engine.
//
// Unlike ratePeriodsToDaily (periods only), this fills gaps with the Default
// Rate — necessary because June/Sep/Oct are default-priced for ~all units, so
// periods-only left those months unpriced (=> wrongly BLOCKED). The fill is
// bounded to the operator's active season [seasonStart, seasonEnd]; dates
// outside it get no row (still BLOCKED — we don't invent off-season prices).
function dailyPricesForSeason(rates, seasonStart, seasonEnd) {
  const { defaultRate, periods } = rates || {};
  if (defaultRate == null) return [];        // no operator price at all -> no rows
  const out = [];
  let d = parseIso(seasonStart);
  const end = parseIso(seasonEnd);
  while (d <= end) {
    const day = iso(d);
    let price = defaultRate;
    for (const p of periods || []) {
      if (day >= p.start && day <= p.end) price = p.price; // later match wins
    }
    out.push({ date: day, price });
    d = addDays(d, 1);
  }
  return out;
}

// checkout/calendar payload -> blocked dates + min-stay + coverage counts.
function parseCalendar(json = {}) {
  const days = (json && json.calendar) || [];
  const blocked = [];
  const minStayByDate = {};
  let available = 0;
  let minStayMin = null;
  let minStayMax = null;
  for (const d of days) {
    if (d.isAvailable) available += 1;
    else blocked.push(d.date);
    // Lodgify sets min-stay PER DATE (e.g. 3 off-peak, 7 in peak). Taking the
    // FIRST day's value and ignoring the rest stores an arbitrary number that can
    // under-state the real minimum on peak dates — which means quoting a guest a
    // shorter minimum than the operator will actually accept.
    // Keep the whole per-date map, plus the min/max across the horizon.
    if (typeof d.minimalStay === 'number') {
      minStayByDate[d.date] = d.minimalStay;
      if (minStayMin == null || d.minimalStay < minStayMin) minStayMin = d.minimalStay;
      if (minStayMax == null || d.minimalStay > minStayMax) minStayMax = d.minimalStay;
    }
  }
  // `minStay` is the PEAK (max) requirement — the fail-safe single number. Quoting
  // a shorter minimum than the operator enforces means the booking gets rejected
  // after we've already promised the guest (and on an OTA that's a penalised
  // cancellation), so a consumer that can only hold one number must hold this one.
  // Per-date consumers should read `minStayByDate`.
  return { blocked, available, minStay: minStayMax, minStayMin, minStayMax, minStayByDate, covered: days.length };
}

// Collapse a per-date min-stay map into contiguous [from,to] ranges so the
// published index stays small (a season of dates → a handful of rows) and the
// website can answer "what's the minimum for THIS check-in date?" exactly,
// instead of applying one peak number to the whole year (L-054).
function collapseMinStay(minStayByDate = {}) {
  const out = [];
  for (const date of Object.keys(minStayByDate).sort()) {
    const min = minStayByDate[date];
    const last = out[out.length - 1];
    const nextOfLast = last && (() => {
      const d = new Date(`${last.to}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    if (last && last.min === min && nextOfLast === date) last.to = date;
    else out.push({ from: date, to: date, min });
  }
  return out;
}

module.exports = { parseJsonLd, parseRates, parseCalendar, collapseMinStay, ratePeriodsToDaily, dailyPricesForSeason, stripHtml, normalizeImages };
