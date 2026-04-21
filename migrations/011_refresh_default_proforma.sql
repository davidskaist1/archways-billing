-- ============================================
-- Migration 011: Refresh default pro forma with new array structure
-- Run this if you've already run 010 — it updates the existing default
-- scenario to use the new admin_salaries/non_labor_costs/startup_costs arrays.
-- Safe to run multiple times.
-- ============================================

UPDATE pro_forma_scenarios
SET assumptions =
    -- Keep existing scalar values, replace with new array structure
    jsonb_build_object(
        'medicaid_rate_15min', 16.37,
        'in_network_rate_15min', 16.37,
        'oon_rate_15min', 37.50,
        'deductible_per_resident', 5000,
        'medicaid_split', 100,
        'in_network_split', 0,
        'oon_split', 0,
        'avg_hours_per_resident_week', 14,
        'assessment_hours_6month', 8,
        'assessment_rate_per_hour', 101.04,
        'supervision_hours_per_week', 2,
        'supervision_rate_per_hour', 101.04,
        'rbt_hourly_rate', 27,
        'bcba_hourly_rate', 95,
        'day_one_residents', 0,
        'first_resident_month', 3,
        'beginning_net_growth_month', 4.5,
        'ramp_until_month', 4,
        'stabilized_net_growth_month', 4.5,
        'client_max', 250,
        'cash_lag_days', 45,
        'start_up_lag_months', 3,
        'exit_multiple', 4,
        'exit_year', 8,
        'pref_rate', 10,
        'revenue_growth_rate', 2,
        'expense_growth_rate', 2,
        'admin_salaries', jsonb_build_array(
            jsonb_build_object('name','CEO','annual',250000,'start_at',0,'per_clients',0),
            jsonb_build_object('name','Chief Clinical Director (QA)','annual',150000,'start_at',30,'per_clients',0),
            jsonb_build_object('name','Director of Intake','annual',100000,'start_at',10,'per_clients',0),
            jsonb_build_object('name','Director of Compliance','annual',90000,'start_at',30,'per_clients',0),
            jsonb_build_object('name','Director of Care Management','annual',90000,'start_at',10,'per_clients',0),
            jsonb_build_object('name','Director of HR','annual',150000,'start_at',30,'per_clients',0),
            jsonb_build_object('name','Recruiter','annual',75000,'start_at',10,'per_clients',0),
            jsonb_build_object('name','State Director','annual',150000,'start_at',50,'per_clients',0),
            jsonb_build_object('name','Overseas Assistant','annual',30000,'start_at',0,'per_clients',0),
            jsonb_build_object('name','Assistant QAs','annual',90000,'start_at',50,'per_clients',200),
            jsonb_build_object('name','Assistant Director of Compliance','annual',65000,'start_at',100,'per_clients',100),
            jsonb_build_object('name','Assistant Care Management','annual',65000,'start_at',40,'per_clients',40),
            jsonb_build_object('name','Assistant Clinical Director','annual',60000,'start_at',50,'per_clients',50),
            jsonb_build_object('name','Payroll Director','annual',90000,'start_at',50,'per_clients',200),
            jsonb_build_object('name','HR Rep','annual',65000,'start_at',50,'per_clients',200)
        ),
        'non_labor_costs', jsonb_build_array(
            jsonb_build_object('name','Central Reach','amount',90,'scale_type','per_employee','scale_divisor',1),
            jsonb_build_object('name','Brellium (clinical review)','amount',1800,'scale_type','per_clients','scale_divisor',30),
            jsonb_build_object('name','Leadtrap (AI Chatbot)','amount',800,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','Marketing Company','amount',10000,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','Digital Advertising','amount',10000,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','Liability Insurance','amount',166.67,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','Indeed','amount',2500,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','Apploi','amount',833.33,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','IT / Phone','amount',1250,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','Legal','amount',833.33,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','Accounting','amount',500,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','Payroll Software','amount',833.33,'scale_type','fixed','scale_divisor',0),
            jsonb_build_object('name','Medical Billing','amount',6,'scale_type','pct_revenue','scale_divisor',0),
            jsonb_build_object('name','Bad Debt','amount',1,'scale_type','pct_revenue','scale_divisor',0)
        ),
        'startup_costs', jsonb_build_array(
            jsonb_build_object('name','Legal (entity formation)','amount',10000),
            jsonb_build_object('name','Tech / IT Setup','amount',5000),
            jsonb_build_object('name','Initial Software Licenses','amount',3000),
            jsonb_build_object('name','Initial Marketing','amount',30000),
            jsonb_build_object('name','Initial Salaries (pre-revenue)','amount',100000)
        )
    )
WHERE is_default = true;
