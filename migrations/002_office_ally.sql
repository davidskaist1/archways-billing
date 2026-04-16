-- ============================================
-- Migration 002: Office Ally Clearinghouse Integration
-- Run this in Supabase SQL Editor
-- ============================================

-- Add Office Ally-specific columns to insurance_payers
ALTER TABLE insurance_payers
    ADD COLUMN IF NOT EXISTS office_ally_payer_id TEXT,
    ADD COLUMN IF NOT EXISTS routes_through_office_ally BOOLEAN NOT NULL DEFAULT false;

-- ============================================
-- ERA Files: track every 835 file processed
-- ============================================
CREATE TABLE IF NOT EXISTS era_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_name TEXT NOT NULL,
    file_size_bytes INTEGER,
    source TEXT NOT NULL DEFAULT 'office_ally',  -- 'office_ally', 'manual_upload', etc.

    -- Payment details from BPR segment
    check_number TEXT,
    check_date DATE,
    total_paid NUMERIC(12,2),
    payment_method TEXT,  -- 'CHK', 'ACH', 'NON', etc.

    -- Payer info from N1*PR
    payer_name TEXT,
    payer_id_number TEXT,
    payer_id UUID REFERENCES insurance_payers(id),

    -- Payee info from N1*PE
    payee_name TEXT,
    payee_npi TEXT,

    -- Parsing status
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'parsed', 'matched', 'error'
    claims_in_file INTEGER DEFAULT 0,
    claims_matched INTEGER DEFAULT 0,
    error_message TEXT,

    -- Raw content preserved for debugging
    raw_content TEXT,
    parsed_json JSONB,

    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_era_files_check ON era_files(check_number);
CREATE INDEX IF NOT EXISTS idx_era_files_status ON era_files(status);
CREATE INDEX IF NOT EXISTS idx_era_files_date ON era_files(check_date);

-- ============================================
-- Claim Acknowledgments (277CA): track claim-level accept/reject
-- ============================================
CREATE TABLE IF NOT EXISTS claim_acknowledgments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID REFERENCES claims(id) ON DELETE SET NULL,
    cr_claim_id TEXT,
    payer_claim_id TEXT,  -- Payer's internal ID

    status_category TEXT,  -- A1=Acknowledgment, A2=Acceptance, A3=Rejection
    status_code TEXT,
    status_description TEXT,

    ack_date DATE,
    file_name TEXT,
    raw_segment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ack_claim ON claim_acknowledgments(claim_id);
CREATE INDEX IF NOT EXISTS idx_ack_cr_claim ON claim_acknowledgments(cr_claim_id);

-- ============================================
-- Sync Log: track every SFTP sync attempt
-- ============================================
CREATE TABLE IF NOT EXISTS sync_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sync_type TEXT NOT NULL,  -- 'office_ally_era', 'office_ally_277ca', 'office_ally_full'
    triggered_by TEXT NOT NULL DEFAULT 'schedule',  -- 'schedule', 'manual', 'webhook'
    status TEXT NOT NULL DEFAULT 'running',  -- 'running', 'success', 'error', 'partial'

    files_found INTEGER DEFAULT 0,
    files_processed INTEGER DEFAULT 0,
    files_failed INTEGER DEFAULT 0,

    payments_created INTEGER DEFAULT 0,
    claims_matched INTEGER DEFAULT 0,
    acknowledgments_created INTEGER DEFAULT 0,

    error_message TEXT,
    details JSONB,

    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_type ON sync_logs(sync_type);
CREATE INDEX IF NOT EXISTS idx_sync_logs_started ON sync_logs(started_at);

-- ============================================
-- Link payments table to ERA files
-- ============================================
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS era_file_id UUID REFERENCES era_files(id) ON DELETE SET NULL;

-- ============================================
-- RLS for new tables
-- ============================================
ALTER TABLE era_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_acknowledgments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;

-- Admin full access
CREATE POLICY "admin_full_era_files" ON era_files FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_acks" ON claim_acknowledgments FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_sync_logs" ON sync_logs FOR ALL USING (get_user_role() = 'admin');

-- Billing read/write (they handle claim/payment reconciliation)
CREATE POLICY "billing_full_era_files" ON era_files FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "billing_full_acks" ON claim_acknowledgments FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "billing_read_sync_logs" ON sync_logs FOR SELECT USING (get_user_role() = 'billing');

-- Payroll read-only
CREATE POLICY "payroll_read_era_files" ON era_files FOR SELECT USING (get_user_role() = 'payroll');
CREATE POLICY "payroll_read_acks" ON claim_acknowledgments FOR SELECT USING (get_user_role() = 'payroll');
