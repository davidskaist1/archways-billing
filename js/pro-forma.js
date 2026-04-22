import { requireAuth, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, confirmDialog } from './ui.js';
import { exportToExcel, fmtMoney, fmtPercent, fmtInt } from './investor-helpers.js';

// ============================================
// DEFAULTS — MO Pro Forma baseline
// ============================================

const DEFAULT_ADMIN_SALARIES = [
    // {name, annual, start_at, per_clients (0 = fixed, otherwise add one per N clients above start)}
    { name: 'CEO', annual: 250000, start_at: 0, per_clients: 0 },
    { name: 'Chief Clinical Director (QA)', annual: 150000, start_at: 30, per_clients: 0 },
    { name: 'Director of Intake', annual: 100000, start_at: 10, per_clients: 0 },
    { name: 'Director of Compliance', annual: 90000, start_at: 30, per_clients: 0 },
    { name: 'Director of Care Management', annual: 90000, start_at: 10, per_clients: 0 },
    { name: 'Director of HR', annual: 150000, start_at: 30, per_clients: 0 },
    { name: 'Recruiter', annual: 75000, start_at: 10, per_clients: 0 },
    { name: 'State Director', annual: 150000, start_at: 50, per_clients: 0 },
    { name: 'Overseas Assistant', annual: 30000, start_at: 0, per_clients: 0 },
    { name: 'Assistant QAs', annual: 90000, start_at: 50, per_clients: 200 },
    { name: 'Assistant Director of Compliance', annual: 65000, start_at: 100, per_clients: 100 },
    { name: 'Assistant Care Management', annual: 65000, start_at: 40, per_clients: 40 },
    { name: 'Assistant Clinical Director', annual: 60000, start_at: 50, per_clients: 50 },
    { name: 'Payroll Director', annual: 90000, start_at: 50, per_clients: 200 },
    { name: 'HR Rep', annual: 65000, start_at: 50, per_clients: 200 }
];

const DEFAULT_NON_LABOR = [
    // {name, amount, scale_type: 'fixed'|'per_employee'|'per_clients'|'pct_revenue', scale_divisor}
    { name: 'Central Reach', amount: 90, scale_type: 'per_employee', scale_divisor: 1 },
    { name: 'Brellium (clinical review)', amount: 1800, scale_type: 'per_clients', scale_divisor: 30 },
    { name: 'Leadtrap (AI Chatbot)', amount: 800, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'Marketing Company', amount: 10000, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'Digital Advertising', amount: 10000, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'Liability Insurance', amount: 166.67, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'Indeed', amount: 2500, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'Apploi', amount: 833.33, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'IT / Phone', amount: 1250, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'Legal', amount: 833.33, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'Accounting', amount: 500, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'Payroll Software', amount: 833.33, scale_type: 'fixed', scale_divisor: 0 },
    { name: 'Medical Billing', amount: 6, scale_type: 'pct_revenue', scale_divisor: 0 },
    { name: 'Bad Debt', amount: 1, scale_type: 'pct_revenue', scale_divisor: 0 }
];

const DEFAULT_STARTUP = [
    { name: 'Legal (entity formation)', amount: 10000 },
    { name: 'Tech / IT Setup', amount: 5000 },
    { name: 'Initial Software Licenses', amount: 3000 },
    { name: 'Initial Marketing', amount: 30000 },
    { name: 'Initial Salaries (pre-revenue)', amount: 100000 }
];

const DEFAULTS = {
    medicaid_rate_15min: 16.37,
    in_network_rate_15min: 16.37,
    oon_rate_15min: 37.50,
    deductible_per_resident: 5000,
    day_one_residents: 0,
    medicaid_split: 100,
    in_network_split: 0,
    oon_split: 0,
    avg_hours_per_resident_week: 14,
    assessment_hours_6month: 8,
    assessment_rate_per_hour: 101.04,
    supervision_hours_per_week: 2,
    supervision_rate_per_hour: 101.04,
    rbt_hourly_rate: 27,
    bcba_hourly_rate: 95,
    first_resident_month: 3,
    beginning_net_growth_month: 4.5,
    ramp_until_month: 4,
    stabilized_net_growth_month: 4.5,
    client_max: 250,
    revenue_growth_rate: 2,
    expense_growth_rate: 2,
    cash_lag_days: 45,
    start_up_lag_months: 3,
    exit_multiple: 4,
    exit_year: 8,
    pref_rate: 10,
    admin_salaries: DEFAULT_ADMIN_SALARIES,
    non_labor_costs: DEFAULT_NON_LABOR,
    startup_costs: DEFAULT_STARTUP
};

let projectionChart, costBreakdownChart;
let adminSalaries = [];
let nonLaborCosts = [];
let startupCosts = [];
let lastComputed = null; // last runModel result for KPI popups

async function init() {
    const auth = await requireAuth(['admin', 'investor']);
    if (!auth) return;
    renderNav();

    document.querySelectorAll('.pf-section-header').forEach(h => {
        h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
    });

    document.querySelectorAll('.pf-field').forEach(el => {
        el.addEventListener('input', () => recalculate());
    });

    document.getElementById('save-btn').addEventListener('click', saveScenario);
    document.getElementById('load-default-btn').addEventListener('click', () => loadDefaultScenario(false));
    document.getElementById('export-btn').addEventListener('click', exportData);

    document.getElementById('add-admin-btn').addEventListener('click', () => {
        adminSalaries.push({ name: 'New Role', annual: 0, start_at: 0, per_clients: 0 });
        renderAdminSalaries();
        recalculate();
    });
    document.getElementById('add-nonlabor-btn').addEventListener('click', () => {
        nonLaborCosts.push({ name: 'New Line Item', amount: 0, scale_type: 'fixed', scale_divisor: 0 });
        renderNonLabor();
        recalculate();
    });
    document.getElementById('add-startup-btn').addEventListener('click', () => {
        startupCosts.push({ name: 'New Startup Item', amount: 0 });
        renderStartup();
        recalculate();
    });

    // Make KPI cards clickable
    document.querySelectorAll('.kpi-card[data-kpi]').forEach(card => {
        card.addEventListener('click', () => showKPIBreakdown(card.dataset.kpi));
    });

    await loadDefaultScenario(true);
    recalculate();
    await loadScenarios();
}

function setInputs(values) {
    for (const [key, val] of Object.entries(values)) {
        if (key === 'admin_salaries' || key === 'non_labor_costs' || key === 'startup_costs') continue;
        const el = document.querySelector(`.pf-field[data-key="${key}"]`);
        if (el) el.value = val;
    }
    adminSalaries = Array.isArray(values.admin_salaries) ? [...values.admin_salaries] : [...DEFAULT_ADMIN_SALARIES];
    nonLaborCosts = Array.isArray(values.non_labor_costs) ? [...values.non_labor_costs] : [...DEFAULT_NON_LABOR];
    startupCosts = Array.isArray(values.startup_costs) ? [...values.startup_costs] : [...DEFAULT_STARTUP];
    renderAdminSalaries();
    renderNonLabor();
    renderStartup();
}

function getInputs() {
    const out = {};
    document.querySelectorAll('.pf-field').forEach(el => {
        out[el.dataset.key] = parseFloat(el.value) || 0;
    });
    out.admin_salaries = adminSalaries;
    out.non_labor_costs = nonLaborCosts;
    out.startup_costs = startupCosts;
    return out;
}

// ============================================
// DYNAMIC LINE ITEMS — render
// ============================================

function renderAdminSalaries() {
    const list = document.getElementById('admin-salaries-list');
    list.innerHTML = '';
    adminSalaries.forEach((s, idx) => {
        const row = document.createElement('div');
        row.className = 'dyn-row';
        row.innerHTML = `
            <input type="text" value="${escapeAttr(s.name)}" data-idx="${idx}" data-field="name" placeholder="Role name">
            <input type="number" step="500" value="${s.annual || 0}" data-idx="${idx}" data-field="annual" placeholder="Annual $">
            <input type="text" value="${s.start_at || 0}${s.per_clients ? ' / per ' + s.per_clients : ''}" data-idx="${idx}" data-field="trigger" placeholder="e.g. 30 or 50 / per 40" title="Format: X = starts at X clients. X / per Y = starts at X and adds one per Y more clients">
            <button class="dyn-del-btn" data-idx="${idx}" title="Delete">×</button>
        `;
        list.appendChild(row);
    });
    // Bind
    list.querySelectorAll('input').forEach(el => {
        el.addEventListener('input', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            const field = e.target.dataset.field;
            if (field === 'name') {
                adminSalaries[idx].name = e.target.value;
            } else if (field === 'annual') {
                adminSalaries[idx].annual = parseFloat(e.target.value) || 0;
            } else if (field === 'trigger') {
                const parts = String(e.target.value).split('/').map(s => s.trim());
                const first = parts[0].replace(/[^\d.]/g, '');
                const second = parts[1] ? parts[1].replace(/[^\d.]/g, '') : 0;
                adminSalaries[idx].start_at = parseFloat(first) || 0;
                adminSalaries[idx].per_clients = parseFloat(second) || 0;
            }
            recalculate();
        });
    });
    list.querySelectorAll('.dyn-del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            adminSalaries.splice(parseInt(btn.dataset.idx), 1);
            renderAdminSalaries();
            recalculate();
        });
    });
}

function renderNonLabor() {
    const list = document.getElementById('non-labor-list');
    list.innerHTML = '';
    nonLaborCosts.forEach((c, idx) => {
        const row = document.createElement('div');
        row.className = 'dyn-row';
        row.innerHTML = `
            <input type="text" value="${escapeAttr(c.name)}" data-idx="${idx}" data-field="name">
            <input type="number" step="0.01" value="${c.amount || 0}" data-idx="${idx}" data-field="amount">
            <select data-idx="${idx}" data-field="scale_type">
                <option value="fixed" ${c.scale_type === 'fixed' ? 'selected' : ''}>Fixed / month</option>
                <option value="per_employee" ${c.scale_type === 'per_employee' ? 'selected' : ''}>Per employee</option>
                <option value="per_clients" ${c.scale_type === 'per_clients' ? 'selected' : ''}>Per ${c.scale_divisor || '?'} clients</option>
                <option value="pct_revenue" ${c.scale_type === 'pct_revenue' ? 'selected' : ''}>% of revenue</option>
            </select>
            <button class="dyn-del-btn" data-idx="${idx}">×</button>
        `;
        list.appendChild(row);

        // If "per_clients" is selected, allow editing the divisor inline
        if (c.scale_type === 'per_clients') {
            const divisorInput = document.createElement('input');
            divisorInput.type = 'number';
            divisorInput.step = 1;
            divisorInput.value = c.scale_divisor || 30;
            divisorInput.placeholder = 'Per X clients';
            divisorInput.style.gridColumn = '3';
            divisorInput.style.fontSize = '0.75rem';
            divisorInput.dataset.idx = idx;
            divisorInput.dataset.field = 'scale_divisor';
            divisorInput.title = 'Per how many clients';
            const extraRow = document.createElement('div');
            extraRow.className = 'dyn-row';
            extraRow.style.gridTemplateColumns = '2fr 110px 120px 28px';
            extraRow.innerHTML = '<div></div><div></div>';
            extraRow.appendChild(divisorInput);
            extraRow.appendChild(document.createElement('div'));
            list.appendChild(extraRow);
            divisorInput.addEventListener('input', (e) => {
                nonLaborCosts[idx].scale_divisor = parseInt(e.target.value) || 1;
                recalculate();
            });
        }
    });
    list.querySelectorAll('input[data-field="name"], input[data-field="amount"]').forEach(el => {
        el.addEventListener('input', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            const field = e.target.dataset.field;
            if (field === 'name') nonLaborCosts[idx].name = e.target.value;
            else if (field === 'amount') nonLaborCosts[idx].amount = parseFloat(e.target.value) || 0;
            recalculate();
        });
    });
    list.querySelectorAll('select[data-field="scale_type"]').forEach(el => {
        el.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            nonLaborCosts[idx].scale_type = e.target.value;
            if (e.target.value === 'per_clients' && !nonLaborCosts[idx].scale_divisor) {
                nonLaborCosts[idx].scale_divisor = 30;
            }
            renderNonLabor();
            recalculate();
        });
    });
    list.querySelectorAll('.dyn-del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            nonLaborCosts.splice(parseInt(btn.dataset.idx), 1);
            renderNonLabor();
            recalculate();
        });
    });
}

function renderStartup() {
    const list = document.getElementById('startup-list');
    list.innerHTML = '';
    startupCosts.forEach((c, idx) => {
        const row = document.createElement('div');
        row.className = 'dyn-row';
        row.innerHTML = `
            <input type="text" value="${escapeAttr(c.name)}" data-idx="${idx}" data-field="name">
            <input type="number" step="100" value="${c.amount || 0}" data-idx="${idx}" data-field="amount">
            <div></div>
            <button class="dyn-del-btn" data-idx="${idx}">×</button>
        `;
        list.appendChild(row);
    });
    list.querySelectorAll('input').forEach(el => {
        el.addEventListener('input', (e) => {
            const idx = parseInt(e.target.dataset.idx);
            const field = e.target.dataset.field;
            if (field === 'name') startupCosts[idx].name = e.target.value;
            else if (field === 'amount') startupCosts[idx].amount = parseFloat(e.target.value) || 0;
            recalculate();
        });
    });
    list.querySelectorAll('.dyn-del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            startupCosts.splice(parseInt(btn.dataset.idx), 1);
            renderStartup();
            recalculate();
        });
    });
}

async function loadDefaultScenario(silent = false) {
    const { data } = await supabase
        .from('pro_forma_scenarios')
        .select('assumptions')
        .eq('is_default', true)
        .limit(1)
        .maybeSingle();

    const merged = { ...DEFAULTS, ...(data?.assumptions || {}) };
    setInputs(merged);

    document.getElementById('pf-subtitle').textContent =
        'Baseline: MO Pro Forma (Missouri, Medicaid-only, 250 client max)';

    if (!silent) {
        showToast('MO Pro Forma loaded.', 'success');
        recalculate();
    }
}

// ============================================
// THE MODEL — core calculations
// ============================================

function calcAdminMonthlyAtClients(admin, clients) {
    // Returns monthly admin cost at a given client count, given the rules
    let total = 0;
    const breakdown = [];
    for (const role of admin) {
        let count = 0;
        if (clients >= (role.start_at || 0)) {
            count = 1;
            if (role.per_clients > 0 && clients > role.start_at) {
                // Additional instances
                count = 1 + Math.floor((clients - role.start_at) / role.per_clients);
            }
        }
        const monthly = (role.annual || 0) / 12 * count;
        if (monthly > 0) {
            breakdown.push({ name: role.name, count, annual_each: role.annual, monthly_total: monthly });
        }
        total += monthly;
    }
    return { total, breakdown };
}

function calcNonLaborAtClients(nonLabor, clients, totalEmployees, monthlyRevenue) {
    let total = 0;
    const breakdown = [];
    for (const item of nonLabor) {
        let monthly = 0;
        let detail = '';
        if (item.scale_type === 'fixed') {
            monthly = item.amount;
            detail = `$${fmt(item.amount)}/month fixed`;
        } else if (item.scale_type === 'per_employee') {
            monthly = item.amount * totalEmployees;
            detail = `$${fmt(item.amount)} × ${totalEmployees} employees`;
        } else if (item.scale_type === 'per_clients') {
            const div = item.scale_divisor || 1;
            monthly = item.amount * (clients / div);
            detail = `$${fmt(item.amount)} × (${clients}/${div} clients)`;
        } else if (item.scale_type === 'pct_revenue') {
            monthly = monthlyRevenue * (item.amount / 100);
            detail = `${item.amount}% of $${fmt(monthlyRevenue)} revenue`;
        }
        breakdown.push({ name: item.name, monthly, detail });
        total += monthly;
    }
    return { total, breakdown };
}

function modelAtClients(inp, clients) {
    // Computes revenue, costs, EBITDA at a given client count
    const weeks_per_month = 4.333;
    const hoursPerClientMonth = inp.avg_hours_per_resident_week * weeks_per_month;
    const unitsPerClientMonth = hoursPerClientMonth * 4;

    const revPerUnit =
        (inp.medicaid_split / 100) * inp.medicaid_rate_15min +
        (inp.in_network_split / 100) * inp.in_network_rate_15min +
        (inp.oon_split / 100) * inp.oon_rate_15min;

    const rbtRevPerClient = unitsPerClientMonth * revPerUnit;

    const assessmentHoursPerYear = inp.assessment_hours_6month * 2;
    const supervisionHoursPerMonth = inp.supervision_hours_per_week * weeks_per_month;
    const bcbaRevPerClient =
        (assessmentHoursPerYear * inp.assessment_rate_per_hour / 12) +
        (supervisionHoursPerMonth * inp.supervision_rate_per_hour);

    const revPerClient = rbtRevPerClient + bcbaRevPerClient;
    const monthlyRevenue = clients * revPerClient;

    const rbtMonthlyLabor = clients * hoursPerClientMonth * inp.rbt_hourly_rate;
    const bcbaMonthlyLabor = clients * ((assessmentHoursPerYear / 12) + supervisionHoursPerMonth) * inp.bcba_hourly_rate;
    const directLabor = rbtMonthlyLabor + bcbaMonthlyLabor;

    // Admin
    const adminResult = calcAdminMonthlyAtClients(inp.admin_salaries || [], clients);

    // Headcount for non-labor scaling
    const rbtHeadcount = Math.ceil(clients * inp.avg_hours_per_resident_week / 30);
    const bcbaHeadcount = Math.ceil(clients * (inp.supervision_hours_per_week + inp.assessment_hours_6month / 26) / 30);
    // Admin headcount from breakdown
    const adminHeadcount = adminResult.breakdown.reduce((s, r) => s + r.count, 0);
    const totalEmployees = rbtHeadcount + bcbaHeadcount + adminHeadcount;

    // Non-labor
    const nonLaborResult = calcNonLaborAtClients(inp.non_labor_costs || [], clients, totalEmployees, monthlyRevenue);

    const totalCosts = directLabor + adminResult.total + nonLaborResult.total;
    const ebitda = monthlyRevenue - totalCosts;
    const margin = monthlyRevenue > 0 ? (ebitda / monthlyRevenue * 100) : 0;

    return {
        clients,
        revPerClient,
        rbtRevPerClient,
        bcbaRevPerClient,
        monthlyRevenue,
        rbtMonthlyLabor,
        bcbaMonthlyLabor,
        directLabor,
        adminMonthly: adminResult.total,
        adminBreakdown: adminResult.breakdown,
        adminHeadcount,
        rbtHeadcount,
        bcbaHeadcount,
        totalEmployees,
        nonLaborMonthly: nonLaborResult.total,
        nonLaborBreakdown: nonLaborResult.breakdown,
        totalCosts,
        ebitda,
        margin
    };
}

function findBreakEven(inp) {
    // Iterate from 1 to client_max to find the first client count where EBITDA >= 0
    for (let c = 1; c <= inp.client_max; c++) {
        const m = modelAtClients(inp, c);
        if (m.ebitda >= 0) return { clients: c, at: m };
    }
    return { clients: null, at: null };
}

function runModel(inp) {
    const stab = modelAtClients(inp, inp.client_max);

    // Client ramp by month (for 10-year projection)
    const months = 120;
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

    // Annual projection
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
            const mdl = modelAtClients(inp, c);
            avgClients += c;
            monthsCounted++;

            yearRevenue += mdl.monthlyRevenue * Math.pow(1 + inp.revenue_growth_rate / 100, y - 1);
            yearCosts += mdl.totalCosts * Math.pow(1 + inp.expense_growth_rate / 100, y - 1);
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

    const totalStartup = (inp.startup_costs || []).reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);

    const breakEven = findBreakEven(inp);

    const exitYear = Math.min(Math.max(1, inp.exit_year), 10);
    const exitEbitda = annualYears[exitYear - 1]?.ebitda || 0;
    const exitValue = exitEbitda * inp.exit_multiple;

    return {
        stab,
        annualYears,
        clientsByMonth,
        totalStartup,
        breakEven,
        exitYear,
        exitEbitda,
        exitValue,
        inp
    };
}

function recalculate() {
    const inp = getInputs();
    const r = runModel(inp);
    lastComputed = r;
    updateHourlyDisplays(inp);

    // KPIs
    document.getElementById('out-revenue').textContent = fmtMoney(r.stab.monthlyRevenue);
    document.getElementById('out-revenue-sub').textContent =
        `${fmtInt(inp.client_max)} clients × ${fmtMoney(r.stab.revPerClient)}/mo`;

    document.getElementById('out-costs').textContent = fmtMoney(r.stab.totalCosts);
    document.getElementById('out-costs-sub').textContent =
        `Labor ${fmtMoney(r.stab.directLabor + r.stab.adminMonthly)} · Other ${fmtMoney(r.stab.nonLaborMonthly)}`;

    const profitCard = document.getElementById('profit-card');
    profitCard.className = 'kpi-card ' + (r.stab.ebitda >= 0 ? 'kpi-success' : 'kpi-danger');
    document.getElementById('out-profit').textContent = fmtMoney(r.stab.ebitda);
    document.getElementById('out-margin').textContent = `${fmtPercent(r.stab.margin)} margin`;

    document.getElementById('out-breakeven').textContent = r.breakEven.clients || 'N/A';

    document.getElementById('out-startup').textContent = fmtMoney(r.totalStartup);
    document.getElementById('out-annual-revenue').textContent = fmtMoney(r.stab.monthlyRevenue * 12);
    document.getElementById('out-annual-ebitda').textContent = fmtMoney(r.stab.ebitda * 12);
    document.getElementById('out-exit-value').textContent = fmtMoney(r.exitValue);
    document.getElementById('out-exit-sub').textContent = `Year ${r.exitYear} @ ${inp.exit_multiple}x EBITDA`;

    renderProjectionChart(r);
    renderAnnualTable(r);
    renderCostBreakdownChart(r);
}

function updateHourlyDisplays(inp) {
    const fmtHr = (v) => '= $' + (parseFloat(v || 0) * 4).toFixed(2) + '/hour';
    const m = document.getElementById('medicaid-hourly-display');
    const i = document.getElementById('in-network-hourly-display');
    const o = document.getElementById('oon-hourly-display');
    if (m) m.textContent = fmtHr(inp.medicaid_rate_15min);
    if (i) i.textContent = fmtHr(inp.in_network_rate_15min);
    if (o) o.textContent = fmtHr(inp.oon_rate_15min);
}

// ============================================
// KPI EXPLANATION POPUPS
// ============================================

function showKPIBreakdown(kpi) {
    if (!lastComputed) return;
    const r = lastComputed;
    const inp = r.inp;

    let title = '';
    let body = '';

    if (kpi === 'revenue') {
        title = 'Stabilized Monthly Revenue — How It\'s Calculated';
        const weeks = 4.333;
        const hrs = inp.avg_hours_per_resident_week * weeks;
        const units = hrs * 4;
        const revPerUnit =
            (inp.medicaid_split / 100) * inp.medicaid_rate_15min +
            (inp.in_network_split / 100) * inp.in_network_rate_15min +
            (inp.oon_split / 100) * inp.oon_rate_15min;
        body = `
            <div class="calc-formula">Hours / client / month = ${inp.avg_hours_per_resident_week} hrs/wk × ${weeks.toFixed(3)} weeks = ${hrs.toFixed(2)} hrs
Units / client / month = ${hrs.toFixed(2)} × 4 units/hr = ${units.toFixed(2)} units
Weighted rate / unit = ${inp.medicaid_split}%×$${fmt(inp.medicaid_rate_15min)} + ${inp.in_network_split}%×$${fmt(inp.in_network_rate_15min)} + ${inp.oon_split}%×$${fmt(inp.oon_rate_15min)} = $${revPerUnit.toFixed(2)}
RBT rev / client = ${units.toFixed(2)} × $${revPerUnit.toFixed(2)} = ${fmtMoney(r.stab.rbtRevPerClient)}
BCBA rev / client = ${fmtMoney(r.stab.bcbaRevPerClient)} (assessment + supervision)
Total rev / client = ${fmtMoney(r.stab.revPerClient)}</div>
            <div class="calc-line"><span>RBT revenue per client (direct therapy)</span><span>${fmtMoney(r.stab.rbtRevPerClient)}</span></div>
            <div class="calc-line"><span>BCBA revenue per client (assessment + supervision)</span><span>${fmtMoney(r.stab.bcbaRevPerClient)}</span></div>
            <div class="calc-line"><span><strong>Revenue per client per month</strong></span><span><strong>${fmtMoney(r.stab.revPerClient)}</strong></span></div>
            <div class="calc-line"><span>× Stabilized client count</span><span>${fmtInt(inp.client_max)}</span></div>
            <div class="calc-line calc-total"><span>Stabilized Monthly Revenue</span><span>${fmtMoney(r.stab.monthlyRevenue)}</span></div>
        `;
    } else if (kpi === 'costs') {
        title = 'Stabilized Monthly Costs — How It\'s Calculated';
        const hrs = inp.avg_hours_per_resident_week * 4.333;
        body = `
            <h4>Direct Labor (${fmtMoney(r.stab.directLabor)})</h4>
            <div class="calc-line"><span>RBT: ${inp.client_max} clients × ${hrs.toFixed(2)} hrs × $${fmt(inp.rbt_hourly_rate)}/hr</span><span>${fmtMoney(r.stab.rbtMonthlyLabor)}</span></div>
            <div class="calc-line"><span>BCBA: hours × $${fmt(inp.bcba_hourly_rate)}/hr (assessment + supervision)</span><span>${fmtMoney(r.stab.bcbaMonthlyLabor)}</span></div>

            <h4 class="mt-2">Admin / Overhead (${fmtMoney(r.stab.adminMonthly)})</h4>
            ${r.stab.adminBreakdown.map(b => `<div class="calc-line"><span>${escapeAttr(b.name)} (${b.count} at $${fmt(b.annual_each)}/yr)</span><span>${fmtMoney(b.monthly_total)}</span></div>`).join('')}

            <h4 class="mt-2">Non-Labor (${fmtMoney(r.stab.nonLaborMonthly)})</h4>
            ${r.stab.nonLaborBreakdown.filter(b => b.monthly > 0).map(b => `<div class="calc-line"><span>${escapeAttr(b.name)} — ${escapeAttr(b.detail)}</span><span>${fmtMoney(b.monthly)}</span></div>`).join('')}

            <div class="calc-line calc-total"><span>Total Monthly Costs</span><span>${fmtMoney(r.stab.totalCosts)}</span></div>
        `;
    } else if (kpi === 'ebitda') {
        title = 'Stabilized Monthly EBITDA — How It\'s Calculated';
        body = `
            <div class="calc-line"><span>Monthly Revenue</span><span>${fmtMoney(r.stab.monthlyRevenue)}</span></div>
            <div class="calc-line"><span>− Direct Labor (RBT + BCBA)</span><span>${fmtMoney(-r.stab.directLabor)}</span></div>
            <div class="calc-line"><span>− Admin / Overhead</span><span>${fmtMoney(-r.stab.adminMonthly)}</span></div>
            <div class="calc-line"><span>− Non-Labor Costs</span><span>${fmtMoney(-r.stab.nonLaborMonthly)}</span></div>
            <div class="calc-line calc-total"><span>Monthly EBITDA</span><span>${fmtMoney(r.stab.ebitda)}</span></div>
            <div class="calc-line"><span>Margin</span><span>${fmtPercent(r.stab.margin)}</span></div>
        `;
    } else if (kpi === 'breakeven') {
        title = 'Break-Even Clients — How It\'s Calculated';
        const be = r.breakEven;
        if (be.clients) {
            body = `
                <p class="text-sm text-muted mb-2">The model iterates from 1 client upward and finds the lowest client count where monthly revenue ≥ monthly costs — <strong>taking into account that many admin roles and non-labor costs scale with client count</strong> (they don't exist at low client counts).</p>
                <div class="calc-line"><span><strong>Break-even client count</strong></span><span><strong>${be.clients}</strong></span></div>
                <h4 class="mt-2">At ${be.clients} clients:</h4>
                <div class="calc-line"><span>Monthly Revenue</span><span>${fmtMoney(be.at.monthlyRevenue)}</span></div>
                <div class="calc-line"><span>Direct Labor</span><span>${fmtMoney(be.at.directLabor)}</span></div>
                <div class="calc-line"><span>Admin (${be.at.adminHeadcount} people)</span><span>${fmtMoney(be.at.adminMonthly)}</span></div>
                <div class="calc-line"><span>Non-Labor</span><span>${fmtMoney(be.at.nonLaborMonthly)}</span></div>
                <div class="calc-line"><span><strong>Total Costs</strong></span><span><strong>${fmtMoney(be.at.totalCosts)}</strong></span></div>
                <div class="calc-line calc-total"><span>EBITDA at break-even</span><span>${fmtMoney(be.at.ebitda)}</span></div>
                <p class="text-xs text-muted mt-2">Note: many admin roles only "turn on" above certain client thresholds. At stabilized (${inp.client_max} clients) you'd have more roles than at ${be.clients}, which is why stabilized EBITDA % doesn't just linearly scale down.</p>
            `;
        } else {
            body = '<p>Break-even not reached within ' + inp.client_max + ' clients. Unit economics are negative at every client count — check assumptions.</p>';
        }
    } else if (kpi === 'startup') {
        title = 'Total Startup Investment — How It\'s Calculated';
        body = (inp.startup_costs || []).map(c =>
            `<div class="calc-line"><span>${escapeAttr(c.name)}</span><span>${fmtMoney(c.amount)}</span></div>`
        ).join('') +
        `<div class="calc-line calc-total"><span>Total Startup</span><span>${fmtMoney(r.totalStartup)}</span></div>`;
    } else if (kpi === 'annual-revenue') {
        title = 'Annual Revenue (Stabilized) — How It\'s Calculated';
        body = `
            <div class="calc-line"><span>Monthly Revenue (stabilized)</span><span>${fmtMoney(r.stab.monthlyRevenue)}</span></div>
            <div class="calc-line"><span>× 12 months</span><span></span></div>
            <div class="calc-line calc-total"><span>Annual Revenue</span><span>${fmtMoney(r.stab.monthlyRevenue * 12)}</span></div>
            <p class="text-xs text-muted mt-2">This assumes the business is already at stabilized client max (${inp.client_max}). Earlier years ramp — see the Annual P&L table.</p>
        `;
    } else if (kpi === 'annual-ebitda') {
        title = 'Annual EBITDA (Stabilized) — How It\'s Calculated';
        body = `
            <div class="calc-line"><span>Monthly EBITDA (stabilized)</span><span>${fmtMoney(r.stab.ebitda)}</span></div>
            <div class="calc-line"><span>× 12 months</span><span></span></div>
            <div class="calc-line calc-total"><span>Annual EBITDA</span><span>${fmtMoney(r.stab.ebitda * 12)}</span></div>
        `;
    } else if (kpi === 'exit') {
        title = 'Estimated Exit Value — How It\'s Calculated';
        const y = r.annualYears[r.exitYear - 1];
        body = `
            <p class="text-sm text-muted mb-2">Assumes exit at end of Year ${r.exitYear} at ${inp.exit_multiple}x annual EBITDA.</p>
            <div class="calc-line"><span>Year ${r.exitYear} projected EBITDA</span><span>${fmtMoney(y?.ebitda || 0)}</span></div>
            <div class="calc-line"><span>× Exit multiple</span><span>${inp.exit_multiple}x</span></div>
            <div class="calc-line calc-total"><span>Exit Value</span><span>${fmtMoney(r.exitValue)}</span></div>
            <p class="text-xs text-muted mt-2">Projected EBITDA accounts for ${inp.revenue_growth_rate}% annual revenue growth and ${inp.expense_growth_rate}% expense growth from the stabilized baseline.</p>
        `;
    }

    createModal('calc-modal', title, `<div style="max-height:65vh;overflow-y:auto;">${body}</div>`, `
        <button class="btn btn-secondary" id="calc-close">Close</button>
    `, 'modal-lg');
    openModal('calc-modal');
    document.getElementById('calc-close').addEventListener('click', () => closeModal('calc-modal'));
}

// ============================================
// CHARTS & TABLES
// ============================================

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
            responsive: true, maintainAspectRatio: false,
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
        year_num: y.year,
        year_label: 'Year ' + y.year,
        clients: y.avgClients,
        revenue: y.revenue,
        costs: y.costs,
        ebitda: y.ebitda,
        margin: y.margin
    }));

    const table = new DataTable('annual-table', {
        columns: [
            { key: 'year_num', type: 'number', label: 'Year', render: (_, r) => r.year_label },
            { key: 'clients', label: 'Avg Clients', type: 'number', align: 'text-center' },
            { key: 'revenue', label: 'Revenue', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'costs', label: 'Costs', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'ebitda', label: 'EBITDA', type: 'number', align: 'text-right', render: v => {
                const cls = v >= 0 ? 'text-success' : 'text-danger';
                return `<strong class="${cls}">${fmtMoney(v)}</strong>`;
            }},
            { key: 'margin', label: 'Margin', type: 'number', align: 'text-right', render: v => {
                const cls = v >= 20 ? 'text-success' : v >= 0 ? 'text-warning' : 'text-danger';
                return `<span class="${cls}">${fmtPercent(v)}</span>`;
            }}
        ],
        defaultSort: 'year_num',
        defaultSortDir: 'asc',
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
                { label: 'RBT Labor', data: [r.stab.rbtMonthlyLabor], backgroundColor: '#3b82f6' },
                { label: 'BCBA Labor', data: [r.stab.bcbaMonthlyLabor], backgroundColor: '#8b5cf6' },
                { label: 'Admin / Overhead', data: [r.stab.adminMonthly], backgroundColor: '#ef4444' },
                { label: 'Non-Labor', data: [r.stab.nonLaborMonthly], backgroundColor: '#f59e0b' }
            ]
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
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

// ============================================
// SAVE / LOAD SCENARIOS
// ============================================

async function saveScenario() {
    const name = prompt('Scenario name:');
    if (!name) return;

    const user = getCurrentStaff();
    const inp = getInputs();
    const r = runModel(inp);

    const { error } = await supabase.from('pro_forma_scenarios').insert({
        name,
        assumptions: inp,
        outputs: {
            stabMonthlyRevenue: r.stab.monthlyRevenue,
            stabTotalCosts: r.stab.totalCosts,
            stabEbitda: r.stab.ebitda,
            stabMargin: r.stab.margin,
            breakeven: r.breakEven.clients,
            exitValue: r.exitValue
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
                ${s.assumptions.client_max || '?'} clients · ${fmtPercent(s.outputs?.stabMargin || 0)} margin
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

    const flatInputs = {};
    for (const [k, v] of Object.entries(inp)) {
        if (!Array.isArray(v)) flatInputs[k] = v;
    }

    exportToExcel(`MO_ProForma_${new Date().toISOString().split('T')[0]}.xlsx`, [
        {
            name: 'Assumptions',
            data: Object.entries(flatInputs).map(([k, v]) => ({ Assumption: k.replace(/_/g, ' '), Value: v }))
        },
        {
            name: 'Admin Salaries',
            data: (inp.admin_salaries || []).map(s => ({
                Role: s.name, Annual_Salary: s.annual, Starts_At_Clients: s.start_at, Per_Additional_Clients: s.per_clients
            }))
        },
        {
            name: 'Non-Labor Costs',
            data: (inp.non_labor_costs || []).map(c => ({
                Line_Item: c.name, Amount: c.amount, Scale_Type: c.scale_type, Divisor: c.scale_divisor
            }))
        },
        {
            name: 'Startup Costs',
            data: (inp.startup_costs || []).map(c => ({ Line_Item: c.name, Amount: c.amount }))
        },
        {
            name: 'Stabilized P&L',
            data: [{
                Monthly_Revenue: r.stab.monthlyRevenue,
                RBT_Labor: r.stab.rbtMonthlyLabor,
                BCBA_Labor: r.stab.bcbaMonthlyLabor,
                Admin_Overhead: r.stab.adminMonthly,
                Non_Labor: r.stab.nonLaborMonthly,
                Total_Costs: r.stab.totalCosts,
                EBITDA: r.stab.ebitda,
                Margin_Pct: r.stab.margin.toFixed(2),
                Annual_Revenue: r.stab.monthlyRevenue * 12,
                Annual_EBITDA: r.stab.ebitda * 12,
                Break_Even_Clients: r.breakEven.clients,
                Total_Startup: r.totalStartup,
                Exit_Value: r.exitValue
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

// ============================================
// HELPERS
// ============================================

function fmt(v) {
    return (parseFloat(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

init();
