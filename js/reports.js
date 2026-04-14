import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, formatCurrency, formatDate, statusBadge } from './ui.js';

let agingChart, revenueChart, prodChart;
let agingData = [], revenueData = [], prodData = [], paysumData = [];

async function init() {
    const auth = await requireAuth();
    if (!auth) return;
    renderNav();

    // Load payers
    const { data: payers } = await supabase.from('insurance_payers').select('id, name').order('name');
    const agingPayer = document.getElementById('aging-payer');
    for (const p of (payers || [])) {
        agingPayer.innerHTML += `<option value="${p.id}">${p.name}</option>`;
    }

    // Default dates: last 90 days
    const now = new Date();
    const ninetyAgo = new Date(now);
    ninetyAgo.setDate(ninetyAgo.getDate() - 90);
    const nowStr = now.toISOString().split('T')[0];
    const agoStr = ninetyAgo.toISOString().split('T')[0];

    document.getElementById('revenue-from').value = agoStr;
    document.getElementById('revenue-to').value = nowStr;
    document.getElementById('prod-from').value = agoStr;
    document.getElementById('prod-to').value = nowStr;

    // Default payroll period
    const periodStart = now.getDate() <= 15
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getFullYear(), now.getMonth(), 16);
    const periodEnd = now.getDate() <= 15
        ? new Date(now.getFullYear(), now.getMonth(), 15)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0);
    document.getElementById('paysum-start').value = periodStart.toISOString().split('T')[0];
    document.getElementById('paysum-end').value = periodEnd.toISOString().split('T')[0];

    setupTabs();

    document.getElementById('aging-run-btn').addEventListener('click', runAgingReport);
    document.getElementById('aging-export-btn').addEventListener('click', () => exportCSV(agingData, 'aging'));
    document.getElementById('revenue-run-btn').addEventListener('click', runRevenueReport);
    document.getElementById('revenue-export-btn').addEventListener('click', () => exportCSV(revenueData, 'revenue'));
    document.getElementById('prod-run-btn').addEventListener('click', runProductivityReport);
    document.getElementById('prod-export-btn').addEventListener('click', () => exportCSV(prodData, 'productivity'));
    document.getElementById('paysum-run-btn').addEventListener('click', runPayrollSummary);
    document.getElementById('paysum-export-btn').addEventListener('click', () => exportCSV(paysumData, 'payroll'));

    await runAgingReport();
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        });
    });
}

// ============================================
// AGING REPORT
// ============================================

async function runAgingReport() {
    const payerId = document.getElementById('aging-payer').value;

    let query = supabase
        .from('claims')
        .select('*, clients(first_name, last_name), insurance_payers(name)')
        .in('status', ['submitted', 'partial', 'appealed'])
        .order('service_date');

    if (payerId) query = query.eq('payer_id', payerId);

    const { data, error } = await query;
    if (error) { showToast('Failed to load: ' + error.message, 'error'); return; }

    const today = new Date();
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 };
    const bucketCounts = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 };

    agingData = (data || []).map(c => {
        const days = Math.floor((today - new Date(c.service_date)) / (1000 * 60 * 60 * 24));
        const outstanding = parseFloat(c.billed_amount) - parseFloat(c.paid_amount || 0);
        let bucket;
        if (days <= 30) bucket = '0-30';
        else if (days <= 60) bucket = '31-60';
        else if (days <= 90) bucket = '61-90';
        else if (days <= 120) bucket = '91-120';
        else bucket = '120+';

        buckets[bucket] += outstanding;
        bucketCounts[bucket]++;

        return {
            id: c.id,
            service_date: c.service_date,
            client_name: c.clients ? `${c.clients.last_name}, ${c.clients.first_name}` : '(Unknown)',
            payer_name: c.insurance_payers?.name || '(Unknown)',
            cpt_code: c.cpt_code,
            billed_amount: c.billed_amount,
            paid_amount: c.paid_amount,
            outstanding,
            days_old: days,
            age_bucket: bucket,
            status: c.status
        };
    });

    // Chart
    const ctx = document.getElementById('aging-chart');
    if (agingChart) agingChart.destroy();
    agingChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Object.keys(buckets).map((k, i) =>
                `${k} days (${bucketCounts[Object.keys(buckets)[i]]} claims)`
            ),
            datasets: [{
                label: 'Outstanding Amount',
                data: Object.values(buckets),
                backgroundColor: ['#3b82f6', '#60a5fa', '#f59e0b', '#f97316', '#ef4444']
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } } }
        }
    });

    // Table
    const table = new DataTable('aging-table', {
        columns: [
            { key: 'service_date', label: 'Service Date', type: 'date', render: v => formatDate(v) },
            { key: 'client_name', label: 'Client' },
            { key: 'payer_name', label: 'Payer' },
            { key: 'cpt_code', label: 'CPT', className: 'text-mono' },
            { key: 'billed_amount', label: 'Billed', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'paid_amount', label: 'Paid', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'outstanding', label: 'Outstanding', type: 'number', align: 'text-right', render: v => `<strong>${formatCurrency(v)}</strong>` },
            { key: 'days_old', label: 'Days', type: 'number', align: 'text-center', render: v => {
                const cls = v > 90 ? 'text-danger font-bold' : v > 60 ? 'text-warning' : '';
                return `<span class="${cls}">${v}</span>`;
            }},
            { key: 'status', label: 'Status', render: v => statusBadge(v) }
        ],
        defaultSort: 'days_old',
        defaultSortDir: 'desc',
        pageSize: 20
    });
    table.setData(agingData);
}

// ============================================
// REVENUE BY PAYER
// ============================================

async function runRevenueReport() {
    const from = document.getElementById('revenue-from').value;
    const to = document.getElementById('revenue-to').value;

    let query = supabase
        .from('claims')
        .select('payer_id, billed_amount, paid_amount, status, insurance_payers(name)');

    if (from) query = query.gte('service_date', from);
    if (to) query = query.lte('service_date', to);

    const { data, error } = await query;
    if (error) { showToast('Failed to load: ' + error.message, 'error'); return; }

    // Group by payer
    const payerMap = {};
    for (const c of (data || [])) {
        const name = c.insurance_payers?.name || '(Unknown)';
        if (!payerMap[name]) payerMap[name] = { claims: 0, billed: 0, paid: 0 };
        payerMap[name].claims++;
        payerMap[name].billed += parseFloat(c.billed_amount) || 0;
        payerMap[name].paid += parseFloat(c.paid_amount) || 0;
    }

    revenueData = Object.entries(payerMap).map(([name, d]) => ({
        id: name,
        payer_name: name,
        claims_count: d.claims,
        billed_total: d.billed,
        paid_total: d.paid,
        collection_rate: d.billed > 0 ? ((d.paid / d.billed) * 100).toFixed(1) : '0.0'
    })).sort((a, b) => b.paid_total - a.paid_total);

    // Chart
    const ctx = document.getElementById('revenue-chart');
    if (revenueChart) revenueChart.destroy();

    const colors = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];
    revenueChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: revenueData.map(d => d.payer_name),
            datasets: [{
                data: revenueData.map(d => d.paid_total),
                backgroundColor: revenueData.map((_, i) => colors[i % colors.length])
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${formatCurrency(ctx.raw)}` } }
            }
        }
    });

    // Table
    const table = new DataTable('revenue-table', {
        columns: [
            { key: 'payer_name', label: 'Payer' },
            { key: 'claims_count', label: 'Claims', type: 'number', align: 'text-center' },
            { key: 'billed_total', label: 'Billed', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'paid_total', label: 'Collected', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'collection_rate', label: 'Rate', align: 'text-center', render: v => {
                const num = parseFloat(v);
                const cls = num >= 90 ? 'text-success' : num >= 70 ? 'text-warning' : 'text-danger';
                return `<span class="${cls} font-bold">${v}%</span>`;
            }}
        ],
        defaultSort: 'paid_total',
        defaultSortDir: 'desc'
    });
    table.setData(revenueData);
}

// ============================================
// STAFF PRODUCTIVITY
// ============================================

async function runProductivityReport() {
    const from = document.getElementById('prod-from').value;
    const to = document.getElementById('prod-to').value;

    let query = supabase
        .from('sessions')
        .select('staff_id, duration_hours, session_type, is_converted, staff(first_name, last_name, credential)');

    if (from) query = query.gte('session_date', from);
    if (to) query = query.lte('session_date', to);

    const { data, error } = await query;
    if (error) { showToast('Failed to load: ' + error.message, 'error'); return; }

    const staffMap = {};
    for (const s of (data || [])) {
        const name = s.staff ? `${s.staff.last_name}, ${s.staff.first_name}` : s.staff_id;
        if (!staffMap[name]) {
            staffMap[name] = { credential: s.staff?.credential || '', total_sessions: 0, total_hours: 0, converted: 0, cancelled: 0 };
        }
        staffMap[name].total_sessions++;
        staffMap[name].total_hours += parseFloat(s.duration_hours) || 0;
        if (s.is_converted) staffMap[name].converted++;
        else staffMap[name].cancelled++;
    }

    prodData = Object.entries(staffMap).map(([name, d]) => ({
        id: name,
        staff_name: name,
        credential: d.credential,
        total_sessions: d.total_sessions,
        total_hours: d.total_hours,
        converted: d.converted,
        cancelled: d.cancelled,
        conversion_rate: d.total_sessions > 0 ? ((d.converted / d.total_sessions) * 100).toFixed(1) : '0.0'
    })).sort((a, b) => b.total_hours - a.total_hours);

    // Chart
    const ctx = document.getElementById('prod-chart');
    if (prodChart) prodChart.destroy();
    prodChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: prodData.map(d => d.staff_name),
            datasets: [{
                label: 'Converted Hours',
                data: prodData.map(d => d.total_hours),
                backgroundColor: '#3b82f6'
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } }
        }
    });

    // Table
    const table = new DataTable('prod-table', {
        columns: [
            { key: 'staff_name', label: 'Staff Member' },
            { key: 'credential', label: 'Credential', render: v => v || '—' },
            { key: 'total_sessions', label: 'Sessions', type: 'number', align: 'text-center' },
            { key: 'total_hours', label: 'Total Hours', type: 'number', align: 'text-center', render: v => v.toFixed(2) },
            { key: 'converted', label: 'Converted', type: 'number', align: 'text-center' },
            { key: 'cancelled', label: 'Not Converted', type: 'number', align: 'text-center' },
            { key: 'conversion_rate', label: 'Conv. Rate', align: 'text-center', render: v => {
                const num = parseFloat(v);
                const cls = num >= 90 ? 'text-success' : num >= 75 ? 'text-warning' : 'text-danger';
                return `<span class="${cls} font-bold">${v}%</span>`;
            }}
        ],
        defaultSort: 'total_hours',
        defaultSortDir: 'desc'
    });
    table.setData(prodData);
}

// ============================================
// PAYROLL SUMMARY
// ============================================

async function runPayrollSummary() {
    const start = document.getElementById('paysum-start').value;
    const end = document.getElementById('paysum-end').value;

    if (!start || !end) { showToast('Select a date range.', 'error'); return; }

    const { data, error } = await supabase
        .from('payroll_periods')
        .select('*, staff(first_name, last_name, credential)')
        .gte('period_start', start)
        .lte('period_end', end)
        .order('staff(last_name)');

    if (error) { showToast('Failed to load: ' + error.message, 'error'); return; }

    paysumData = (data || []).map(p => ({
        id: p.id,
        staff_name: p.staff ? `${p.staff.last_name}, ${p.staff.first_name}` : '(Unknown)',
        credential: p.staff?.credential || '',
        direct_hours: parseFloat(p.total_direct_hours),
        supervision_hours: parseFloat(p.total_supervision_hours),
        other_hours: parseFloat(p.total_other_hours),
        total_hours: parseFloat(p.total_hours),
        hourly_rate: parseFloat(p.hourly_rate),
        gross_pay: parseFloat(p.gross_pay),
        status: p.status
    }));

    const table = new DataTable('paysum-table', {
        columns: [
            { key: 'staff_name', label: 'Staff Member' },
            { key: 'credential', label: 'Credential', render: v => v || '—' },
            { key: 'direct_hours', label: 'Direct', type: 'number', align: 'text-center', render: v => v.toFixed(2) },
            { key: 'supervision_hours', label: 'Supervision', type: 'number', align: 'text-center', render: v => v.toFixed(2) },
            { key: 'other_hours', label: 'Other', type: 'number', align: 'text-center', render: v => v.toFixed(2) },
            { key: 'total_hours', label: 'Total Hrs', type: 'number', align: 'text-center', render: v => `<strong>${v.toFixed(2)}</strong>` },
            { key: 'hourly_rate', label: 'Rate', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'gross_pay', label: 'Gross Pay', type: 'number', align: 'text-right', render: v => `<strong>${formatCurrency(v)}</strong>` },
            { key: 'status', label: 'Status', render: v => statusBadge(v) }
        ],
        defaultSort: 'staff_name'
    });
    table.setData(paysumData);

    // Totals
    const totalHours = paysumData.reduce((s, r) => s + r.total_hours, 0);
    const totalPay = paysumData.reduce((s, r) => s + r.gross_pay, 0);
    document.getElementById('paysum-totals').innerHTML = `
        <div class="flex-between">
            <div><span class="text-sm text-muted">Staff: </span><strong>${paysumData.length}</strong></div>
            <div><span class="text-sm text-muted">Total Hours: </span><strong>${totalHours.toFixed(2)}</strong></div>
            <div><span class="text-sm text-muted">Total Gross Pay: </span><strong>${formatCurrency(totalPay)}</strong></div>
        </div>
    `;
}

// ============================================
// CSV EXPORT
// ============================================

function exportCSV(data, reportName) {
    if (!data || data.length === 0) {
        showToast('No data to export. Run the report first.', 'error');
        return;
    }

    const excluded = ['id'];
    const headers = Object.keys(data[0]).filter(k => !excluded.includes(k));
    const rows = data.map(row => headers.map(h => {
        const val = row[h];
        if (typeof val === 'number') return val;
        return String(val ?? '');
    }));

    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${reportName}_report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    showToast('Report exported.', 'success');
}

init();
