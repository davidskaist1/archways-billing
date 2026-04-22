import { requireAuth, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { DataTable } from './ui.js';
import { supabase } from './supabase-client.js';
import {
    getBusinessSnapshot, getMonthlyFinancials, getARLagMonthly,
    calculatePL, exportToExcel, fmtMoney, fmtPercent, fmtMonth, fmtInt
} from './investor-helpers.js';

let monthlyData = [];
let snapshot = null;

async function init() {
    const auth = await requireAuth(['admin', 'investor']);
    if (!auth) return;
    renderNav();

    const user = getCurrentStaff();
    document.getElementById('current-date').textContent = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    await loadAll();

    document.getElementById('export-btn').addEventListener('click', exportData);
    document.getElementById('cycle-select').addEventListener('change', loadCycleMetrics);
}

async function loadCycleMetrics() {
    const days = parseInt(document.getElementById('cycle-select').value) || 30;
    const { data, error } = await supabase.rpc('get_cycle_metrics', { days_back: days });
    if (error) return;
    const m = Array.isArray(data) ? data[0] : data;
    if (!m) return;

    document.getElementById('cycle-clients').textContent = fmtInt(m.clients_billed);
    document.getElementById('cycle-97153').textContent = parseFloat(m.total_hours_97153).toFixed(1);
    document.getElementById('cycle-all-hours').textContent = parseFloat(m.total_hours_all).toFixed(1);
    document.getElementById('cycle-claims').textContent = fmtInt(m.total_claims);
    document.getElementById('cycle-billed').textContent = fmtMoney(m.total_billed);
}

async function loadAll() {
    snapshot = await getBusinessSnapshot();
    monthlyData = calculatePL(await getMonthlyFinancials());
    const arLagData = await getARLagMonthly();

    renderKPIs(arLagData);
    renderSnapshot();
    renderTrendChart();
    renderPLTable();
    await loadCycleMetrics();
}

function renderKPIs(arLagData) {
    // Last 30 days (most recent month)
    const lastMonth = monthlyData.length > 0 ? monthlyData[monthlyData.length - 1] : null;

    if (lastMonth) {
        document.getElementById('kpi-revenue-30').textContent = fmtMoney(lastMonth.revenue);
        document.getElementById('kpi-revenue-sub').textContent = fmtMonth(lastMonth.month);
        document.getElementById('kpi-profit-30').textContent = fmtMoney(lastMonth.net_profit);
        document.getElementById('kpi-margin-sub').textContent = `${fmtPercent(lastMonth.margin_pct)} margin`;
    } else {
        document.getElementById('kpi-revenue-30').textContent = fmtMoney(0);
        document.getElementById('kpi-profit-30').textContent = fmtMoney(0);
    }

    // AR lag (average across all months)
    if (arLagData && arLagData.length > 0) {
        const total = arLagData.reduce((sum, x) => sum + parseFloat(x.avg_days || 0), 0);
        const avg = total / arLagData.length;
        document.getElementById('kpi-ar-lag').textContent = avg.toFixed(0) + ' days';
    } else {
        document.getElementById('kpi-ar-lag').textContent = '—';
    }

    // Outstanding AR
    if (snapshot) {
        document.getElementById('kpi-ar-outstanding').textContent = fmtMoney(snapshot.outstanding_ar);
    }
}

function renderSnapshot() {
    if (!snapshot) return;

    document.getElementById('snap-lifetime-revenue').textContent = fmtMoney(snapshot.lifetime_revenue);
    document.getElementById('snap-active-clients').textContent = fmtInt(snapshot.active_clients);
    document.getElementById('snap-active-staff').textContent = fmtInt(snapshot.active_staff);
    document.getElementById('snap-capital').textContent = fmtMoney(snapshot.total_capital_raised);
}

function renderTrendChart() {
    // Take last 12 months
    const last12 = monthlyData.slice(-12);

    const ctx = document.getElementById('trend-chart');
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: last12.map(m => fmtMonth(m.month)),
            datasets: [
                {
                    label: 'Revenue',
                    data: last12.map(m => m.revenue),
                    backgroundColor: 'rgba(16,185,129,0.8)',
                    order: 2
                },
                {
                    label: 'Payroll + OpEx',
                    data: last12.map(m => m.total_costs),
                    backgroundColor: 'rgba(239,68,68,0.6)',
                    order: 2
                },
                {
                    label: 'Net Profit',
                    data: last12.map(m => m.net_profit),
                    type: 'line',
                    borderColor: '#1a56db',
                    backgroundColor: 'rgba(26,86,219,0.1)',
                    borderWidth: 3,
                    tension: 0.3,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                    callbacks: { label: ctx => ctx.dataset.label + ': ' + fmtMoney(ctx.raw) }
                }
            },
            scales: {
                y: {
                    ticks: { callback: v => '$' + v.toLocaleString() }
                }
            }
        }
    });
}

function renderPLTable() {
    // Last 12 months, newest first
    const rows = [...monthlyData].reverse().slice(0, 12);

    const table = new DataTable('pl-table', {
        columns: [
            { key: 'month', label: 'Month', render: v => fmtMonth(v) },
            { key: 'revenue', label: 'Revenue', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'payroll', label: 'Payroll', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'opex', label: 'Operating Expenses', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'total_costs', label: 'Total Costs', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'net_profit', label: 'Net Profit', type: 'number', align: 'text-right', render: v => {
                const cls = v >= 0 ? 'text-success' : 'text-danger';
                return `<strong class="${cls}">${fmtMoney(v)}</strong>`;
            }},
            { key: 'margin_pct', label: 'Margin', align: 'text-right', render: v => {
                const cls = v >= 20 ? 'text-success' : v >= 0 ? 'text-warning' : 'text-danger';
                return `<span class="${cls}">${fmtPercent(v)}</span>`;
            }}
        ],
        defaultSort: 'month',
        defaultSortDir: 'desc',
        pageSize: 12
    });
    rows.forEach((r, i) => r.id = i); // add unique id for table
    table.setData(rows);
}

function exportData() {
    const sheets = [
        {
            name: 'Business Snapshot',
            data: [snapshot || {}]
        },
        {
            name: 'Monthly P&L',
            data: monthlyData.map(m => ({
                Month: fmtMonth(m.month),
                Revenue: m.revenue,
                Payroll: m.payroll,
                Operating_Expenses: m.opex,
                Total_Costs: m.total_costs,
                Net_Profit: m.net_profit,
                Margin_Percent: m.margin_pct.toFixed(2)
            }))
        }
    ];

    exportToExcel(`archways_financials_${new Date().toISOString().split('T')[0]}.xlsx`, sheets);
}

init();
