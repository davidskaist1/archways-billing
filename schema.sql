-- ============================================
-- Archways ABA — Billing & Payroll Schema
-- Run this in Supabase SQL Editor
-- ============================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
CREATE TYPE user_role AS ENUM ('admin', 'billing', 'payroll');
CREATE TYPE credential_type AS ENUM ('RBT', 'BCBA', 'BCaBA', 'Other');
CREATE TYPE claim_status AS ENUM ('submitted', 'paid', 'partial', 'denied', 'appealed', 'void');
CREATE TYPE session_type AS ENUM ('direct', 'supervision', 'assessment', 'parent_training', 'other');
CREATE TYPE import_type AS ENUM ('claims', 'payments', 'sessions');
CREATE TYPE payroll_status AS ENUM ('draft', 'approved', 'exported');

-- ============================================
-- TABLES
-- ============================================

-- Staff (employees)
CREATE TABLE staff (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auth_user_id UUID REFERENCES auth.users(id),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role user_role NOT NULL DEFAULT 'billing',
    credential credential_type,
    npi TEXT,
    hourly_rate NUMERIC(8,2),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_staff_auth_user ON staff(auth_user_id);
CREATE INDEX idx_staff_active ON staff(is_active);

-- Insurance Payers
CREATE TABLE insurance_payers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL UNIQUE,
    payer_id_number TEXT,
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clients (patients)
CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cr_client_id TEXT UNIQUE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    date_of_birth DATE,
    insurance_payer_id UUID REFERENCES insurance_payers(id),
    insurance_member_id TEXT,
    authorization_number TEXT,
    authorized_units_per_week INTEGER,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_clients_cr ON clients(cr_client_id);
CREATE INDEX idx_clients_payer ON clients(insurance_payer_id);

-- Contract Rates (expected rate per CPT per payer)
CREATE TABLE contract_rates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payer_id UUID NOT NULL REFERENCES insurance_payers(id) ON DELETE CASCADE,
    cpt_code TEXT NOT NULL,
    modifier TEXT,
    rate_per_unit NUMERIC(8,2) NOT NULL,
    effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date DATE,
    UNIQUE (payer_id, cpt_code, modifier, effective_date)
);

CREATE INDEX idx_contract_rates_payer ON contract_rates(payer_id);
CREATE INDEX idx_contract_rates_cpt ON contract_rates(cpt_code);

-- Import Logs (audit trail)
CREATE TABLE import_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    imported_by UUID NOT NULL REFERENCES staff(id),
    import_type import_type NOT NULL,
    file_name TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    error_details JSONB,
    source TEXT NOT NULL DEFAULT 'spreadsheet',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_import_logs_type ON import_logs(import_type);
CREATE INDEX idx_import_logs_date ON import_logs(created_at);

-- Claims
CREATE TABLE claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cr_claim_id TEXT,
    client_id UUID REFERENCES clients(id),
    payer_id UUID REFERENCES insurance_payers(id),
    rendering_provider_id UUID REFERENCES staff(id),
    service_date DATE NOT NULL,
    cpt_code TEXT NOT NULL,
    modifier TEXT,
    units NUMERIC(6,2) NOT NULL,
    billed_amount NUMERIC(10,2) NOT NULL,
    expected_amount NUMERIC(10,2),
    status claim_status NOT NULL DEFAULT 'submitted',
    date_submitted DATE,
    date_paid DATE,
    paid_amount NUMERIC(10,2) DEFAULT 0,
    adjustment_amount NUMERIC(10,2) DEFAULT 0,
    denial_reason TEXT,
    notes TEXT,
    import_log_id UUID REFERENCES import_logs(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_claims_client ON claims(client_id);
CREATE INDEX idx_claims_payer ON claims(payer_id);
CREATE INDEX idx_claims_status ON claims(status);
CREATE INDEX idx_claims_service_date ON claims(service_date);
CREATE INDEX idx_claims_cr ON claims(cr_claim_id);
CREATE INDEX idx_claims_provider ON claims(rendering_provider_id);

-- Payments
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id UUID REFERENCES claims(id) ON DELETE SET NULL,
    payer_id UUID REFERENCES insurance_payers(id),
    check_number TEXT,
    check_date DATE,
    payment_amount NUMERIC(10,2) NOT NULL,
    adjustment_amount NUMERIC(10,2) DEFAULT 0,
    adjustment_reason_code TEXT,
    adjustment_reason_text TEXT,
    patient_responsibility NUMERIC(10,2) DEFAULT 0,
    is_matched BOOLEAN NOT NULL DEFAULT false,
    import_log_id UUID REFERENCES import_logs(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_claim ON payments(claim_id);
CREATE INDEX idx_payments_payer ON payments(payer_id);
CREATE INDEX idx_payments_matched ON payments(is_matched);
CREATE INDEX idx_payments_check ON payments(check_number);

-- Sessions (for payroll)
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cr_session_id TEXT,
    staff_id UUID NOT NULL REFERENCES staff(id),
    client_id UUID REFERENCES clients(id),
    session_date DATE NOT NULL,
    start_time TIME,
    end_time TIME,
    duration_hours NUMERIC(5,2) NOT NULL,
    session_type session_type NOT NULL DEFAULT 'direct',
    cpt_code TEXT,
    is_converted BOOLEAN NOT NULL DEFAULT false,
    is_makeup BOOLEAN NOT NULL DEFAULT false,
    notes TEXT,
    import_log_id UUID REFERENCES import_logs(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_staff ON sessions(staff_id);
CREATE INDEX idx_sessions_date ON sessions(session_date);
CREATE INDEX idx_sessions_converted ON sessions(is_converted);
CREATE INDEX idx_sessions_client ON sessions(client_id);

-- Payroll Periods
CREATE TABLE payroll_periods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    staff_id UUID NOT NULL REFERENCES staff(id),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_direct_hours NUMERIC(7,2) NOT NULL DEFAULT 0,
    total_supervision_hours NUMERIC(7,2) NOT NULL DEFAULT 0,
    total_other_hours NUMERIC(7,2) NOT NULL DEFAULT 0,
    total_hours NUMERIC(7,2) NOT NULL DEFAULT 0,
    hourly_rate NUMERIC(8,2) NOT NULL,
    gross_pay NUMERIC(10,2) NOT NULL DEFAULT 0,
    status payroll_status NOT NULL DEFAULT 'draft',
    approved_by UUID REFERENCES staff(id),
    approved_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (staff_id, period_start, period_end)
);

CREATE INDEX idx_payroll_staff ON payroll_periods(staff_id);
CREATE INDEX idx_payroll_dates ON payroll_periods(period_start, period_end);
CREATE INDEX idx_payroll_status ON payroll_periods(status);

-- ============================================
-- VIEWS
-- ============================================

-- Claims Aging View
CREATE VIEW v_claims_aging AS
SELECT
    c.id,
    c.client_id,
    cl.first_name || ' ' || cl.last_name AS client_name,
    p.name AS payer_name,
    c.service_date,
    c.cpt_code,
    c.modifier,
    c.units,
    c.billed_amount,
    c.paid_amount,
    c.billed_amount - COALESCE(c.paid_amount, 0) AS outstanding_amount,
    c.status,
    CURRENT_DATE - c.service_date AS days_old,
    CASE
        WHEN CURRENT_DATE - c.service_date <= 30 THEN '0-30'
        WHEN CURRENT_DATE - c.service_date <= 60 THEN '31-60'
        WHEN CURRENT_DATE - c.service_date <= 90 THEN '61-90'
        WHEN CURRENT_DATE - c.service_date <= 120 THEN '91-120'
        ELSE '120+'
    END AS age_bucket
FROM claims c
LEFT JOIN clients cl ON c.client_id = cl.id
LEFT JOIN insurance_payers p ON c.payer_id = p.id
WHERE c.status IN ('submitted', 'partial', 'appealed');

-- Payroll Summary View
CREATE VIEW v_payroll_summary AS
SELECT
    s.staff_id,
    st.first_name || ' ' || st.last_name AS staff_name,
    st.credential,
    st.hourly_rate,
    s.session_date,
    s.session_type,
    s.duration_hours,
    s.is_converted,
    s.client_id,
    cl.first_name || ' ' || cl.last_name AS client_name
FROM sessions s
JOIN staff st ON s.staff_id = st.id
LEFT JOIN clients cl ON s.client_id = cl.id
WHERE s.is_converted = true;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_payers ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_logs ENABLE ROW LEVEL SECURITY;

-- Helper: get current user's role
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS user_role AS $$
    SELECT role FROM staff WHERE auth_user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- STAFF table policies
CREATE POLICY "admin_full_staff" ON staff FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "billing_read_staff" ON staff FOR SELECT USING (get_user_role() = 'billing');
CREATE POLICY "payroll_read_staff" ON staff FOR SELECT USING (get_user_role() = 'payroll');

-- CLIENTS table policies
CREATE POLICY "admin_full_clients" ON clients FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "billing_all_clients" ON clients FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "payroll_read_clients" ON clients FOR SELECT USING (get_user_role() = 'payroll');

-- INSURANCE_PAYERS table policies
CREATE POLICY "admin_full_payers" ON insurance_payers FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "billing_all_payers" ON insurance_payers FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "payroll_read_payers" ON insurance_payers FOR SELECT USING (get_user_role() = 'payroll');

-- CONTRACT_RATES table policies
CREATE POLICY "admin_full_rates" ON contract_rates FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "billing_all_rates" ON contract_rates FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "payroll_read_rates" ON contract_rates FOR SELECT USING (get_user_role() = 'payroll');

-- CLAIMS table policies
CREATE POLICY "admin_full_claims" ON claims FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "billing_all_claims" ON claims FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "payroll_read_claims" ON claims FOR SELECT USING (get_user_role() = 'payroll');

-- PAYMENTS table policies
CREATE POLICY "admin_full_payments" ON payments FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "billing_all_payments" ON payments FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "payroll_read_payments" ON payments FOR SELECT USING (get_user_role() = 'payroll');

-- SESSIONS table policies
CREATE POLICY "admin_full_sessions" ON sessions FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "payroll_all_sessions" ON sessions FOR ALL USING (get_user_role() = 'payroll');
CREATE POLICY "billing_read_sessions" ON sessions FOR SELECT USING (get_user_role() = 'billing');

-- PAYROLL_PERIODS table policies
CREATE POLICY "admin_full_payroll" ON payroll_periods FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "payroll_all_payroll" ON payroll_periods FOR ALL USING (get_user_role() = 'payroll');
CREATE POLICY "billing_read_payroll" ON payroll_periods FOR SELECT USING (get_user_role() = 'billing');

-- IMPORT_LOGS table policies
CREATE POLICY "admin_full_imports" ON import_logs FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "billing_all_imports" ON import_logs FOR ALL USING (get_user_role() = 'billing');
CREATE POLICY "payroll_all_imports" ON import_logs FOR ALL USING (get_user_role() = 'payroll');

-- ============================================
-- TRIGGERS: auto-update updated_at
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_staff_updated_at BEFORE UPDATE ON staff
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_clients_updated_at BEFORE UPDATE ON clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_claims_updated_at BEFORE UPDATE ON claims
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_payroll_updated_at BEFORE UPDATE ON payroll_periods
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
