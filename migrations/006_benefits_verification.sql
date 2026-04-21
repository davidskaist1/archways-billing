-- ============================================
-- Migration 006: Benefits Verification
-- Run this in Supabase SQL Editor after 005
-- ============================================

CREATE TABLE IF NOT EXISTS benefit_verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    payer_id UUID REFERENCES insurance_payers(id),

    status TEXT NOT NULL DEFAULT 'pending',
    -- pending, in_progress, completed, expired, not_verified

    verification_date DATE,
    verified_by UUID REFERENCES app_users(id),
    plan_year INTEGER,

    -- Network status
    network_status TEXT,  -- 'inn' (in-network) or 'oon' (out-of-network)

    -- Deductibles
    individual_deductible NUMERIC(10,2),
    individual_deductible_met NUMERIC(10,2),
    family_deductible NUMERIC(10,2),
    family_deductible_met NUMERIC(10,2),

    -- After-deductible responsibility
    after_deductible_type TEXT,  -- 'copay', 'coinsurance', 'none', 'both'
    copay_amount NUMERIC(10,2),
    coinsurance_percent NUMERIC(5,2),  -- e.g. 20.00 for 20%

    -- Out-of-pocket maximums
    individual_oop_max NUMERIC(10,2),
    individual_oop_met NUMERIC(10,2),
    family_oop_max NUMERIC(10,2),
    family_oop_met NUMERIC(10,2),

    -- Single Case Agreement
    sca_required BOOLEAN DEFAULT FALSE,
    sca_status TEXT,  -- 'not_applicable', 'not_started', 'pending', 'approved', 'denied'
    sca_notes TEXT,

    -- Fee schedule / reimbursement rate
    fee_schedule_type TEXT,
    -- 'fee_schedule' (contracted rate), 'percent_of_medicare', 'billed_charges', 'u_and_c', 'other'
    fee_schedule_percent NUMERIC(6,2),  -- e.g. 80.00 for 80% of Medicare
    fee_schedule_notes TEXT,

    -- Coverage dates
    effective_date DATE,
    termination_date DATE,

    -- Auth requirements (captured during call)
    auth_required BOOLEAN,
    auth_submission_method TEXT,  -- 'availity', 'fax', 'phone', 'online_portal', 'other'
    auth_contact_phone TEXT,
    auth_contact_notes TEXT,
    cpt_codes_covered TEXT[],

    -- Call documentation
    call_reference_number TEXT,
    call_representative TEXT,
    call_representative_id TEXT,
    call_date TIMESTAMPTZ,
    call_notes TEXT,

    -- Push-back to CRM tracking
    pushed_to_crm_at TIMESTAMPTZ,
    crm_push_status TEXT DEFAULT 'not_sent',
    -- 'not_sent', 'pending', 'pushed', 'failed'
    crm_push_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bv_client ON benefit_verifications(client_id);
CREATE INDEX IF NOT EXISTS idx_bv_status ON benefit_verifications(status);
CREATE INDEX IF NOT EXISTS idx_bv_push_status ON benefit_verifications(crm_push_status);

-- RLS
ALTER TABLE benefit_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_full_bv" ON benefit_verifications FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "billing_full_bv" ON benefit_verifications FOR ALL USING (get_user_role() = 'billing');

-- Trigger for updated_at
CREATE TRIGGER tr_bv_updated_at BEFORE UPDATE ON benefit_verifications
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- View that joins with client info for easy display
CREATE OR REPLACE VIEW v_benefit_verifications AS
SELECT
    bv.*,
    c.first_name || ' ' || c.last_name AS client_name,
    c.date_of_birth,
    c.insurance_member_id,
    c.cr_client_id,
    p.name AS payer_name,
    u.first_name || ' ' || u.last_name AS verifier_name
FROM benefit_verifications bv
LEFT JOIN clients c ON bv.client_id = c.id
LEFT JOIN insurance_payers p ON bv.payer_id = p.id
LEFT JOIN app_users u ON bv.verified_by = u.id;
