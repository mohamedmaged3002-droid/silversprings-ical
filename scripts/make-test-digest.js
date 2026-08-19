#!/usr/bin/env node
// scripts/make-test-digest.js — write the SAME out/change-message.json a real
// change would produce, so `node send-alert.js` can be exercised on demand.
//
// Why this exists: the digest only fires when the operator actually moves a price
// or their roster changes, which may be weeks apart. Until one happens you have no
// idea whether the App Password is valid, whether SMTP_USER matches the account it
// was generated on, or who is actually on NOTIFY_EMAIL. Waiting to find out at the
// moment a real change lands is how an alert path is discovered to be broken only
// after it mattered (Kennah's watch had never delivered a single email).
//
// It fabricates the MESSAGE only — it never touches prices, the baseline, or the DB.
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'out');
const CHANGED_UNITS = path.join(OUT_DIR, 'changed-units.json');
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const roster = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'roster.json'), 'utf8')).length; }
  catch { return '?'; }
})();

const subject = 'Silver Springs — TEST digest (no real change)';
const body = [
  subject,
  '',
  'This is a deliverability test, triggered by hand. Nothing changed on the operator',
  'side and nothing was written to the database.',
  '',
  'If you are reading this, the alert path works:',
  '  • the Gmail App Password is valid',
  '  • SMTP_USER matches the account it was issued on',
  '  • this address is on the recipient list',
  '',
  'A REAL digest looks like this instead:',
  '',
  '  NEW UNITS on their site (1) — not yet on BlueKeys:',
  '    + some-new-studio-gf',
  '    -> onboard: node content.js && node scripts/build-roster.js',
  '',
  '  REMOVED from their site (1) — we may still be selling these:',
  '    - some-old-unit',
  '',
  '  [wp96001] Monochrome - 3 Bedroom - Garden View - FF',
  '    2026-12-25→2026-12-31: $194 → $205  (EGP 9,803 → 10,359)',
  '',
  `Watching ${roster} units. Generated ${stamp}.`,
  'Real digests fire only on a rate-card or roster change — never on exchange-rate',
  'movement alone, which is rewritten silently because it is not actionable.',
  '',
].join('\n');

fs.mkdirSync(OUT_DIR, { recursive: true });

// Also write a representative changed-units.json so build-changes.py produces a real
// sheet and the test exercises the ATTACHMENT path — which is the whole delivery
// format. A test that only proved the text fallback would prove the wrong thing.
fs.writeFileSync(CHANGED_UNITS, JSON.stringify({
  dateStr: new Date().toISOString().slice(0, 10),
  fx: 50.5311,
  units: [{
    wp: 96001, code: 'SS001', title: 'TEST ROW — Monochrome - 3 Bedroom - Garden View - FF',
    ranges: [{ from: '2026-12-25', to: '2026-12-31', oldEgp: 194, newEgp: 205 }],
  }],
  addedUnits: ['TEST-ONLY-not-a-real-unit'],
  removedUnits: [],
}));

fs.writeFileSync(path.join(OUT_DIR, 'change-message.json'), JSON.stringify({ subject, body }));
console.log('TEST digest written to out/change-message.json — send-alert.js will deliver it.');
console.log(`subject: ${subject}`);
