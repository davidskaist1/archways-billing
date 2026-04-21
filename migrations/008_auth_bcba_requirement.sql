-- ============================================
-- Migration 008: BCBA + NPI on auth requests
-- Adds required BCBA assignment to authorizations
-- Run after 007
-- ============================================

ALTER TABLE authorizations
    ADD COLUMN IF NOT EXISTS requesting_bcba_id UUID REFERENCES staff(id),
    ADD COLUMN IF NOT EXISTS requesting_bcba_npi TEXT;
-- ^ BCBA NPI stored as a snapshot at time of auth — if staff member's NPI
-- changes later, this historical record stays intact

CREATE INDEX IF NOT EXISTS idx_auth_bcba ON authorizations(requesting_bcba_id);

-- Future columns for state licensing and payer credentialing
-- (placeholder for when those features are built)
ALTER TABLE staff
    ADD COLUMN IF NOT EXISTS licensed_states TEXT[],
    ADD COLUMN IF NOT EXISTS credentialed_payer_ids UUID[];

COMMENT ON COLUMN staff.licensed_states IS 'Array of 2-letter state codes where this provider is licensed. Used to filter BCBAs for auth requests.';
COMMENT ON COLUMN staff.credentialed_payer_ids IS 'Array of insurance_payers.id where this provider is credentialed. Used to filter BCBAs for auth requests by payer.';
