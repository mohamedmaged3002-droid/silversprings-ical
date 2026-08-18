// src/guard.js
// Decide whether a fresh scrape result may overwrite the last-good .ics.
// prev:    { availableCount } from the previous index.json entry, or null.
// current: { ok, blocked, available, errors } counts from this scrape.
function shouldWrite(prev, current, nights) {
  const { ok, blocked, available, errors } = current;
  if (!ok) return { write: false, reason: 'scrape-not-ok' };

  const classified = blocked + available;
  // An empty feed means "nothing blocked" — i.e. fully open. Publishing that off
  // a failed scrape would re-open real bookings. Fail closed.
  if (classified === 0) return { write: false, reason: 'zero-classified' };
  if (classified < nights * 0.95) return { write: false, reason: 'low-coverage' };
  if (errors > nights * 0.05) return { write: false, reason: 'too-many-errors' };

  // This fires when availability COLLAPSES vs the last good run (blocks spiked).
  // That pattern is usually a scrape glitch marking everything blocked, so we
  // keep the last-good feed rather than nuke the listing's availability.
  // NOTE: the OPPOSITE direction — blocks vanishing / availability spiking UP —
  // is the double-booking-dangerous one and is deliberately NOT guarded here;
  // that tradeoff (a naive guard livelocks on real mass-cancellations) is an
  // open operator decision (register item D7). Do not "fix" the direction here.
  if (prev && typeof prev.availableCount === 'number' && prev.availableCount > 0) {
    if (available < prev.availableCount * 0.5) {
      return { write: false, reason: 'availability-collapse' };
    }
  }
  return { write: true, reason: 'ok' };
}

module.exports = { shouldWrite };
