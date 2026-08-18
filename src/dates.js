// src/dates.js
const pad = (n) => String(n).padStart(2, '0');

function ymd(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}
function iso(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function parseIso(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0); // local noon avoids DST edge cases
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function nightsAhead(start, count) {
  const base = new Date(start);
  base.setHours(12, 0, 0, 0);
  const out = [];
  for (let i = 0; i < count; i++) out.push(addDays(base, i));
  return out;
}
// ['2026-08-02','2026-08-03','2026-08-10'] -> merged [start, endExclusive) ranges.
function collapseBlocked(isoDates) {
  const uniq = [...new Set(isoDates)].sort();
  const ranges = [];
  let runStart = null;
  let prev = null;
  for (const cur of uniq) {
    if (runStart === null) {
      runStart = cur;
    } else if (iso(addDays(parseIso(prev), 1)) !== cur) {
      ranges.push({ start: runStart, endExclusive: iso(addDays(parseIso(prev), 1)) });
      runStart = cur;
    }
    prev = cur;
  }
  if (runStart !== null) {
    ranges.push({ start: runStart, endExclusive: iso(addDays(parseIso(prev), 1)) });
  }
  return ranges;
}

module.exports = { ymd, iso, parseIso, addDays, nightsAhead, collapseBlocked };
