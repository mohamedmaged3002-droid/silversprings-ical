// send-alert.js — email the change digest, ONLY when pricewatch.js detected a real
// change (out/change-message.json exists).
//
// Unlike almaza-ical's version there is no xlsx attachment: the body carries the
// added/removed units and the price ranges, which is the whole payload. Keeping it
// text-only means the alert still delivers if a sheet build ever fails.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendEmail } = require('./src/notify');

// Attach the OTA pack when it's present, so the team gets the workbook itself and
// not just a link. Built by scripts/build-ota-xlsx.py; absent on a CI-only run,
// in which case the email still goes out text-only rather than failing.
const PACK = '/Users/MAGED/inv/Silver Springs OTA Listing Pack.xlsx';

(async () => {
  const msgPath = path.join(__dirname, 'out', 'change-message.json');
  if (!fs.existsSync(msgPath)) { console.log('send-alert: no change-message.json — no changes, no email.'); return; }
  const msg = JSON.parse(fs.readFileSync(msgPath, 'utf8'));
  if (!msg || !msg.subject) { console.log('send-alert: change-message.json has no subject — no email.'); return; }

  const dateStr = new Date().toISOString().slice(0, 10);
  const attachments = fs.existsSync(PACK)
    ? [{ filename: `Silver Springs OTA Listing Pack ${dateStr}.xlsx`, path: PACK }]
    : [];
  if (!attachments.length) console.log('send-alert: OTA pack not on disk — sending text-only.');

  const { configured, sent } = await sendEmail({ subject: msg.subject, body: msg.body, attachments });
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
