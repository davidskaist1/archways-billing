-- ============================================
-- Migration 009b: Investor Portal
-- Tables, views, RLS, functions
--
-- IMPORTANT: Run migration 009a FIRST (the ALTER TYPE enum).
-- Postgres requires the ALTER TYPE ADD VALUE to be committed
-- before it can be used in other statements.
-- ============================================

-- ============================================
-- TABLES
-- ============================================

-- Investors
CREATE TABLE IF NOT EXISTS investors (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    app_user_id UUID UNIQUE REFERENCES app_users(id), -- optional: their login
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    equity_percent NUMERIC(6,3),          -- ownership percentage
    investor_type TEXT DEFAULT 'equity',  -- 'equity', 'loan', 'convertible', 'other'
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Money invested
CREATE TABLE IF NOT EXISTS investor_contributions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    investor_id UUID NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
    contribution_date DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    contribution_type TEXT DEFAULT 'equity',  -- 'equity', 'loan', 'convertible'
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Money paid out
CREATE TABLE IF NOT EXISTS investor_distributions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    investor_id UUID NOT NULL REFERENCES investors(id) ON DELETE CASCADE,
    distribution_date DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    distribution_type TEXT DEFAULT 'profit_distribution',
    -- 'return_of_capital', 'profit_distribution', 'loan_repayment', 'interest'
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operating expenses (non-payroll)
CREATE TABLE IF NOT EXISTS operating_expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    expense_date DATE NOT NULL,
    category TEXT NOT NULL,
    -- 'rent', 'utilities', 'software', 'marketing', 'insurance', 'legal',
    -- 'accounting', 'office_supplies', 'travel', 'professional_services',
    -- 'taxes', 'dues_subscriptions', 'other'
    description TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    vendor TEXT,
    is_recurring BOOLEAN DEFAULT false,
    recurrence_frequency TEXT, -- 'monthly', 'quarterly', 'annually'
    notes TEXT,
    created_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON operating_expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON operating_expenses(category);

-- Pro forma scenarios
CREATE TABLE IF NOT EXISTS pro_forma_scenarios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    assumptions JSONB NOT NULL,
    outputs JSONB,
    is_default BOOLEAN DEFAULT false,
    created_by UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- VIEWS (what investors can read)
-- ============================================

-- Monthly revenue (from claims)
CREATE OR REPLACE VIEW v_monthly_revenue AS
SELECT
    DATE_TRUNC('month', COALESCE(date_paid, service_date))::DATE AS month,
    SUM(COALESCE(paid_amount, 0)) AS revenue_collected,
    SUM(COALESCE(billed_amount, 0)) AS revenue_billed,
    COUNT(*) AS claim_count,
    COUNT(DISTINCT client_id) AS distinct_clients
FROM claims
GROUP BY DATE_TRUNC('month', COALESCE(date_paid, service_date));

-- Monthly payroll costs
CREATE OR REPLACE VIEW v_monthly_payroll AS
SELECT
    DATE_TRUNC('month', period_end)::DATE AS month,
    SUM(gross_pay) AS total_payroll,
    SUM(total_hours) AS total_hours,
    COUNT(DISTINCT staff_id) AS staff_count
FROM payroll_periods
WHERE status IN ('approved', 'exported')
GROUP BY DATE_TRUNC('month', period_end);

-- Monthly operating expenses
CREATE OR REPLACE VIEW v_monthly_opex AS
SELECT
    DATE_TRUNC('month', expense_date)::DATE AS month,
    SUM(amount) AS total_opex,
    COUNT(*) AS expense_count
FROM operating_expenses
GROUP BY DATE_TRUNC('month', expense_date);

-- AR lag — average days from service to payment
CREATE OR REPLACE VIEW v_ar_lag AS
SELECT
    AVG(date_paid - service_date) AS avg_days_to_payment,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY date_paid - service_date) AS median_days,
    COUNT(*) AS claims_measured,
    DATE_TRUNC('month', date_paid)::DATE AS month
FROM claims
WHERE date_paid IS NOT NULL AND service_date IS NOT NULL AND status IN ('paid', 'partial')
GROUP BY DATE_TRUNC('month', date_paid);

-- Outstanding AR
CREATE OR REPLACE VIEW v_outstanding_ar AS
SELECT
    SUM(billed_amount - COALESCE(paid_amount, 0)) AS outstanding_total,
    COUNT(*) AS claim_count,
    AVG(CURRENT_DATE - service_date) AS avg_age_days
FROM claims
WHERE status IN ('submitted', 'partial', 'appealed');

-- Investor summary (contributions, distributions, net outstanding)
CREATE OR REPLACE VIEW v_investor_summary AS
SELECT
    i.id,
    i.app_user_id,
    i.name,
    i.email,
    i.equity_percent,
    i.investor_type,
    i.is_active,
    COALESCE(c.amount_total, 0) AS total_contributed,
    COALESCE(d.amount_total, 0) AS total_distributed,
    COALESCE(c.amount_total, 0) - COALESCE(d.amount_total, 0) AS net_outstanding,
    c.first_contribution,
    c.last_contribution
FROM investors i
LEFT JOIN LATERAL (
    SELECT
        SUM(amount) AS amount_total,
        MIN(contribution_date) AS first_contribution,
        MAX(contribution_date) AS last_contribution
    FROM investor_contributions
    WHERE investor_id = i.id
) c ON true
LEFT JOIN LATERAL (
    SELECT SUM(amount) AS amount_total
    FROM investor_distributions
    WHERE investor_id = i.id
) d ON true;

-- Business financial snapshot (aggregated)
CREATE OR REPLACE VIEW v_business_snapshot AS
SELECT
    (SELECT SUM(amount) FROM investor_contributions) AS total_capital_raised,
    (SELECT SUM(amount) FROM investor_distributions) AS total_distributions,
    (SELECT SUM(paid_amount) FROM claims WHERE status IN ('paid', 'partial')) AS lifetime_revenue,
    (SELECT SUM(gross_pay) FROM payroll_periods WHERE status IN ('approved', 'exported')) AS lifetime_payroll,
    (SELECT SUM(amount) FROM operating_expenses) AS lifetime_opex,
    (SELECT outstanding_total FROM v_outstanding_ar) AS outstanding_ar,
    (SELECT COUNT(DISTINCT id) FROM clients WHERE is_active = true) AS active_clients,
    (SELECT COUNT(DISTINCT id) FROM staff WHERE is_active = true) AS active_staff;

-- ============================================
-- RLS
-- ============================================

ALTER TABLE investors ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE pro_forma_scenarios ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "admin_full_investors" ON investors FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_contribs" ON investor_contributions FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_distribs" ON investor_distributions FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_opex" ON operating_expenses FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_proforma" ON pro_forma_scenarios FOR ALL USING (get_user_role() = 'admin');

-- Investors: read all investors table (know who else is in)
CREATE POLICY "investor_read_investors" ON investors FOR SELECT USING (get_user_role() = 'investor');

-- Investors: read only their own contributions
CREATE POLICY "investor_read_own_contribs" ON investor_contributions FOR SELECT USING (
    get_user_role() = 'investor' AND investor_id IN (
        SELECT id FROM investors WHERE app_user_id IN (
            SELECT id FROM app_users WHERE auth_user_id = auth.uid()
        )
    )
);
CREATE POLICY "investor_read_own_distribs" ON investor_distributions FOR SELECT USING (
    get_user_role() = 'investor' AND investor_id IN (
        SELECT id FROM investors WHERE app_user_id IN (
            SELECT id FROM app_users WHERE auth_user_id = auth.uid()
        )
    )
);

-- Investors: read operating expenses (aggregated for P&L)
CREATE POLICY "investor_read_opex" ON operating_expenses FOR SELECT USING (get_user_role() = 'investor');

-- Investors: read pro forma
CREATE POLICY "investor_read_proforma" ON pro_forma_scenarios FOR SELECT USING (get_user_role() = 'investor');

-- Grant investors read on views they need
-- (views inherit RLS from underlying tables, but since we aggregate,
-- we need to make sure claims/payroll/clients/staff have appropriate policies)

-- Allow investors to read aggregated data from claims/payroll/etc for the views
-- (They can't query raw rows because billing/payroll/admin policies don't cover investors,
-- but since views are SECURITY INVOKER, investor queries through views won't work.
-- Solution: create SECURITY DEFINER functions for investor-safe queries)

-- Security-definer function: get financial summary (investor-safe)
CREATE OR REPLACE FUNCTION get_business_snapshot()
RETURNS TABLE (
    total_capital_raised NUMERIC,
    total_distributions NUMERIC,
    lifetime_revenue NUMERIC,
    lifetime_payroll NUMERIC,
    lifetime_opex NUMERIC,
    outstanding_ar NUMERIC,
    active_clients BIGINT,
    active_staff BIGINT
) AS $$
    SELECT * FROM v_business_snapshot;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION get_business_snapshot() TO authenticated;

CREATE OR REPLACE FUNCTION get_monthly_financials()
RETURNS TABLE (
    month DATE,
    revenue NUMERIC,
    billed NUMERIC,
    payroll NUMERIC,
    opex NUMERIC,
    claim_count BIGINT,
    distinct_clients BIGINT
) AS $$
    SELECT
        COALESCE(r.month, p.month, o.month) AS month,
        COALESCE(r.revenue_collected, 0) AS revenue,
        COALESCE(r.revenue_billed, 0) AS billed,
        COALESCE(p.total_payroll, 0) AS payroll,
        COALESCE(o.total_opex, 0) AS opex,
        COALESCE(r.claim_count, 0) AS claim_count,
        COALESCE(r.distinct_clients, 0) AS distinct_clients
    FROM v_monthly_revenue r
    FULL OUTER JOIN v_monthly_payroll p ON r.month = p.month
    FULL OUTER JOIN v_monthly_opex o ON COALESCE(r.month, p.month) = o.month
    ORDER BY COALESCE(r.month, p.month, o.month);
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION get_monthly_financials() TO authenticated;

CREATE OR REPLACE FUNCTION get_ar_lag_monthly()
RETURNS TABLE (
    month DATE,
    avg_days NUMERIC,
    median_days NUMERIC,
    claims_measured BIGINT
) AS $$
    SELECT month, avg_days_to_payment, median_days, claims_measured FROM v_ar_lag ORDER BY month;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION get_ar_lag_monthly() TO authenticated;

CREATE OR REPLACE FUNCTION get_investor_summary_all()
RETURNS TABLE (
    id UUID,
    name TEXT,
    equity_percent NUMERIC,
    investor_type TEXT,
    total_contributed NUMERIC,
    total_distributed NUMERIC,
    net_outstanding NUMERIC,
    first_contribution DATE,
    last_contribution DATE
) AS $$
    SELECT id, name, equity_percent, investor_type, total_contributed, total_distributed,
           net_outstanding, first_contribution, last_contribution
    FROM v_investor_summary WHERE is_active = true;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION get_investor_summary_all() TO authenticated;

-- ============================================
-- TRIGGERS
-- ============================================

CREATE TRIGGER tr_investors_updated_at BEFORE UPDATE ON investors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_opex_updated_at BEFORE UPDATE ON operating_expenses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER tr_proforma_updated_at BEFORE UPDATE ON pro_forma_scenarios
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
