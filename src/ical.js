// src/ical.js
const { ymd, parseIso } = require('./dates');

function esc(text) {
  return String(text || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
}

// iCal UTC timestamp, e.g. 20260714T201824Z
function icalStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// { wp, title, ranges:[{start, endExclusive}] } -> iCal text (\r\n terminated).
function buildIcal({ wp, title, ranges = [] }) {
  const stamp = icalStamp();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BlueKeys Almaza iCal Bridge//EN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(title)}`,
    'CALSCALE:GREGORIAN',
  ];
  for (const r of ranges) {
    const startYmd = ymd(parseIso(r.start));
    const endYmd = ymd(parseIso(r.endExclusive));
    lines.push(
      'BEGIN:VEVENT',
      // UID encodes start+end so ANY change to a range yields a NEW event. OTAs
      // sync incrementally by UID — a stable UID means a changed block is treated
      // as "unchanged" and silently never updates. See L-011.
      `UID:almaza-${wp}-${startYmd}-${endYmd}@bluekeys.co`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      'SEQUENCE:0',
      `DTSTART;VALUE=DATE:${startYmd}`,
      `DTEND;VALUE=DATE:${endYmd}`,   // DTEND is EXCLUSIVE
      'SUMMARY:BLOCKED',
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildIcal, icalStamp };
