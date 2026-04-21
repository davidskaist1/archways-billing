import { requireAuth, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, confirmDialog } from './ui.js';
import { exportToExcel, fmtMoney, fmtPercent, fmtInt } from './investor-helpers.js';

const INPUT_IDS = [
    'pf-clients', 'pf-hours-per-client', 'pf-billed-rate', 'pf-collection-rate',
    'pf-staff-rate', 'pf-utilization', 'pf-payroll-tax',
    'pf-fixed-opex', 'pf-variable-opex'
];

const DEFAULTS = {
    'pf-clients': 20,
    'pf-hours-per-client': 20,
    'pf-billed-rate': 120,
    'pf-collection-rate': 92,
    'pf-staff-rate': 35,
    'pf-utilization': 80,
    'pf-payroll-tax': 15,
    'pf-fixed-opex': 8000,
    'pf-variable-opex': 3
};

let costChart;

async function init() {
    const auth = await requireAuth(['admin', 'investor']);
    if (!auth) return;
    renderNav();

    // Wire up inputs
    INPUT_IDS.forEach(id => {
        document.getElementById(id).addEventListener('input', calculate);
    });

    document.getElementById('reset-btn').addEventListener('click', resetDefaults);
    document.getElementById('save-btn').addEventListener('click', saveScenario);
    document.getElementById('export-btn').addEventListener('click', exportData);

    await loadCurrent();
    calculate();
    await loadScenarios();
}

async function loadCurrent() {
    // Try to pre-fill from actual recent data if the user is admin
    const user = getCurrentStaff();
    if (user.role !== 'admin') return;

    try {
        // Active clients
        const { count: clientCount } = await supabase.from('clients').select('*', { count: 'exact', head: true }).eq('is_active', true);
        if (clientCount) document.getElementById('pf-clients').value = clientCount;

        // Staff avg rate (if we have data)
        const { data: staff } = await supabase.from('staff').select('hourly_rate').eq('is_active', true).not('hourly_rate', 'is', null);
        if (staff && staff.length > 0) {
            const avg = staff.reduce((s, x) => s + parseFloat(x.hourly_rate), 0) / staff.length;
            if (avg > 0) document.getElementById('pf-staff-rate').value = avg.toFixed(2);
        }

        // Fixed opex from monthly recurring expenses
        const { data: expenses } = await supabase.from('operating_expenses')
            .select('amount, recurrence_frequency, is_recurring').eq('is_recurring', true);
        if (expenses && expenses.length > 0) {
            let monthly = 0;
            for (const e of expenses) {
                const amt = parseFloat(e.amount);
                if (e.recurrence_frequency === 'monthly') monthly += amt;
                else if (e.recurrence_frequency === 'quarterly') monthly += amt / 3;
                else if (e.recurrence_frequency === 'annually') monthly += amt / 12;
            }
            if (monthly > 0) document.getElementById('pf-fixed-opex').value = monthly.toFixed(0);
        }
    } catch {}
}

function getInputs() {
    return Object.fromEntries(
        INPUT_IDS.map(id => [id, parseFloat(document.getElementById(id).value) || 0])
    );
}

function runModel(inp) {
    const clients = inp['pf-clients'];
    const hrsPerClient = inp['pf-hours-per-client'];
    const billedRate = inp['pf-billed-rate'];
    const collectionRate = inp['pf-collection-rate'] / 100;
    const staffRate = inp['pf-staff-rate'];
    const utilization = inp['pf-utilization'] / 100;
    const payrollTax = inp['pf-payroll-tax'] / 100;
    const fixedOpex = inp['pf-fixed-opex'];
    const variableOpex = inp['pf-variable-opex'] / 100;

    // Weekly billable hours across all clients
    const weeklyBillableHours = clients * hrsPerClient;
    const monthlyBillableHours = weeklyBillableHours * 4.33; // weeks per month avg

    // Revenue
    const billedMonthly = monthlyBillableHours * billedRate;
    const revenueMonthly = billedMonthly * collectionRate;

    // Payroll — to get billable hours, we need staff-paid hours (billable / utilization)
    const staffPaidHours = utilization > 0 ? monthlyBillableHours / utilization : 0;
    const grossWages = staffPaidHours * staffRate;
    const totalPayroll = grossWages * (1 + payrollTax);

    // OpEx
    const totalVariableOpex = revenueMonthly * variableOpex;
    const totalOpex = fixedOpex + totalVariableOpex;

    // Totals
    const totalCosts = totalPayroll + totalOpex;
    const netProfit = revenueMonthly - totalCosts;
    const marginPct = revenueMonthly > 0 ? (netProfit / revenueMonthly) * 100 : 0;

    return {
        clients, hrsPerClient, billedRate, collectionRate,
        monthlyBillableHours, billedMonthly, revenueMonthly,
        staffPaidHours, grossWages, totalPayroll,
        fixedOpex, totalVariableOpex, totalOpex,
        totalCosts, netProfit, marginPct
    };
}

function calculate() {
    const inp = getInputs();
    const r = runModel(inp);

    document.getElementById('out-revenue').textContent = fmtMoney(r.revenueMonthly);
    document.getElementById('out-revenue-sub').textContent =
        `${fmtInt(r.monthlyBillableHours.toFixed(0))} billable hrs · ${fmtMoney(r.billedMonthly)} billed`;

    document.getElementById('out-costs').textContent = fmtMoney(r.totalCosts);
    document.getElementById('out-costs-sub').textContent =
        `Payroll ${fmtMoney(r.totalPayroll)} · OpEx ${fmtMoney(r.totalOpex)}`;

    const profitEl = document.getElementById('out-profit');
    profitEl.textContent = fmtMoney(r.netProfit);
    const card = document.getElementById('profit-card');
    card.className = 'kpi-card ' + (r.netProfit >= 0 ? 'kpi-success' : 'kpi-danger');

    document.getElementById('out-margin').textContent = `${fmtPercent(r.marginPct)} margin`;

    // Break-even clients
    const fixedCosts = r.fixedOpex;
    const grossPerClientPerMonth = inp['pf-hours-per-client'] * 4.33 * inp['pf-billed-rate'] * (inp['pf-collection-rate'] / 100);
    const paidHrsPerClient = (inp['pf-utilization'] > 0) ? (inp['pf-hours-per-client'] * 4.33 / (inp['pf-utilization'] / 100)) : 0;
    const payrollPerClient = paidHrsPerClient * inp['pf-staff-rate'] * (1 + inp['pf-payroll-tax'] / 100);
    const variableOpexPerClient = grossPerClientPerMonth * (inp['pf-variable-opex'] / 100);
    const contributionPerClient = grossPerClientPerMonth - payrollPerClient - variableOpexPerClient;
    const breakeven = contributionPerClient > 0 ? Math.ceil(fixedCosts / contributionPerClient) : null;
    document.getElementById('out-breakeven').textContent = breakeven ? breakeven : 'N/A';

    renderCostChart(r);
    renderAnnualTable(r);
    renderSensitivity(inp, r);
}

function renderCostChart(r) {
    const ctx = document.getElementById('cost-chart');
    if (costChart) costChart.destroy();

    costChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Monthly Breakdown'],
            datasets: [
                { label: 'Payroll', data: [r.totalPayroll], backgroundColor: '#ef4444' },
                { label: 'Fixed OpEx', data: [r.fixedOpex], backgroundColor: '#f59e0b' },
                { label: 'Variable OpEx', data: [r.totalVariableOpex], backgroundColor: '#eab308' },
                { label: 'Net Profit', data: [Math.max(0, r.netProfit)], backgroundColor: '#10b981' }
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

function renderAnnualTable(r) {
    const rows = [];
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let ytdProfit = 0;
    for (let i = 0; i < 12; i++) {
        ytdProfit += r.netProfit;
        rows.push({
            id: i,
            month: monthNames[i],
            revenue: r.revenueMonthly,
            costs: r.totalCosts,
            profit: r.netProfit,
            ytd_profit: ytdProfit
        });
    }
    rows.push({
        id: 999,
        month: 'ANNUAL TOTAL',
        revenue: r.revenueMonthly * 12,
        costs: r.totalCosts * 12,
        profit: r.netProfit * 12,
        ytd_profit: r.netProfit * 12
    });

    const table = new DataTable('annual-table', {
        columns: [
            { key: 'month', label: 'Month', render: v => v === 'ANNUAL TOTAL' ? `<strong>${v}</strong>` : v },
            { key: 'revenue', label: 'Revenue', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'costs', label: 'Costs', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'profit', label: 'Monthly Profit', type: 'number', align: 'text-right', render: v => {
                const cls = v >= 0 ? 'text-success' : 'text-danger';
                return `<strong class="${cls}">${fmtMoney(v)}</strong>`;
            }},
            { key: 'ytd_profit', label: 'YTD Profit', type: 'number', align: 'text-right', render: v => {
                const cls = v >= 0 ? 'text-success' : 'text-danger';
                return `<span class="${cls}">${fmtMoney(v)}</span>`;
            }}
        ],
        defaultSort: 'id',
        pageSize: 13
    });
    table.setData(rows);
}

function renderSensitivity(inp, baseline) {
    // For each key dial, calculate: -10%, baseline, +10%, +25%
    const dials = [
        { id: 'pf-clients', label: 'Active Clients' },
        { id: 'pf-hours-per-client', label: 'Hours / Client / Week' },
        { id: 'pf-billed-rate', label: 'Billed Rate / Hour' },
        { id: 'pf-collection-rate', label: 'Collection Rate' },
        { id: 'pf-staff-rate', label: 'Staff Rate' },
        { id: 'pf-utilization', label: 'Utilization' },
        { id: 'pf-fixed-opex', label: 'Fixed OpEx' }
    ];

    const rows = dials.map((d, idx) => {
        const scenarios = {};
        for (const pct of [-10, -5, 0, 5, 10, 25]) {
            const modified = { ...inp };
            modified[d.id] = inp[d.id] * (1 + pct / 100);
            scenarios[pct] = runModel(modified).netProfit;
        }
        return {
            id: idx,
            dial: d.label,
            value: inp[d.id],
            neg10: scenarios[-10],
            neg5: scenarios[-5],
            baseline: scenarios[0],
            pos5: scenarios[5],
            pos10: scenarios[10],
            pos25: scenarios[25]
        };
    });

    const renderCell = (v) => {
        const cls = v >= baseline.netProfit ? 'text-success' : 'text-danger';
        return `<span class="${cls}">${fmtMoney(v)}</span>`;
    };

    const table = new DataTable('sensitivity-table', {
        columns: [
            { key: 'dial', label: 'Change this dial...' },
            { key: 'neg10', label: '-10%', type: 'number', align: 'text-right', render: renderCell },
            { key: 'neg5', label: '-5%', type: 'number', align: 'text-right', render: renderCell },
            { key: 'baseline', label: 'Baseline', type: 'number', align: 'text-right', render: v => `<strong>${fmtMoney(v)}</strong>` },
            { key: 'pos5', label: '+5%', type: 'number', align: 'text-right', render: renderCell },
            { key: 'pos10', label: '+10%', type: 'number', align: 'text-right', render: renderCell },
            { key: 'pos25', label: '+25%', type: 'number', align: 'text-right', render: renderCell }
        ],
        defaultSort: 'id',
        pageSize: 10
    });
    table.setData(rows);
}

function resetDefaults() {
    for (const [id, val] of Object.entries(DEFAULTS)) {
        document.getElementById(id).value = val;
    }
    calculate();
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
        outputs,
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
        .order('created_at', { ascending: false });

    const list = document.getElementById('scenarios-list');
    if (!data || data.length === 0) {
        list.innerHTML = '<p class="text-sm text-muted">No saved scenarios yet. Tweak the inputs above and click "Save Scenario" to save one.</p>';
        return;
    }

    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;">';
    for (const s of data) {
        const profit = parseFloat(s.outputs?.netProfit) || 0;
        const profitCls = profit >= 0 ? 'text-success' : 'text-danger';
        const author = s.app_users ? `${s.app_users.first_name} ${s.app_users.last_name}` : 'Unknown';
        html += `<div class="card" style="padding:12px;">
            <div class="flex-between mb-1">
                <strong>${s.name}</strong>
                <span class="${profitCls} font-bold">${fmtMoney(profit)}</span>
            </div>
            <div class="text-xs text-muted mb-1">${s.assumptions['pf-clients']} clients · ${s.assumptions['pf-hours-per-client']} hrs/wk · ${fmtPercent(s.outputs?.marginPct || 0)} margin</div>
            <div class="text-xs text-muted">${author} · ${new Date(s.created_at).toLocaleDateString()}</div>
            <div class="flex gap-1 mt-1">
                <button class="btn btn-sm btn-secondary load-scn" data-id="${s.id}">Load</button>
                <button class="btn btn-sm btn-ghost text-danger del-scn" data-id="${s.id}">Delete</button>
            </div>
        </div>`;
    }
    html += '</div>';
    list.innerHTML = html;

    list.querySelectorAll('.load-scn').forEach(btn => {
        btn.addEventListener('click', () => {
            const s = data.find(x => x.id === btn.dataset.id);
            if (!s) return;
            for (const [id, val] of Object.entries(s.assumptions)) {
                const el = document.getElementById(id);
                if (el) el.value = val;
            }
            calculate();
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

    exportToExcel(`pro_forma_${new Date().toISOString().split('T')[0]}.xlsx`, [
        {
            name: 'Assumptions',
            data: Object.entries(inp).map(([k, v]) => ({ Assumption: k.replace('pf-', '').replace(/-/g, ' '), Value: v }))
        },
        {
            name: 'Monthly Output',
            data: [{
                Monthly_Billable_Hours: r.monthlyBillableHours.toFixed(2),
                Monthly_Billed: r.billedMonthly.toFixed(2),
                Monthly_Revenue: r.revenueMonthly.toFixed(2),
                Monthly_Payroll: r.totalPayroll.toFixed(2),
                Monthly_Fixed_OpEx: r.fixedOpex.toFixed(2),
                Monthly_Variable_OpEx: r.totalVariableOpex.toFixed(2),
                Monthly_Total_Costs: r.totalCosts.toFixed(2),
                Monthly_Net_Profit: r.netProfit.toFixed(2),
                Margin_Percent: r.marginPct.toFixed(2)
            }]
        },
        {
            name: 'Annual Projection',
            data: [{
                Annual_Revenue: (r.revenueMonthly * 12).toFixed(2),
                Annual_Costs: (r.totalCosts * 12).toFixed(2),
                Annual_Net_Profit: (r.netProfit * 12).toFixed(2)
            }]
        }
    ]);
}

init();
