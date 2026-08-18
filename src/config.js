// Central tunables.
//
// This integration runs with the operator's agreement. Politeness is a hard
// requirement regardless (D-003): the site is Cloudflare-fronted and the rates
// host throttles under sustained load. Keep concurrency low.
//
// Commercial terms are NOT recorded here — see the private ops notes.
module.exports = {
  WEBSITE_ID: 479059,
  // Lodgify tenant slug, from the checkout URL:
  //   checkout.lodgify.com/en/silversprings/561512/reservation?currency=EGP
  TENANT: 'silversprings',
  // The custom domain is the only reachable origin — silversprings.lodgify.com
  // does NOT resolve to this tenant (verified: 403 challenge, not a tenant site).
  ORIGIN: 'https://silverspringsresidence.com',

  // DEVIATION FROM ALMAZA: Almaza's roster is '/en/{cmsPageId}/all-properties/'
  // and its unit links carry a numeric property id ('/en/{propId}/{slug}').
  // Silver Springs uses a plain '/en/properties/' roster and SLUG-ONLY unit URLs
  // ('/en/neutral-studio---pool-garden-access---gf') with NO id in the path.
  // The propertyId therefore comes from the unit page's JSON-LD `identifier`,
  // not from the roster href. See src/discover.js.
  ROSTER_PATH: '/en/properties/',

  RATES_URL: (propId) =>
    `https://websiteserver.lodgify.com/v3/websites/rates/website/479059/language/en/property/${propId}`,
  CALENDAR_URL: (propId, roomId, startDate) =>
    `https://checkout.lodgify.com/api/v1/checkout/calendar` +
    `?propertyId=${propId}&startDate=${startDate}` +
    (roomId ? `&roomId=${roomId}` : ''),

  // 12 months (~365 nights), matching the price horizon so a date is never
  // priced-but-uncalendared or vice versa. Almaza used 7 because it is a seasonal
  // beach resort; Silver Springs lets year-round.
  // The checkout calendar API returns 90 days per call (measured), so this is 5
  // calls/unit — comfortably inside fetchCalendar's 12-iteration guard, and
  // ~225 calls per sync run across 45 units (Almaza sustains ~456).
  HORIZON_MONTHS: 12,

  // Rates are quoted in USD by the API even though the storefront displays EGP
  // (verified: defaultRate.currency === 'USD', dailyPrice 104 on unit 561512).
  // Pin the FX rather than fetching a live rate, so a re-run is reproducible and
  // a quiet FX move can't silently reprice 45 units. Same approach as Brassbell.
  RATE_CURRENCY: 'USD',
  FX_USD_EGP: Number(process.env.FX_USD_EGP) || 50,

  UNIT_CONCURRENCY: Number(process.env.UNIT_CONCURRENCY) || 2,
  REQUEST_DELAY_MS: Number(process.env.REQUEST_DELAY_MS) || 750,
  PAGES_BASE_URL: 'https://mohamedmaged3002-droid.github.io/silversprings-ical',
  SOURCE: 'silversprings',                                  // units.source + notes tag
  WP_BASE: 96001,                                           // 96001..96045
  USER_AGENT:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};
