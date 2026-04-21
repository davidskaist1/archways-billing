import { requireAuth, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, confirmDialog } from './ui.js';
import { exportToExcel, fmtMoney, fmtPercent, fmtInt } from './investor-helpers.js';

const DEFAULTS = {
    // Rates — per 15-min unit (1 hr = 4 units)
    medicaid_rate_15min: 16.37,
    in_network_rate_15min: 0,
    oon_rate_15min: 37.50,
    deductible_per_resident: 5000,
    // RBT
    day_one_residents: 0,
    medicaid_split: 100,
    in_network_split: 0,
    oon_split: 0,
    avg_hours_per_resident_week: 14,
    // BCBA (rates are per HOUR for assessment/supervision per MO Medicaid billing)
    assessment_hours_6month: 8,
    assessment_rate_per_hour: 101.04,  // 97151: per hour
    supervision_hours_per_week: 2,
    supervision_rate_per_hour: 101.04,  // 97155: per hour
    // Labor
    rbt_hourly_rate: 27,
    bcba_hourly_rate: 95,
    // Growth
    first_resident_month: 3,
    beginning_net_growth_month: 4.5,
    ramp_until_month: 4,
    stabilized_net_growth_month: 4.5,
    client_max: 250,
    revenue_growth_rate: 2,
    expense_growth_rate: 2,
    // Admin salaries (annual)
    ceo_salary_annual: 250000,
    clinical_director_annual: 150000,
    director_intake_annual: 100000,
    director_compliance_annual: 90000,
    director_care_mgmt_annual: 90000,
    director_hr_annual: 150000,
    recruiter_annual: 75000,
    state_director_annual: 150000,
    overseas_assistant_monthly: 2500,
    // Non-labor monthly
    central_reach_per_employee: 90,
    brellium_per_30_clients: 1800,
    leadtrap_monthly: 800,
    marketing_monthly: 10000,
    advertising_monthly: 10000,
    liability_insurance_monthly: 166.67,
    indeed_monthly: 2500,
    apploi_monthly: 833.33,
    it_phone_monthly: 1250,
    legal_monthly: 833.33,
    accounting_monthly: 500,
    payroll_software_monthly: 833.33,
    medical_billing_pct_revenue: 6,
    bad_debt_pct_revenue: 1,
    // Other
    cash_lag_days: 45,
    start_up_lag_months: 3,
    // Startup
    startup_legal: 10000,
    startup_tech_it: 5000,
    startup_software: 3000,
    startup_marketing: 30000,
    startup_salaries: 100000,
    // Exit
    exit_multiple: 4,
    exit_year: 8,
    pref_rate: 10
};

let projectionChart, costBreakdownChart;

async function init() {
    const auth = await requireAuth(['admin', 'investor']);
    if (!auth) return;
    renderNav();

    // Set up collapsible sections
    document.querySelectorAll('.pf-section-header').forEach(h => {
        h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
    });

    // Wire up all inputs
    document.querySelectorAll('.pf-field').forEach(el => {
        el.addEventListener('input', () => recalculate());
    });

    document.getElementById('save-btn').addEventListener('click', saveScenario);
    document.getElementById('load-default-btn').addEventListener('click', loadDefaultScenario);
    document.getElementById('export-btn').addEventListener('click', exportData);

    // Load the default (MO Pro Forma) scenario if present
    await loadDefaultScenario(true);
    recalculate();
    await loadScenarios();
}

function setInputs(values) {
    for (const [key, val] of Object.entries(values)) {
        const el = document.querySelector(`.pf-field[data-key="${key}"]`);
        if (el) el.value = val;
    }
}

function getInputs() {
    const out = {};
    document.querySelectorAll('.pf-field').forEach(el => {
        out[el.dataset.key] = parseFloat(el.value) || 0;
    });
    return out;
}

async function loadDefaultScenario(silent = false) {
    // Try to load the seeded default from DB, else use DEFAULTS
    const { data } = await supabase
        .from('pro_forma_scenarios')
        .select('assumptions')
        .eq('is_default', true)
        .limit(1)
        .maybeSingle();

    if (data?.assumptions) {
        setInputs({ ...DEFAULTS, ...data.assumptions });
    } else {
        setInputs(DEFAULTS);
    }

    document.getElementById('pf-subtitle').textContent =
        'Baseline: MO Pro Forma (Missouri, Medicaid-only, 250 client max)';

    if (!silent) {
        showToast('MO Pro Forma loaded.', 'success');
        recalculate();
    }
}

// ============================================
// THE MODEL — runs the ramp projection
// ============================================

function runModel(inp) {
    const months = 120; // 10 years
    const weeks_per_month = 4.333;

    // Client ramp by month
    const clientsByMonth = [];
    let clients = inp.day_one_residents;
    for (let m = 1; m <= months; m++) {
        if (m >= inp.first_resident_month) {
            const growth = m <= inp.ramp_until_month
                ? inp.beginning_net_growth_month
                : inp.stabilized_net_growth_month;
            clients = Math.min(clients + growth, inp.client_max);
        }
        clientsByMonth.push(clients);
    }

    // Calculate annual (stabilized) figures using the final month
    const stabClients = inp.client_max;

    // Revenue per client (weighted by split)
    const hoursPerClientMonth = inp.avg_hours_per_resident_week * weeks_per_month;
    const unitsPerClientMonth = hoursPerClientMonth * 4; // 4 units/hour

    const revPerUnit =
        (inp.medicaid_split / 100) * inp.medicaid_rate_15min +
        (inp.in_network_split / 100) * inp.in_network_rate_15min +
        (inp.oon_split / 100) * inp.oon_rate_15min;

    const rbtRevenuePerClientPerMonth = unitsPerClientMonth * revPerUnit;

    // BCBA revenue: assessment + supervision
    const assessmentsPerYear = 2; // twice a year (6-month)
    const assessmentHoursPerYear = inp.assessment_hours_6month * assessmentsPerYear;
    const supervisionHoursPerMonth = inp.supervision_hours_per_week * weeks_per_month;
    const bcbaRevenuePerClientPerMonth =
        (assessmentHoursPerYear * inp.assessment_rate_per_hour / 12) +
        (supervisionHoursPerMonth * inp.supervision_rate_per_hour);

    const revenuePerClientPerMonth = rbtRevenuePerClientPerMonth + bcbaRevenuePerClientPerMonth;

    // Stabilized monthly revenue
    const stabMonthlyRevenue = stabClients * revenuePerClientPerMonth;

    // Direct labor costs (stabilized)
    const rbtMonthlyLabor = stabClients * hoursPerClientMonth * inp.rbt_hourly_rate;
    const bcbaMonthlyHoursTotal = stabClients * (assessmentHoursPerYear / 12 + supervisionHoursPerMonth);
    const bcbaMonthlyLabor = bcbaMonthlyHoursTotal * inp.bcba_hourly_rate;
    const stabDirectLabor = rbtMonthlyLabor + bcbaMonthlyLabor;

    // Admin overhead (stabilized — all triggered, assume 250 clients reached)
    // These are simplified from the pro forma — we use the stabilized annual / 12
    const adminMonthly =
        (inp.ceo_salary_annual / 12) +
        (inp.clinical_director_annual / 12) +
        (inp.director_intake_annual / 12) +
        (inp.director_compliance_annual / 12) +
        (inp.director_care_mgmt_annual / 12) +
        (inp.director_hr_annual / 12) +
        (inp.recruiter_annual / 12) +
        (inp.state_director_annual / 12) +
        inp.overseas_assistant_monthly +
        // Scaled roles at 250 clients: assistants triggered per client bucket
        ((inp.clinical_director_annual * 0.6 / 12) * Math.floor(stabClients / 200)) + // assistant QAs
        ((inp.director_compliance_annual * 1.4 / 12) * Math.floor(stabClients / 100)) + // asst compliance
        ((90000 / 12) * Math.floor(stabClients / 40)) + // asst care management (~$90k/year each)
        ((60000 / 12) * Math.floor(stabClients / 50)) + // asst clinical director
        ((90000 / 12) * Math.max(1, Math.floor(stabClients / 200))) + // payroll director
        ((65000 / 12) * Math.max(1, Math.floor(stabClients / 200))); // HR rep

    // Non-labor costs (stabilized)
    // Estimate headcount for central reach: RBTs (hours_week/30) + BCBAs + admins
    const rbtHeadcount = Math.ceil(stabClients * inp.avg_hours_per_resident_week / 30);
    const bcbaHeadcount = Math.ceil(stabClients * (inp.supervision_hours_per_week + inp.assessment_hours_6month / 26) / 30);
    const totalEmployees = rbtHeadcount + bcbaHeadcount + 25; // ~25 admin

    const nonLaborMonthly =
        totalEmployees * inp.central_reach_per_employee +
        inp.brellium_per_30_clients * (stabClients / 30) +
        inp.leadtrap_monthly +
        inp.marketing_monthly +
        inp.advertising_monthly +
        inp.liability_insurance_monthly +
        inp.indeed_monthly +
        inp.apploi_monthly +
        inp.it_phone_monthly +
        inp.legal_monthly +
        inp.accounting_monthly +
        inp.payroll_software_monthly +
        stabMonthlyRevenue * (inp.medical_billing_pct_revenue / 100) +
        stabMonthlyRevenue * (inp.bad_debt_pct_revenue / 100);

    const stabTotalCosts = stabDirectLabor + adminMonthly + nonLaborMonthly;
    const stabEbitda = stabMonthlyRevenue - stabTotalCosts;
    const stabMargin = stabMonthlyRevenue > 0 ? (stabEbitda / stabMonthlyRevenue * 100) : 0;

    // Total startup investment
    const totalStartup =
        inp.startup_legal + inp.startup_tech_it + inp.startup_software +
        inp.startup_marketing + inp.startup_salaries;

    // Break-even clients
    // Fixed portion of costs = admin overhead + non-labor (excluding revenue-variable)
    const fixedCostsNonVariable = adminMonthly +
        (totalEmployees * inp.central_reach_per_employee) +
        inp.brellium_per_30_clients * (stabClients / 30) +
        inp.leadtrap_monthly + inp.marketing_monthly + inp.advertising_monthly +
        inp.liability_insurance_monthly + inp.indeed_monthly + inp.apploi_monthly +
        inp.it_phone_monthly + inp.legal_monthly + inp.accounting_monthly +
        inp.payroll_software_monthly;

    const grossPerClient = revenuePerClientPerMonth;
    const variableCostPerClient =
        hoursPerClientMonth * inp.rbt_hourly_rate +
        ((assessmentHoursPerYear / 12) + supervisionHoursPerMonth) * inp.bcba_hourly_rate +
        revenuePerClientPerMonth * ((inp.medical_billing_pct_revenue + inp.bad_debt_pct_revenue) / 100);

    const contributionPerClient = grossPerClient - variableCostPerClient;
    const breakeven = contributionPerClient > 0 ? Math.ceil(fixedCostsNonVariable / contributionPerClient) : null;

    // Annual projection (year 1-10), ramping
    const annualYears = [];
    for (let y = 1; y <= 10; y++) {
        const startMonth = (y - 1) * 12 + 1;
        const endMonth = y * 12;
        let yearRevenue = 0;
        let yearCosts = 0;
        let avgClients = 0;
        let monthsCounted = 0;

        for (let m = startMonth; m <= endMonth && m <= months; m++) {
            const c = clientsByMonth[m - 1];
            avgClients += c;
            monthsCounted++;

            // Scale stabilized metrics by current clients
            const clientRatio = c / stabClients || 0;
            const monthRev = c * revenuePerClientPerMonth * Math.pow(1 + inp.revenue_growth_rate / 100, y - 1);
            const monthDirect = c * (hoursPerClientMonth * inp.rbt_hourly_rate +
                ((assessmentHoursPerYear / 12) + supervisionHoursPerMonth) * inp.bcba_hourly_rate);
            // Admin scales roughly with client count for some roles
            const monthAdmin = adminMonthly * Math.min(1, clientRatio * 1.3);
            const monthNonLabor = nonLaborMonthly * Math.min(1, 0.3 + clientRatio * 0.7);

            yearRevenue += monthRev;
            yearCosts += (monthDirect + monthAdmin + monthNonLabor) * Math.pow(1 + inp.expense_growth_rate / 100, y - 1);
        }

        avgClients = monthsCounted > 0 ? avgClients / monthsCounted : 0;
        annualYears.push({
            year: y,
            avgClients: Math.round(avgClients),
            revenue: yearRevenue,
            costs: yearCosts,
            ebitda: yearRevenue - yearCosts,
            margin: yearRevenue > 0 ? (yearRevenue - yearCosts) / yearRevenue * 100 : 0
        });
    }

    // Exit value
    const exitYear = Math.min(inp.exit_year, 10);
    const exitEbitda = annualYears[exitYear - 1]?.ebitda || 0;
    const exitValue = exitEbitda * inp.exit_multiple;

    return {
        stabMonthlyRevenue,
        stabDirectLabor,
        adminMonthly,
        nonLaborMonthly,
        stabTotalCosts,
        stabEbitda,
        stabMargin,
        totalStartup,
        breakeven,
        annualYears,
        exitYear,
        exitValue,
        rbtMonthlyLabor,
        bcbaMonthlyLabor,
        clientsByMonth,
        revenuePerClientPerMonth,
        rbtHeadcount,
        bcbaHeadcount,
        totalEmployees
    };
}

function updateHourlyDisplays(inp) {
    const fmtHourly = (val) => '= $' + (parseFloat(val || 0) * 4).toFixed(2) + '/hour';
    const mElem = document.getElementById('medicaid-hourly-display');
    const inElem = document.getElementById('in-network-hourly-display');
    const oonElem = document.getElementById('oon-hourly-display');
    if (mElem) mElem.textContent = fmtHourly(inp.medicaid_rate_15min);
    if (inElem) inElem.textContent = fmtHourly(inp.in_network_rate_15min);
    if (oonElem) oonElem.textContent = fmtHourly(inp.oon_rate_15min);
}

function recalculate() {
    const inp = getInputs();
    const r = runModel(inp);
    updateHourlyDisplays(inp);

    // KPIs
    document.getElementById('out-revenue').textContent = fmtMoney(r.stabMonthlyRevenue);
    document.getElementById('out-revenue-sub').textContent =
        `${fmtInt(inp.client_max)} clients × ${fmtMoney(r.revenuePerClientPerMonth)}/mo`;

    document.getElementById('out-costs').textContent = fmtMoney(r.stabTotalCosts);
    document.getElementById('out-costs-sub').textContent =
        `Labor ${fmtMoney(r.stabDirectLabor + r.adminMonthly)} · Other ${fmtMoney(r.nonLaborMonthly)}`;

    const profitCard = document.getElementById('profit-card');
    profitCard.className = 'kpi-card ' + (r.stabEbitda >= 0 ? 'kpi-success' : 'kpi-danger');
    document.getElementById('out-profit').textContent = fmtMoney(r.stabEbitda);
    document.getElementById('out-margin').textContent = `${fmtPercent(r.stabMargin)} margin`;

    document.getElementById('out-breakeven').textContent = r.breakeven ? r.breakeven : 'N/A';

    document.getElementById('out-startup').textContent = fmtMoney(r.totalStartup);
    document.getElementById('out-annual-revenue').textContent = fmtMoney(r.stabMonthlyRevenue * 12);
    document.getElementById('out-annual-ebitda').textContent = fmtMoney(r.stabEbitda * 12);
    document.getElementById('out-exit-value').textContent = fmtMoney(r.exitValue);
    document.getElementById('out-exit-sub').textContent = `Year ${r.exitYear} @ ${inp.exit_multiple}x EBITDA`;

    renderProjectionChart(r);
    renderAnnualTable(r);
    renderCostBreakdownChart(r);
}

function renderProjectionChart(r) {
    const ctx = document.getElementById('projection-chart');
    if (projectionChart) projectionChart.destroy();

    projectionChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: r.annualYears.map(y => `Y${y.year}`),
            datasets: [
                { label: 'Revenue', data: r.annualYears.map(y => y.revenue), backgroundColor: 'rgba(16,185,129,0.7)', order: 2 },
                { label: 'Costs', data: r.annualYears.map(y => y.costs), backgroundColor: 'rgba(239,68,68,0.5)', order: 2 },
                {
                    label: 'EBITDA',
                    data: r.annualYears.map(y => y.ebitda),
                    type: 'line',
                    borderColor: '#1a56db',
                    borderWidth: 3,
                    tension: 0.3,
                    backgroundColor: 'rgba(26,86,219,0.1)',
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: c => c.dataset.label + ': ' + fmtMoney(c.raw) } }
            },
            scales: { y: { ticks: { callback: v => '$' + (v / 1000000).toFixed(1) + 'M' } } }
        }
    });
}

function renderAnnualTable(r) {
    const rows = r.annualYears.map(y => ({
        id: y.year,
        year: 'Year ' + y.year,
        clients: y.avgClients,
        revenue: y.revenue,
        costs: y.costs,
        ebitda: y.ebitda,
        margin: y.margin
    }));

    const table = new DataTable('annual-table', {
        columns: [
            { key: 'year', label: 'Year' },
            { key: 'clients', label: 'Avg Clients', type: 'number', align: 'text-center' },
            { key: 'revenue', label: 'Revenue', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'costs', label: 'Costs', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'ebitda', label: 'EBITDA', type: 'number', align: 'text-right', render: v => {
                const cls = v >= 0 ? 'text-success' : 'text-danger';
                return `<strong class="${cls}">${fmtMoney(v)}</strong>`;
            }},
            { key: 'margin', label: 'Margin', align: 'text-right', render: v => {
                const cls = v >= 20 ? 'text-success' : v >= 0 ? 'text-warning' : 'text-danger';
                return `<span class="${cls}">${fmtPercent(v)}</span>`;
            }}
        ],
        defaultSort: 'id',
        pageSize: 15
    });
    table.setData(rows);
}

function renderCostBreakdownChart(r) {
    const ctx = document.getElementById('cost-breakdown-chart');
    if (costBreakdownChart) costBreakdownChart.destroy();

    costBreakdownChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Monthly Stabilized Costs'],
            datasets: [
                { label: 'RBT Labor', data: [r.rbtMonthlyLabor], backgroundColor: '#3b82f6' },
                { label: 'BCBA Labor', data: [r.bcbaMonthlyLabor], backgroundColor: '#8b5cf6' },
                { label: 'Admin / Overhead', data: [r.adminMonthly], backgroundColor: '#ef4444' },
                { label: 'Non-Labor', data: [r.nonLaborMonthly], backgroundColor: '#f59e0b' }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: c => c.dataset.label + ': ' + fmtMoney(c.raw) } }
            },
            scales: {
                x: { stacked: true, ticks: { callback: v => '$' + v.toLocaleString() } },
                y: { stacked: true }
            }
        }
    });
}

async function saveScenario() {
    const name = prompt('Scenario name:');
    if (!name) return;

    const user = getCurrentStaff();
    const inp = getInputs();
    const outputs = runModel(inp);

    const { error } = await supabase.from('pro_forma_scenarios').insert({
        name,
        assumptions: inp,
        outputs: {
            stabMonthlyRevenue: outputs.stabMonthlyRevenue,
            stabTotalCosts: outputs.stabTotalCosts,
            stabEbitda: outputs.stabEbitda,
            stabMargin: outputs.stabMargin,
            breakeven: outputs.breakeven,
            exitValue: outputs.exitValue
        },
        created_by: user.id
    });

    if (error) { showToast('Failed: ' + error.message, 'error'); return; }
    showToast('Scenario saved.', 'success');
    await loadScenarios();
}

async function loadScenarios() {
    const { data } = await supabase
        .from('pro_forma_scenarios')
        .select('*, app_users(first_name, last_name)')
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: false });

    const list = document.getElementById('scenarios-list');
    if (!data || data.length === 0) {
        list.innerHTML = '<p class="text-sm text-muted">No saved scenarios yet.</p>';
        return;
    }

    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;">';
    for (const s of data) {
        const ebitda = parseFloat(s.outputs?.stabEbitda) || 0;
        const ebitdaCls = ebitda >= 0 ? 'text-success' : 'text-danger';
        const author = s.app_users ? `${s.app_users.first_name} ${s.app_users.last_name}` : 'Seed';
        html += `<div class="card" style="padding:12px;${s.is_default ? 'border-left:4px solid var(--color-primary);' : ''}">
            <div class="flex-between mb-1">
                <strong>${s.name}${s.is_default ? ' <span class="badge badge-info text-xs">DEFAULT</span>' : ''}</strong>
                <span class="${ebitdaCls} font-bold">${fmtMoney(ebitda)}/mo</span>
            </div>
            <div class="text-xs text-muted mb-1">
                ${s.assumptions.client_max || '?'} clients · ${s.assumptions.avg_hours_per_resident_week || '?'} hrs/wk
                · ${fmtPercent(s.outputs?.stabMargin || 0)} margin
            </div>
            <div class="text-xs text-muted">${author} · ${new Date(s.created_at).toLocaleDateString()}</div>
            <div class="flex gap-1 mt-1">
                <button class="btn btn-sm btn-secondary load-scn" data-id="${s.id}">Load</button>
                ${!s.is_default ? `<button class="btn btn-sm btn-ghost text-danger del-scn" data-id="${s.id}">Delete</button>` : ''}
            </div>
        </div>`;
    }
    html += '</div>';
    list.innerHTML = html;

    list.querySelectorAll('.load-scn').forEach(btn => {
        btn.addEventListener('click', () => {
            const s = data.find(x => x.id === btn.dataset.id);
            if (!s) return;
            setInputs({ ...DEFAULTS, ...s.assumptions });
            recalculate();
            showToast(`Loaded "${s.name}".`, 'success');
        });
    });
    list.querySelectorAll('.del-scn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const ok = await confirmDialog('Delete this scenario?');
            if (!ok) return;
            await supabase.from('pro_forma_scenarios').delete().eq('id', btn.dataset.id);
            showToast('Deleted.', 'success');
            loadScenarios();
        });
    });
}

function exportData() {
    const inp = getInputs();
    const r = runModel(inp);

    exportToExcel(`MO_ProForma_${new Date().toISOString().split('T')[0]}.xlsx`, [
        {
            name: 'Assumptions',
            data: Object.entries(inp).map(([k, v]) => ({ Assumption: k.replace(/_/g, ' '), Value: v }))
        },
        {
            name: 'Stabilized P&L',
            data: [{
                Monthly_Revenue: r.stabMonthlyRevenue,
                Monthly_Direct_Labor: r.stabDirectLabor,
                Monthly_Admin_Overhead: r.adminMonthly,
                Monthly_Non_Labor: r.nonLaborMonthly,
                Monthly_Total_Costs: r.stabTotalCosts,
                Monthly_EBITDA: r.stabEbitda,
                Margin_Pct: r.stabMargin.toFixed(2),
                Annual_Revenue: r.stabMonthlyRevenue * 12,
                Annual_EBITDA: r.stabEbitda * 12,
                Total_Startup: r.totalStartup,
                Exit_Year: r.exitYear,
                Exit_Value: r.exitValue,
                Break_Even_Clients: r.breakeven
            }]
        },
        {
            name: '10-Year Projection',
            data: r.annualYears.map(y => ({
                Year: y.year,
                Avg_Clients: y.avgClients,
                Revenue: y.revenue,
                Costs: y.costs,
                EBITDA: y.ebitda,
                Margin_Pct: y.margin.toFixed(2)
            }))
        }
    ]);
}

init();
