-- =====================================================================
-- Trust features advertised on the website.
--
-- 1. NTSA vetting. A driver cannot be approved until an admin has checked
--    their driving licence, PSV badge and vehicle against NTSA's records
--    (eCitizen / TIMS) and recorded the check.
-- 2. Zero commission for a new driver's first days on the platform. The
--    window is stamped once, at first approval, so suspending and
--    re-approving a driver never restarts it.
-- 3. Live trip sharing. A rider or driver creates a link that shows the
--    trip live to anyone they send it to, without an account. The token is
--    the only key, so it is long and random and stops working when the trip
--    ends.
-- =====================================================================

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ntsa_verified_at   TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ntsa_verified_by   UUID REFERENCES users(id);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ntsa_reference     VARCHAR(80);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS commission_free_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ride_shares (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id     UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    token       VARCHAR(64) NOT NULL UNIQUE,
    created_by  UUID REFERENCES users(id),
    reason      VARCHAR(16) NOT NULL DEFAULT 'manual',   -- 'manual' | 'sos'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ride_shares_ride_idx ON ride_shares (ride_id);
