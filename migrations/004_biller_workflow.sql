-- ============================================
-- Migration 004: Biller Workflow (Phases 1-4)
-- Run this in Supabase SQL Editor
-- ============================================

-- ============================================
-- PHASE 1: Activity Log, Follow-ups
-- ============================================

-- Claim activity log — timestamped record of every action taken on a claim
CREATE TABLE IF NOT EXISTS claim_activities (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id),
    action_type TEXT NOT NULL,
    -- action types: note, called, emailed, resubmitted, appealed, denial_logged,
    -- status_changed, followup_scheduled, write_off, transferred_to_patient,
    -- payment_posted, eligibility_checked
    description TEXT NOT NULL,
    metadata JSONB,
    follow_up_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_activities_claim ON claim_activities(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_activities_user ON claim_activities(user_id);
CREATE INDEX IF NOT EXISTS idx_claim_activities_date ON claim_activities(created_at DESC);

-- Claim follow-ups — scheduled work items
CREATE TABLE IF NOT EXISTS claim_followups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    assigned_to UUID REFERENCES app_users(id),
    due_date DATE NOT NULL,
    reason TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    -- priority: low, normal, high
    completed_at TIMESTAMPTZ,
    completed_by UUID REFERENCES app_users(id),
    completion_note TEXT,
    created_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_followups_claim ON claim_followups(claim_id);
CREATE INDEX IF NOT EXISTS idx_followups_assigned ON claim_followups(assigned_to, due_date);
CREATE INDEX IF NOT EXISTS idx_followups_open ON claim_followups(due_date) WHERE completed_at IS NULL;

-- ============================================
-- PHASE 2: Denials & Appeals
-- ============================================

-- Denial codes reference (CARC/RARC codes and their categories)
CREATE TABLE IF NOT EXISTS denial_codes (
    code TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    typical_action TEXT,
    is_carc BOOLEAN DEFAULT true
);

-- Seed common CARC/RARC codes
INSERT INTO denial_codes (code, description, category, typical_action, is_carc) VALUES
    ('CO-16', 'Claim/service lacks information or has errors', 'coding', 'correct_resubmit', true),
    ('CO-18', 'Exact duplicate claim/service', 'duplicate', 'write_off', true),
    ('CO-22', 'This care may be covered by another payer per COB', 'coordination', 'correct_resubmit', true),
    ('CO-29', 'Time limit for filing has expired', 'timely_filing', 'appeal', true),
    ('CO-45', 'Charge exceeds fee schedule / maximum allowable', 'contractual', 'write_off', true),
    ('CO-50', 'Non-covered services because not deemed medically necessary', 'medical_necessity', 'appeal', true),
    ('CO-96', 'Non-covered charge(s)', 'non_covered', 'patient_responsibility', true),
    ('CO-97', 'Benefit for this service is included in payment for another service', 'bundling', 'appeal', true),
    ('CO-109', 'Claim not covered by this payer/contractor', 'coordination', 'correct_resubmit', true),
    ('CO-151', 'Payment adjusted because the payer deems info does not support level of service', 'medical_necessity', 'appeal', true),
    ('CO-167', 'Diagnosis not covered', 'coding', 'correct_resubmit', true),
    ('CO-197', 'Precertification/authorization/notification absent', 'prior_auth', 'appeal', true),
    ('CO-198', 'Precertification/authorization exceeded', 'prior_auth', 'appeal', true),
    ('CO-204', 'Service not covered under patient current benefit plan', 'non_covered', 'patient_responsibility', true),
    ('PR-1', 'Deductible amount', 'patient_responsibility', 'patient_responsibility', true),
    ('PR-2', 'Coinsurance amount', 'patient_responsibility', 'patient_responsibility', true),
    ('PR-3', 'Copayment amount', 'patient_responsibility', 'patient_responsibility', true),
    ('PR-27', 'Expenses incurred after coverage terminated', 'eligibility', 'patient_responsibility', true),
    ('PR-31', 'Patient cannot be identified as our insured', 'eligibility', 'correct_resubmit', true)
ON CONFLICT (code) DO NOTHING;

-- Denials table — one per denied claim
CREATE TABLE IF NOT EXISTS claim_denials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    denial_date DATE NOT NULL DEFAULT CURRENT_DATE,
    denial_code TEXT REFERENCES denial_codes(code),
    denial_category TEXT NOT NULL,
    -- prior_auth, medical_necessity, timely_filing, coding, patient_info,
    -- duplicate, contractual, non_covered, eligibility, coordination, bundling, other
    denial_reason TEXT,
    denied_amount NUMERIC(10,2),
    action_plan TEXT,
    -- appeal, correct_resubmit, write_off, patient_responsibility, pending_review
    appeal_deadline DATE,
    status TEXT NOT NULL DEFAULT 'open',
    -- open, in_progress, appealed, resolved, written_off
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES app_users(id),
    resolution_outcome TEXT,
    notes TEXT,
    created_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_denials_claim ON claim_denials(claim_id);
CREATE INDEX IF NOT EXISTS idx_denials_status ON claim_denials(status);
CREATE INDEX IF NOT EXISTS idx_denials_category ON claim_denials(denial_category);
CREATE INDEX IF NOT EXISTS idx_denials_deadline ON claim_denials(appeal_deadline) WHERE status IN ('open', 'in_progress');

-- Appeals
CREATE TABLE IF NOT EXISTS claim_appeals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    denial_id UUID REFERENCES claim_denials(id) ON DELETE CASCADE,
    claim_id UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    appeal_level TEXT NOT NULL DEFAULT 'first',
    -- first, second, external
    submitted_date DATE,
    deadline DATE,
    status TEXT NOT NULL DEFAULT 'draft',
    -- draft, submitted, pending, approved, denied, overturned
    reference_number TEXT,
    letter_content TEXT,
    outcome_date DATE,
    outcome_amount NUMERIC(10,2),
    notes TEXT,
    created_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appeals_claim ON claim_appeals(claim_id);
CREATE INDEX IF NOT EXISTS idx_appeals_denial ON claim_appeals(denial_id);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON claim_appeals(status);
CREATE INDEX IF NOT EXISTS idx_appeals_deadline ON claim_appeals(deadline) WHERE status IN ('draft', 'submitted', 'pending');

-- Appeal letter templates
CREATE TABLE IF NOT EXISTS appeal_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    denial_category TEXT,
    subject TEXT,
    content TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed a starter template for prior-auth denials
INSERT INTO appeal_templates (name, denial_category, subject, content, is_active) VALUES
(
    'Prior Authorization Appeal - Standard',
    'prior_auth',
    'Appeal for Prior Authorization Denial - {{patient_name}}',
    'To Whom It May Concern,

I am writing to formally appeal the denial of claim {{claim_number}} for {{patient_name}} (Member ID: {{member_id}}) for services rendered on {{service_date}}.

The claim was denied with code {{denial_code}}: {{denial_description}}.

Authorization number {{authorization_number}} was obtained prior to service delivery and covers {{cpt_code}} services for this member. A copy of the authorization letter is attached for your review.

We respectfully request that this claim be reprocessed for payment in the amount of ${{billed_amount}}.

If you require additional information, please contact our billing department at your earliest convenience.

Thank you for your prompt attention to this matter.

Sincerely,
Archways ABA Billing Department',
    true
),
(
    'Medical Necessity Appeal - Standard',
    'medical_necessity',
    'Medical Necessity Appeal - {{patient_name}}',
    'To Whom It May Concern,

I am writing to appeal the denial of claim {{claim_number}} for {{patient_name}} (Member ID: {{member_id}}) for services rendered on {{service_date}}.

The claim was denied as not medically necessary (code {{denial_code}}).

The services provided ({{cpt_code}}) were prescribed by the supervising BCBA based on the treatment plan and clinical assessment. ABA therapy is the evidence-based standard of care for autism spectrum disorder, and the services provided are consistent with the member''s individualized treatment plan.

We are attaching the following supporting documentation:
- Current treatment plan signed by supervising BCBA
- Session notes demonstrating medical necessity
- Progress reports

We respectfully request this claim be reprocessed for payment in the amount of ${{billed_amount}}.

Sincerely,
Archways ABA Billing Department',
    true
),
(
    'Timely Filing Appeal',
    'timely_filing',
    'Timely Filing Appeal - {{patient_name}}',
    'To Whom It May Concern,

I am writing to appeal the denial of claim {{claim_number}} for {{patient_name}} for services rendered on {{service_date}}.

The claim was denied for exceeding the timely filing limit (code {{denial_code}}).

[DOCUMENT YOUR REASON FOR LATE FILING HERE - e.g., the claim was originally submitted on [date] but rejected due to [issue] which was resolved on [date], and resubmitted within a reasonable timeframe]

Attached please find documentation of the original submission and subsequent actions.

We respectfully request this claim be reprocessed for payment in the amount of ${{billed_amount}}.

Sincerely,
Archways ABA Billing Department',
    true
)
ON CONFLICT DO NOTHING;

-- ============================================
-- PHASE 3: Authorizations, Patient Balances, Write-offs
-- ============================================

-- Authorizations (synced from CRM)
CREATE TABLE IF NOT EXISTS authorizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    crm_auth_id TEXT UNIQUE,
    client_id UUID REFERENCES clients(id),
    payer_id UUID REFERENCES insurance_payers(id),
    auth_number TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    approved_units INTEGER,
    approved_hours_per_week NUMERIC(6,2),
    cpt_codes TEXT[],
    status TEXT NOT NULL DEFAULT 'active',
    -- pending, approved, active, expiring, expired, denied, cancelled
    notes TEXT,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_client ON authorizations(client_id);
CREATE INDEX IF NOT EXISTS idx_auth_status ON authorizations(status);
CREATE INDEX IF NOT EXISTS idx_auth_end_date ON authorizations(end_date) WHERE status = 'active';

-- Patient responsibility / balances
CREATE TABLE IF NOT EXISTS patient_balances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID REFERENCES claims(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id),
    amount NUMERIC(10,2) NOT NULL,
    balance_type TEXT NOT NULL,
    -- copay, deductible, coinsurance, non_covered, after_write_off
    charge_date DATE NOT NULL,
    due_date DATE,
    paid_amount NUMERIC(10,2) DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'outstanding',
    -- outstanding, partial, paid, write_off, sent_to_collections
    last_statement_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_balances_client ON patient_balances(client_id);
CREATE INDEX IF NOT EXISTS idx_balances_status ON patient_balances(status);

-- Write-offs
CREATE TABLE IF NOT EXISTS write_offs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID REFERENCES claims(id),
    patient_balance_id UUID REFERENCES patient_balances(id),
    amount NUMERIC(10,2) NOT NULL,
    reason_category TEXT NOT NULL,
    -- timely_filing, contractual, small_balance, uncollectable, goodwill, bad_debt, other
    reason TEXT,
    approved_by UUID REFERENCES app_users(id),
    created_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_writeoffs_claim ON write_offs(claim_id);

-- ============================================
-- VIEWS for Phase 4 reporting
-- ============================================

-- Biller productivity view
CREATE OR REPLACE VIEW v_biller_productivity AS
SELECT
    u.id AS user_id,
    u.first_name || ' ' || u.last_name AS biller_name,
    DATE_TRUNC('day', a.created_at)::DATE AS work_date,
    COUNT(DISTINCT a.claim_id) AS claims_touched,
    COUNT(*) AS total_actions,
    COUNT(*) FILTER (WHERE a.action_type = 'called') AS calls_made,
    COUNT(*) FILTER (WHERE a.action_type = 'appealed') AS appeals_filed,
    COUNT(*) FILTER (WHERE a.action_type = 'resubmitted') AS claims_resubmitted,
    COUNT(*) FILTER (WHERE a.action_type = 'payment_posted') AS payments_posted
FROM claim_activities a
JOIN app_users u ON a.user_id = u.id
GROUP BY u.id, u.first_name, u.last_name, DATE_TRUNC('day', a.created_at);

-- First-pass resolution rate view
CREATE OR REPLACE VIEW v_first_pass_rate AS
SELECT
    DATE_TRUNC('month', c.service_date)::DATE AS month,
    c.payer_id,
    p.name AS payer_name,
    COUNT(*) AS total_claims,
    COUNT(*) FILTER (WHERE c.status = 'paid' AND NOT EXISTS (
        SELECT 1 FROM claim_denials d WHERE d.claim_id = c.id
    )) AS first_pass_paid,
    ROUND(
        (COUNT(*) FILTER (WHERE c.status = 'paid' AND NOT EXISTS (
            SELECT 1 FROM claim_denials d WHERE d.claim_id = c.id
        )))::NUMERIC / NULLIF(COUNT(*), 0) * 100,
        2
    ) AS first_pass_rate_pct
FROM claims c
LEFT JOIN insurance_payers p ON c.payer_id = p.id
GROUP BY DATE_TRUNC('month', c.service_date), c.payer_id, p.name;

-- Days in AR view
CREATE OR REPLACE VIEW v_days_in_ar AS
SELECT
    c.payer_id,
    p.name AS payer_name,
    COUNT(*) AS claims_paid,
    AVG(c.date_paid - c.service_date) AS avg_days_to_payment,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY c.date_paid - c.service_date) AS median_days_to_payment
FROM claims c
LEFT JOIN insurance_payers p ON c.payer_id = p.id
WHERE c.status = 'paid' AND c.date_paid IS NOT NULL
GROUP BY c.payer_id, p.name;

-- Authorization utilization view
CREATE OR REPLACE VIEW v_auth_utilization AS
SELECT
    a.id AS auth_id,
    a.client_id,
    cl.first_name || ' ' || cl.last_name AS client_name,
    a.auth_number,
    a.start_date,
    a.end_date,
    a.approved_units,
    COALESCE(SUM(c.units), 0) AS used_units,
    CASE
        WHEN a.approved_units > 0 THEN
            ROUND(COALESCE(SUM(c.units), 0) / a.approved_units::NUMERIC * 100, 2)
        ELSE 0
    END AS utilization_pct,
    a.end_date - CURRENT_DATE AS days_until_expiry,
    a.status
FROM authorizations a
LEFT JOIN clients cl ON a.client_id = cl.id
LEFT JOIN claims c ON c.client_id = a.client_id
    AND c.service_date BETWEEN a.start_date AND a.end_date
    AND c.cpt_code = ANY(a.cpt_codes)
WHERE a.status IN ('active', 'expiring')
GROUP BY a.id, a.client_id, cl.first_name, cl.last_name, a.auth_number,
         a.start_date, a.end_date, a.approved_units, a.status;

-- ============================================
-- RLS POLICIES
-- ============================================

ALTER TABLE claim_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE appeal_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE write_offs ENABLE ROW LEVEL SECURITY;
ALTER TABLE denial_codes ENABLE ROW LEVEL SECURITY;

-- Admin: full access to everything
CREATE POLICY "admin_full_activities" ON claim_activities FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_followups" ON claim_followups FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_denials" ON claim_denials FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_appeals" ON claim_appeals FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_templates" ON appeal_templates FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_auth" ON authorizations FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_balances" ON patient_balances FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_writeoffs" ON write_offs FOR ALL USING (get_user_role() = 'admin');

-- Billing: full CRUD on all billing-related tables
CREATE POLICY "billing_full_activities" ON claim_activities FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "billing_full_followups" ON claim_followups FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "billing_full_denials" ON claim_denials FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "billing_full_appeals" ON claim_appeals FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "billing_full_templates" ON appeal_templates FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "billing_full_auth" ON authorizations FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "billing_full_balances" ON patient_balances FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "billing_full_writeoffs" ON write_offs FOR ALL USING (get_user_role() = 'billing');

-- Payroll: read-only on billing tables
CREATE POLICY "payroll_read_activities" ON claim_activities FOR SELECT USING (get_user_role() = 'payroll');
CREATE POLICY "payroll_read_auth" ON authorizations FOR SELECT USING (get_user_role() = 'payroll');

-- Denial codes are readable by everyone
CREATE POLICY "authenticated_read_codes" ON denial_codes FOR SELECT USING (auth.role() = 'authenticated');

-- ============================================
-- TRIGGERS
-- ============================================

CREATE TRIGGER tr_denials_updated_at BEFORE UPDATE ON claim_denials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_appeals_updated_at BEFORE UPDATE ON claim_appeals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_templates_updated_at BEFORE UPDATE ON appeal_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_auth_updated_at BEFORE UPDATE ON authorizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_balances_updated_at BEFORE UPDATE ON patient_balances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Trigger: when a claim status changes to 'denied', auto-create a denial record if one doesn't exist
CREATE OR REPLACE FUNCTION auto_create_denial()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'denied' AND OLD.status != 'denied' THEN
        -- Check if a denial already exists
        IF NOT EXISTS (SELECT 1 FROM claim_denials WHERE claim_id = NEW.id AND status IN ('open', 'in_progress')) THEN
            INSERT INTO claim_denials (claim_id, denial_date, denial_category, denial_reason, denied_amount, status)
            VALUES (NEW.id, CURRENT_DATE, 'other', COALESCE(NEW.denial_reason, 'Denial auto-created from status change'), NEW.billed_amount, 'open');
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_auto_denial ON claims;
CREATE TRIGGER tr_auto_denial
    AFTER UPDATE OF status ON claims
    FOR EACH ROW EXECUTE FUNCTION auto_create_denial();
