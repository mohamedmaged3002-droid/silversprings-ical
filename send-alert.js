// send-alert.js — email the change digest, ONLY when pricewatch.js detected a real
// change (out/change-message.json exists).
//
// ATTACHMENT-ONLY, matching soul/almaza/kennah: when the changes sheet is present we
// send an EMPTY body — the sheet IS the message. Nobody wants to read price ranges
// as prose.
//
// The body is kept ONLY as a fallback for when build-changes.py produced no sheet
// (a build failure, or openpyxl missing). An alert that silently arrives blank is
// worse than a wordy one, so text is the safety net rather than the default.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendEmail } = require('./src/notify');

// The CHANGES sheet — just what moved, not the whole roster. Built by
// build-changes.py from out/changed-units.json. The full OTA pack is deliberately
// NOT attached: it is 45 units every day regardless of what changed, which is the
// noise this format exists to avoid. It lives in Drive at a stable link instead
// (scripts/publish-ota-pack.sh).
const CHANGES = path.join(__dirname, 'out', 'silversprings-changes.xlsx');

(async () => {
  const msgPath = path.join(__dirname, 'out', 'change-message.json');
  if (!fs.existsSync(msgPath)) { console.log('send-alert: no change-message.json — no changes, no email.'); return; }
  const msg = JSON.parse(fs.readFileSync(msgPath, 'utf8'));
  if (!msg || !msg.subject) { console.log('send-alert: change-message.json has no subject — no email.'); return; }

  const dateStr = new Date().toISOString().slice(0, 10);
  const attachments = fs.existsSync(CHANGES)
    ? [{ filename: `Silver Springs changes ${dateStr}.xlsx`, path: CHANGES }]
    : [];
  if (!attachments.length) {
    console.log('send-alert: changes sheet missing — falling back to a text body.');
  }

  // Empty body when the sheet is attached.
  const body = attachments.length ? '' : msg.body;
  const { configured, sent } = await sendEmail({ subject: msg.subject, body, attachments });
  if (!configured) {
    // Dormant-by-design: no SMTP secrets yet. Do NOT fail the run — the price
    // refresh already succeeded, and a red X every morning trains people to
    // ignore the alerts (two inbox-flooding crons had to be fixed for this).
    console.log('send-alert: SMTP not configured — change detected but NOT emailed.');
    console.log('send-alert: set SMTP_USER / SMTP_PASS (+ optional NOTIFY_EMAIL) as repo secrets to enable.');
    return;
  }
  if (!sent) process.exitCode = 1;   // configured but undelivered => surface it
})().catch((e) => { console.error(String(e)); process.exit(1); });
