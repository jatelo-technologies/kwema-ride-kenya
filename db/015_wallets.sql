-- MTN Mobile Money (Uganda, Rwanda). M-Pesa and Airtel Money exist from 001.
-- Kept in its own file: a newly added enum value cannot be used in the same
-- transaction that adds it, and each migration runs in one transaction.
ALTER TYPE mno ADD VALUE IF NOT EXISTS 'mtnmomo';
