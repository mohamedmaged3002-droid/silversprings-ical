-- 001_silversprings_prereq.sql
-- Prerequisites for onboarding operator #12, Silver Springs Residence.
-- Run this BEFORE output/silversprings-insert.sql, or the insert fails on the
-- source CHECK constraint and the ops.health_check FK dies weeks later.
--
-- Verified against live schema 2026-08-18.

BEGIN;

-- 1. Widen units.source. The existing constraint (read live, not from the vault)
--    allows 12 values; we append 'silversprings' and change nothing else.
ALTER TABLE public.units DROP CONSTRAINT IF EXISTS units_source_check;
ALTER TABLE public.units ADD CONSTRAINT units_source_check CHECK (source = ANY (ARRAY[
  'mynt'::text, 'birdnest'::text, 'manual'::text, 'soul'::text, 'brassbell'::text,
  'ali'::text, 'whiteglove'::text, 'almaza'::text, 'kennah'::text, 'xuru'::text,
  'zenstays'::text, 'vesta'::text, 'silversprings'::text
]));

-- 2. Widen ops.operator.calendar_source. Discovered the hard way: this column has
--    its OWN CHECK constraint ('operator_ical','kixedo','brassbell_gen','xuru_gen',
--    'none'), so every self-generating operator must add its *_gen value here too.
--    The first attempt at this migration failed on it (transaction rolled back
--    cleanly, so nothing was half-applied).
--
--    NOTE: ops.operator lists almaza as 'operator_ical' even though almaza-ical
--    self-generates its feeds exactly as we do — that row is mislabelled. Left
--    alone rather than "fixed" in passing, but don't copy it as precedent.
ALTER TABLE ops.operator DROP CONSTRAINT IF EXISTS operator_calendar_source_check;
ALTER TABLE ops.operator ADD CONSTRAINT operator_calendar_source_check CHECK (calendar_source = ANY (ARRAY[
  'operator_ical'::text, 'kixedo'::text, 'brassbell_gen'::text, 'xuru_gen'::text,
  'silversprings_gen'::text, 'none'::text
]));

-- 3. Register the operator in ops.operator IN THE SAME PASS.
--    L-058: this is the single most-repeated onboarding miss in the vault — it
--    fired for Almaza and White Glove, then recurred for Kennah AND Zen Stays.
--    ops.health_check.operator FKs this table, so a missing row surfaces as a
--    broken health check weeks after the onboarding "finished".
--
--    calendar_source follows the *_gen convention used by brassbell_gen / xuru_gen:
--    we generate the .ics ourselves from the operator's Lodgify checkout calendar.
--    If Silver Springs later hands over their real Lodgify export URLs, change this
--    to 'operator_ical' (and drop the generator).
INSERT INTO ops.operator (
  code, display_name, price_source, price_source_ref,
  photo_store, calendar_source, listing_source, active
) VALUES (
  'silversprings',
  'Silver Springs Residence',
  'scraped',
  'websiteserver.lodgify.com/v3/websites/rates/website/479059 (USD, pinned FX 50)',
  'r2',
  'silversprings_gen',
  'scraped',
  true
)
ON CONFLICT (code) DO NOTHING;

COMMIT;

-- Post-run check (L-058's own prevention rule): these two should agree.
--   select source, count(*) from public.units group by source order by source;
--   select code from ops.operator order by code;
