-- =====================================================================
-- Supported interface languages for Kenya: English, Swahili.
--
-- A CHECK constraint rather than an enum: languages get added over the life
-- of the product (Luganda or Kinyarwanda in a neighbouring market, say), and altering
-- a CHECK is a metadata-only operation while adding an enum value cannot be
-- done inside a transaction with other DDL.
-- =====================================================================

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_preferred_language_check;

ALTER TABLE users
  ADD CONSTRAINT users_preferred_language_check
  CHECK (preferred_language IN ('en', 'sw'));

COMMENT ON COLUMN users.preferred_language IS
  'ISO 639-1: en = English, sw = Swahili. Default en. '
  'Drives SMS, push notification and receipt language.';

-- Index only the non-default languages. The overwhelming majority of rows
-- are 'en', so a full index would be mostly dead weight; this one makes
-- "send a non-default cohort a notice" cheap without paying for the common case.
CREATE INDEX IF NOT EXISTS users_language_idx
  ON users (preferred_language)
  WHERE preferred_language <> 'en';
