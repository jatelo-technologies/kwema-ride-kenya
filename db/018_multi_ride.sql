-- Multiple rides per rider, including rides booked for other people.
--
-- A rider keeps ONE active ride per service for themselves (the old rule),
-- but may also have several active rides booked for someone else. Those carry
-- the passenger's name so the driver knows who to look for.
ALTER TABLE rides ADD COLUMN IF NOT EXISTS passenger_name  VARCHAR(120);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS passenger_phone VARCHAR(16);

DROP INDEX IF EXISTS rides_one_active_per_service;
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_own_per_service
  ON rides (rider_id, service_type)
  WHERE passenger_name IS NULL
    AND status IN ('requested', 'searching', 'accepted', 'arrived', 'in_progress');
