-- ============================================
-- Migration 010: Investor portal updates
-- - Adds "last cycle" metrics function for dashboard
-- - Seeds default operating expenses from MO Pro Forma
-- - Seeds default pro forma scenario from MO Pro Forma
-- ============================================

-- RPC: last billing cycle metrics (investor-safe aggregate only)
-- Returns clients billed, 97153 hours, and total revenue for a given period
CREATE OR REPLACE FUNCTION get_cycle_metrics(days_back INTEGER DEFAULT 30)
RETURNS TABLE (
    period_start DATE,
    period_end DATE,
    clients_billed BIGINT,
    total_hours_97153 NUMERIC,
    total_hours_all NUMERIC,
    total_claims BIGINT,
    total_billed NUMERIC,
    total_paid NUMERIC
) AS $$
    SELECT
        (CURRENT_DATE - days_back)::DATE AS period_start,
        CURRENT_DATE AS period_end,
        COUNT(DISTINCT client_id) AS clients_billed,
        COALESCE(SUM(CASE WHEN cpt_code = '97153' THEN units / 4.0 ELSE 0 END), 0) AS total_hours_97153,
        COALESCE(SUM(units / 4.0), 0) AS total_hours_all,
        COUNT(*) AS total_claims,
        COALESCE(SUM(billed_amount), 0) AS total_billed,
        COALESCE(SUM(paid_amount), 0) AS total_paid
    FROM claims
    WHERE service_date >= (CURRENT_DATE - days_back)::DATE;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION get_cycle_metrics(INTEGER) TO authenticated;

-- ============================================
-- Seed operating expenses from MO Pro Forma
-- (idempotent — uses ON CONFLICT DO NOTHING via description uniqueness)
-- ============================================

-- Monthly recurring operational costs from the pro forma model
INSERT INTO operating_expenses (expense_date, category, description, amount, vendor, is_recurring, recurrence_frequency, notes) VALUES
    -- Software / SaaS
    (CURRENT_DATE, 'software', 'Central Reach (EHR)', 2700.00, 'Central Reach', true, 'monthly', 'Pro forma estimate: $90/employee/month × 30 employees'),
    (CURRENT_DATE, 'software', 'Brellium (clinical review)', 1800.00, 'Brellium', true, 'monthly', 'Pro forma: $1,800/month per 30 clients; adjust as clients grow'),
    (CURRENT_DATE, 'software', 'Leadtrap AI Chatbot', 800.00, 'Leadtrap', true, 'monthly', NULL),
    (CURRENT_DATE, 'software', 'Apploi (recruiting)', 833.33, 'Apploi', true, 'monthly', 'Pro forma: $10,000/year'),
    (CURRENT_DATE, 'software', 'Payroll Software', 833.33, NULL, true, 'monthly', 'Pro forma: $10,000/year'),
    -- Marketing / advertising
    (CURRENT_DATE, 'marketing', 'Marketing Company (website, branding)', 5000.00, NULL, true, 'monthly', 'Pro forma ramps to $10k/mo'),
    (CURRENT_DATE, 'marketing', 'Digital Advertising (Google, FB, etc.)', 5000.00, NULL, true, 'monthly', 'Pro forma ramps to $10k/mo'),
    (CURRENT_DATE, 'marketing', 'Indeed (recruiting ads)', 2500.00, 'Indeed', true, 'monthly', 'Pro forma: scales with growth'),
    -- Insurance / legal / accounting
    (CURRENT_DATE, 'insurance', 'Liability Insurance', 166.67, NULL, true, 'monthly', 'Pro forma: $2,000/year'),
    (CURRENT_DATE, 'legal', 'Legal Retainer', 833.33, NULL, true, 'monthly', 'Pro forma: $10,000/year'),
    (CURRENT_DATE, 'accounting', 'Accounting', 500.00, NULL, true, 'monthly', 'Pro forma estimate; adjust to actual'),
    -- Other / IT
    (CURRENT_DATE, 'utilities', 'IT, Phone & Internet', 1250.00, NULL, true, 'monthly', 'Pro forma: $15,000/year'),
    (CURRENT_DATE, 'professional_services', 'Overseas Assistant (1 FTE day one)', 2500.00, NULL, true, 'monthly', NULL)
ON CONFLICT DO NOTHING;

-- One-time startup expenses
INSERT INTO operating_expenses (expense_date, category, description, amount, vendor, is_recurring, notes) VALUES
    (CURRENT_DATE, 'legal', 'Startup: Legal (entity formation, contracts)', 10000.00, NULL, false, 'One-time startup cost from MO Pro Forma'),
    (CURRENT_DATE, 'software', 'Startup: Tech / IT setup', 5000.00, NULL, false, 'One-time startup cost from MO Pro Forma'),
    (CURRENT_DATE, 'software', 'Startup: Software licenses (Quickbooks, Indeed, Apploi)', 3000.00, NULL, false, 'One-time startup cost from MO Pro Forma'),
    (CURRENT_DATE, 'marketing', 'Startup: Initial Marketing campaign', 30000.00, NULL, false, 'One-time startup cost from MO Pro Forma'),
    (CURRENT_DATE, 'professional_services', 'Startup: Initial Salaries (CEO + Clinical Director)', 100000.00, NULL, false, 'One-time startup cost from MO Pro Forma')
ON CONFLICT DO NOTHING;

-- ============================================
-- Seed default pro forma scenario
-- ============================================

INSERT INTO pro_forma_scenarios (name, description, assumptions, outputs, is_default)
SELECT
    'MO Pro Forma (Investor Model)',
    'Default assumptions from the Missouri pro forma shared with investors. Medicaid-only, ramp from month 3, stabilize at 250 clients.',
    jsonb_build_object(
        -- Rates
        'medicaid_rate_15min', 65.48,
        'in_network_rate_15min', 0,
        'oon_rate_15min', 150,
        'deductible_per_resident', 5000,
        -- RBT
        'medicaid_split', 100,
        'in_network_split', 0,
        'oon_split', 0,
        'avg_hours_per_resident_week', 14,
        -- BCBA
        'assessment_hours_6month', 8,
        'assessment_rate_per_hour', 101.04,
        'supervision_hours_per_week', 2,
        'supervision_rate_per_hour', 101.04,
        -- Labor
        'rbt_hourly_rate', 27,
        'bcba_hourly_rate', 95,
        -- Growth
        'day_one_residents', 0,
        'first_resident_month', 3,
        'beginning_net_growth_month', 4.5,
        'ramp_until_month', 4,
        'stabilized_net_growth_month', 4.5,
        'client_max', 250,
        -- Key fixed salaries (stabilized annual)
        'ceo_salary_annual', 250000,
        'clinical_director_annual', 150000,
        'director_intake_annual', 100000,
        'director_compliance_annual', 90000,
        'director_care_mgmt_annual', 90000,
        'director_hr_annual', 150000,
        'recruiter_annual', 75000,
        'state_director_annual', 150000,
        'overseas_assistant_monthly', 2500,
        -- Non-labor monthly (stabilized)
        'central_reach_per_employee', 90,
        'brellium_per_30_clients', 1800,
        'leadtrap_monthly', 800,
        'marketing_monthly', 10000,
        'advertising_monthly', 10000,
        'liability_insurance_monthly', 166.67,
        'indeed_monthly', 2500,
        'apploi_monthly', 833.33,
        'it_phone_monthly', 1250,
        'legal_monthly', 833.33,
        'accounting_monthly', 500,
        'payroll_software_monthly', 833.33,
        -- Revenue-variable
        'medical_billing_pct_revenue', 6,
        'bad_debt_pct_revenue', 1,
        -- Other
        'cash_lag_days', 45,
        'start_up_lag_months', 3,
        -- Startup
        'startup_legal', 10000,
        'startup_tech_it', 5000,
        'startup_software', 3000,
        'startup_marketing', 30000,
        'startup_salaries', 100000,
        -- Exit
        'exit_multiple', 4,
        'exit_year', 8,
        'pref_rate', 10,
        'revenue_growth_rate', 2,
        'expense_growth_rate', 2
    ),
    jsonb_build_object(
        'note', 'Outputs computed live on the Pro Forma page'
    ),
    true
WHERE NOT EXISTS (
    SELECT 1 FROM pro_forma_scenarios WHERE name = 'MO Pro Forma (Investor Model)'
);
