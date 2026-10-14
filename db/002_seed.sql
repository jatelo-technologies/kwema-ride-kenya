-- =====================================================================
-- Kwema Ride Kenya — seed data
--
-- IMPORTANT: the tariff figures below are PLACEHOLDERS shaped to the right
-- structure, not the rates currently in force. Before go-live, replace every
-- row with the official figures confirmed in writing by the client, and put
-- the reference in `gazette_reference`. Zones are rough rectangles to be
-- replaced with real operating boundaries.
--
-- The commission ceiling is expressed in basis points: 2500 = 25%.
-- Money is in cents of KES: 50000 = 500 KES.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Service zones
-- ---------------------------------------------------------------------

INSERT INTO service_zones (code, name_sw, name_en, boundary, allowed_categories)
VALUES (
  'NBO_METRO',
  'Nairobi',
  'Nairobi metropolitan area',
  ST_GeogFromText('MULTIPOLYGON(((
    36.6500 -1.4200,
    37.1000 -1.4200,
    37.1000 -1.1500,
    36.6500 -1.1500,
    36.6500 -1.4200
  )))'),
  '{boda,bajaji,standard,xl,express}'
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO service_zones (code, name_sw, name_en, boundary, allowed_categories, pickup_surcharge_cents)
VALUES (
  'JKIA_AIRPORT',
  'Uwanja wa Ndege wa Jomo Kenyatta',
  'Jomo Kenyatta International Airport',
  ST_GeogFromText('MULTIPOLYGON(((
    36.8900 -1.3400,
    36.9600 -1.3400,
    36.9600 -1.3000,
    36.8900 -1.3000,
    36.8900 -1.3400
  )))'),
  '{bajaji,standard,xl,express}',
  30000  -- pickup surcharge
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO service_zones (code, name_sw, name_en, boundary, allowed_categories)
VALUES (
  'MSA_METRO',
  'Mombasa',
  'Mombasa',
  ST_GeogFromText('MULTIPOLYGON(((
    39.6000 -4.1200,
    39.7500 -4.1200,
    39.7500 -3.9500,
    39.6000 -3.9500,
    39.6000 -4.1200
  )))'),
  '{boda,bajaji,standard,xl,express}'
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO service_zones (code, name_sw, name_en, boundary, allowed_categories)
VALUES (
  'KSM_METRO',
  'Kisumu',
  'Kisumu',
  ST_GeogFromText('MULTIPOLYGON(((
    34.7000 -0.1500,
    34.8200 -0.1500,
    34.8200 -0.0500,
    34.7000 -0.0500,
    34.7000 -0.1500
  )))'),
  '{boda,bajaji,standard,xl,express}'
)
ON CONFLICT (code) DO NOTHING;

-- Smaller polygon wins in zone_for_point(), so an airport surcharge applies
-- over the city tariff.

-- ---------------------------------------------------------------------
-- National tariffs (zone_id NULL — the fallback for every town)
-- ---------------------------------------------------------------------

INSERT INTO tariffs (
  zone_id, category,
  base_fare_cents, per_km_cents, per_minute_cents,
  minimum_fare_cents, cancellation_fee_cents,
  waiting_per_minute_cents, free_waiting_seconds,
  commission_bps_cap, booking_fee_bps_cap, max_surge_multiplier,
  valid_from, gazette_reference
) VALUES
  (NULL, 'boda', 5000, 2500, 200, 10000, 5000, 200, 180, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with the NTSA / county rate in force'),
  (NULL, 'bajaji', 8000, 3500, 300, 15000, 7000, 300, 180, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with the NTSA / county rate in force'),
  (NULL, 'standard', 15000, 5000, 500, 25000, 10000, 500, 180, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with the NTSA / county rate in force'),
  (NULL, 'xl', 25000, 7000, 700, 35000, 15000, 700, 180, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with the NTSA / county rate in force'),
  (NULL, 'express', 20000, 6000, 600, 30000, 12000, 600, 120, 2500, 300, 1.60, now(), 'PLACEHOLDER — replace with the NTSA / county rate in force')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Nairobi overrides — traffic makes the per-minute component matter
-- more in the capital.
-- ---------------------------------------------------------------------

INSERT INTO tariffs (
  zone_id, category,
  base_fare_cents, per_km_cents, per_minute_cents,
  minimum_fare_cents, cancellation_fee_cents,
  waiting_per_minute_cents, free_waiting_seconds,
  commission_bps_cap, booking_fee_bps_cap, max_surge_multiplier,
  valid_from, gazette_reference
)
SELECT z.id, v.category,
       v.base, v.km, v.min_rate, v.minimum, v.cancel,
       v.waiting, 180, 2500, 300, 1.60, now(),
       'PLACEHOLDER — replace with the NTSA / county rate in force'
FROM service_zones z
CROSS JOIN (VALUES
  ('boda'::vehicle_category, 6000, 2800, 300, 12000, 5000, 200),
  ('bajaji'::vehicle_category, 9000, 4000, 400, 17000, 8000, 300),
  ('standard'::vehicle_category, 17000, 5500, 600, 28000, 12000, 600),
  ('xl'::vehicle_category, 27000, 7500, 800, 38000, 17000, 800),
  ('express'::vehicle_category, 23000, 6500, 700, 33000, 14000, 700)
) AS v(category, base, km, min_rate, minimum, cancel, waiting)
WHERE z.code = 'NBO_METRO'
ON CONFLICT DO NOTHING;

-- Admin: no seeded account. Set ADMIN_PHONE (+254XXXXXXXXX) on the server and
-- the migration runner grants that number the admin role (see 007).
