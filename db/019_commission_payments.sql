-- Drivers can pay the commission they owe from the app. These payments are
-- ordinary collection rows with no ride; `purpose` says which kind of money
-- moved so the webhook credits the wallet instead of marking a ride paid.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS purpose VARCHAR(16) NOT NULL DEFAULT 'ride';
CREATE INDEX IF NOT EXISTS transactions_commission_idx
  ON transactions (user_id, created_at DESC) WHERE purpose = 'commission';
