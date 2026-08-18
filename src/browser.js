// src/browser.js
// All Lodgify endpoints sit behind Cloudflare, which challenges non-browser
// clients (plain curl gets "Just a moment..."). We therefore drive a REAL
// Chromium with an HONEST user-agent and issue the fetch from INSIDE a real,
// Cloudflare-cleared browser page context. It passes because the request comes
// from a genuine browser (honest TLS/JS fingerprint), NOT because a CF clearance
// cookie is forwarded — the fetch uses `credentials: 'omit'` and the spike
// proved it works with no cookie at all.
//
// D-003: do NOT add stealth/anti-detection plugins. An agreement to integrate is
// not licence to hammer the operator's servers — the rates host throttles, and an
// honest, polite client is the only acceptable technique. If honest access stops
// working, STOP and escalate rather than working around it; the operator can
// supply a Lodgify API key, which removes the need for this path entirely.
const { chromium } = require('playwright');
const cfg = require('./config');

async function openBrowser() {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: cfg.USER_AGENT });
    const page = await ctx.newPage();
    // Land on the origin once so the page is a real, Cloudflare-cleared browsing
    // context on the target origin; every later in-page fetch then inherits that
    // genuine-browser fingerprint (no cookie is relied upon — see header).
    await page.goto(cfg.ORIGIN, { waitUntil: 'domcontentloaded' });
    return { browser, page };
  } catch (e) {
    // Don't leak the Chromium process if the initial navigation fails.
    await browser.close();
    throw e;
  }
}

// Fetch JSON from inside the page (genuine-browser context; no cookie relied on).
// Throws on non-200.
async function fetchJsonInPage(page, url) {
  const out = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'omit' });
    const text = await r.text();
    return { status: r.status, text };
  }, url);
  if (out.status !== 200) {
    throw new Error(`GET ${url} -> ${out.status}: ${out.text.slice(0, 120)}`);
  }
  try {
    return JSON.parse(out.text);
  } catch {
    // A Cloudflare challenge returns HTML, not JSON — surface that clearly.
    throw new Error(`GET ${url} -> non-JSON (Cloudflare challenge?): ${out.text.slice(0, 120)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { openBrowser, fetchJsonInPage, sleep };
