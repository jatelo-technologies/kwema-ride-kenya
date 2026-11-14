-- Car pooling.
--
-- A pooled trip is ONE vehicle carrying several riders going the same way.
-- Every rider still has their own `rides` row, so payment, commission, cash
-- debt, receipts, ratings, SOS and in-trip messaging all keep working per
-- rider exactly as they do for a solo trip. The only new things are:
--
--   pool_trips        the shared vehicle's trip (one row per vehicle journey)
--   rides.pool_*      which trip a ride belongs to, and how its fare was split
--
-- Fare rule: each rider pays for their OWN leg (their distance, their time)
-- at the normal tariff, less a pool discount that applies only when another
-- rider was actually on board at the same time. Nobody pays more than solo.

CREATE TABLE pool_trips (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category        vehicle_category NOT NULL,
    -- open: others may still join. closed: finished, or every rider left.
    status          VARCHAR(8) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'closed')),
    -- The rider who started the trip. Others join around their route. Moves
    -- to the next waiting rider if the host cancels before a driver is found.
    host_ride_id    UUID,
    -- Set when the first rider's offer is accepted; pooled riders added later
    -- are always matched to this same driver and vehicle.
    driver_id       UUID REFERENCES drivers(id),
    seats_total     SMALLINT NOT NULL CHECK (seats_total BETWEEN 2 AND 14),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ
);

CREATE INDEX pool_trips_open_idx ON pool_trips (category, created_at DESC)
    WHERE status = 'open';
CREATE INDEX pool_trips_driver_idx ON pool_trips (driver_id) WHERE status = 'open';

ALTER TABLE rides
    ADD COLUMN pool_trip_id          UUID REFERENCES pool_trips(id),
    -- match : find a trip already on the road, else start one
    -- host  : start a shared trip others can browse and join
    -- join  : joined a specific trip chosen from the list
    ADD COLUMN pool_mode             VARCHAR(8)
                                     CHECK (pool_mode IN ('match', 'host', 'join')),
    -- Settlement record, so a receipt can always be rebuilt exactly.
    ADD COLUMN pool_discount_bps     INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN pool_discount_cents   BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN pool_shared_with      SMALLINT NOT NULL DEFAULT 0,
    -- What the rider was shown as the shared price at booking time.
    ADD COLUMN pool_preview_cents    BIGINT;

ALTER TABLE pool_trips
    ADD CONSTRAINT pool_trips_host_fk
    FOREIGN KEY (host_ride_id) REFERENCES rides(id) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX rides_pool_trip_idx ON rides (pool_trip_id) WHERE pool_trip_id IS NOT NULL;
CREATE INDEX rides_pool_mode_idx ON rides (requested_at DESC) WHERE pool_mode IS NOT NULL;
