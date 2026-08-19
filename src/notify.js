// Email via Gmail SMTP (nodemailer), with retry. Ported from brassbell-ical + retry loop.
// Gated on SMTP_USER/SMTP_PASS. NOTIFY_EMAIL is a comma-separated recipient list.
let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function smtpConfigured(env = process.env) {
  return Boolean(env.SMTP_USER && env.SMTP_PASS && nodemailer);
}

// Returns { configured, sent }. Retries transient send failures up to `retries` times.
// `attachments` is an optional nodemailer attachments array (e.g. [{ filename, path }]).
async function sendEmail({ subject, body, attachments = [] }, env = process.env, { retries = 3 } = {}) {
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const to = env.NOTIFY_EMAIL || user;
  if (!user || !pass) { console.log('Email: skipped (SMTP_USER/SMTP_PASS not set)'); return { configured: false, sent: false }; }
  if (!nodemailer) { console.log('Email: skipped (nodemailer not installed)'); return { configured: false, sent: false }; }

  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await transport.sendMail({ from: `BlueKeys Pricing <${user}>`, to, subject, text: body, attachments });
      console.log(`Email: sent to ${to}`);
      return { configured: true, sent: true };
    } catch (e) {
      lastErr = e;
      console.log(`Email: attempt ${attempt}/${retries} failed — ${String(e).slice(0, 160)}`);
      if (attempt < retries) await sleep(2000 * attempt);
    }
  }
  console.log('Email: giving up after retries');
  return { configured: true, sent: false, error: lastErr };
}

module.exports = { smtpConfigured, sendEmail };
