// src/codes.js — Silver Springs Residence
//
// DEVIATION FROM ALMAZA: Almaza titles lead with the operator's own unit code
// ("D08-G03 Beachtown 2 Bedroom Apartment" -> D08-G03). Silver Springs titles
// carry NO operator code at all. Instead they encode three facets, inconsistently
// ordered and inconsistently punctuated:
//
//   "Neutral Studio - Pool / Garden Access - GF"              line + floor
//   "Neutral - 2 Bed - TF @ Silver Springs Residence"         line + floor + block
//   "Two Bed Serviced Apartment GF @ Silver Palm"             floor + block, no line
//   "Garden View - 3 Bed Serviced Apart TF Silver Palm"       floor + block, no '@'
//   "Brand new soft light 2BR @ Silver Palm"                  block only
//
// So we derive {line, floor, block} defensively and FLAG whatever we can't read,
// rather than guessing — same discipline as Almaza's subCommunity().

// Interior design line. Roughly a third of the roster carries none.
const LINES = [
  [/\bneutral\b/i, 'Neutral'],
  [/\bmonochrome\b/i, 'Monochrome'],
  [/\bscandinavian\b/i, 'Scandinavian'],
];

function designLine(title) {
  for (const [re, name] of LINES) if (re.test(String(title || ''))) return name;
  return null;
}

// Floor token. Appears mid-title AND end-of-title, with or without a leading dash.
// GF = ground, FF = first, SF = second, TF = third.
const FLOORS = { GF: 'Ground', FF: 'First', SF: 'Second', TF: 'Third' };

function floorCode(title) {
  const m = String(title || '').match(/\b(GF|FF|SF|TF)\b/i);
  return m ? m[1].toUpperCase() : null;
}

const floorName = (code) => FLOORS[code] || null;

// The two blocks. Silver Springs Residence sits INSIDE the Silver Palm compound,
// so these are sibling buildings, not different locations — both geocode to the
// same compound. Kept because the OTA sheet and the operator's own rate talk
// distinguish them.
function block(title) {
  const t = String(title || '');
  if (/silver\s*springs/i.test(t)) return 'Silver Springs Residence';
  if (/silver\s*palm/i.test(t)) return 'Silver Palm';
  return null;
}

// Bedroom count as ADVERTISED IN THE TITLE, for cross-checking the JSON-LD's
// containsPlace.numberOfBedrooms. A mismatch is a data-quality flag, not a
// silent overwrite: Lodgify reports numberOfBedrooms=1 for studios, so
// title-says-studio + ld-says-1 is CONSISTENT, not a conflict.
function titleBedrooms(title) {
  const t = String(title || '');
  if (/\bstudio\b/i.test(t)) return 0;                       // 0 = studio
  let m = t.match(/\b(\d)\s*-?\s*(?:bed|bedroom|br)\b/i);
  if (m) return Number(m[1]);
  if (/\bone\s+bedroom\b/i.test(t)) return 1;
  if (/\btwo\s+bed(room)?\b/i.test(t)) return 2;
  if (/\bthree\s+bed(room)?\b/i.test(t)) return 3;
  return null;
}

// Silver Palm, New Cairo City. Verified genuine pin on unit 561512:
// 30.049144, 31.476398. All 45 units sit in one compound, so the box is tight —
// anything outside it is a bad pin and gets NULLed, never centroid-guessed
// (project_geocoding_quality: pin only genuine coords).
const BBOX = { minLat: 29.95, maxLat: 30.15, minLng: 31.35, maxLng: 31.60 };

function inNewCairoBbox(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  return lat >= BBOX.minLat && lat <= BBOX.maxLat && lng >= BBOX.minLng && lng <= BBOX.maxLng;
}

// House rule: capacity = bedrooms x 2, studio -> 2 (D-022). Lodgify reports
// numberOfBedrooms=1 for studios, which already yields 2.
//
// Where the operator advertises MORE than the house rule (their 3-bed sleeps 8
// on sofa beds vs our 6), take the CONSERVATIVE MINIMUM — we would rather
// under-promise capacity than have a family turned away at check-in. The
// operator's own figure is carried separately as guestsOperator for the OTA sheet.
function guestsHouseRule(bedrooms) {
  const b = Number(bedrooms) || 0;
  return b <= 1 ? 2 : b * 2;
}

function guestsConservative(bedrooms, guestsOperator) {
  const house = guestsHouseRule(bedrooms);
  const op = Number(guestsOperator);
  return Number.isFinite(op) && op > 0 ? Math.min(house, op) : house;
}

const sourceCode = (n) => `SS${String(n).padStart(3, '0')}`;

module.exports = {
  designLine, floorCode, floorName, block, titleBedrooms,
  inNewCairoBbox, guestsHouseRule, guestsConservative, sourceCode, BBOX, FLOORS,
};
