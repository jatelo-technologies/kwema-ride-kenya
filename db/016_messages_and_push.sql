-- Kwema Ride: in-ride messaging and push notification device tokens.

CREATE TABLE IF NOT EXISTS ride_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_id     UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    sender_id   UUID NOT NULL REFERENCES users(id),
    body        VARCHAR(500) NOT NULL CHECK (length(btrim(body)) > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ride_messages_ride_idx ON ride_messages (ride_id, created_at);

-- One row per installed app. A token belongs to the user who last registered
-- it: if a phone changes hands and someone else signs in, the token moves.
CREATE TABLE IF NOT EXISTS device_tokens (
    token       TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform    VARCHAR(10) NOT NULL CHECK (platform IN ('android', 'ios')),
    app         VARCHAR(10) NOT NULL DEFAULT 'rider' CHECK (app IN ('rider', 'driver')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens (user_id);
