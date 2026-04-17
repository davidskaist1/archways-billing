import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, formatCurrency, formatDate, statusBadge } from './ui.js';

let agingChart, revenueChart, prodChart, kpiCollectionsChart, kpiDenialChart, denialCatChart, denialPayerChart, billerChart;
let agingData = [], revenueData = [], prodData = [], paysumData = [];
let denialData = [], billerData = [];

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

    // Default dates for new reports
    document.getElementById('kpi-from').value = agoStr;
    document.getElementById('kpi-to').value = nowStr;
    document.getElementById('denial-from').value = agoStr;
    document.getElementById('denial-to').value = nowStr;
    document.getElementById('biller-from').value = agoStr;
    document.getElementById('biller-to').value = nowStr;

    document.getElementById('aging-run-btn').addEventListener('click', runAgingReport);
    document.getElementById('aging-export-btn').addEventListener('click', () => exportCSV(agingData, 'aging'));
    document.getElementById('revenue-run-btn').addEventListener('click', runRevenueReport);
    document.getElementById('revenue-export-btn').addEventListener('click', () => exportCSV(revenueData, 'revenue'));
    document.getElementById('prod-run-btn').addEventListener('click', runProductivityReport);
    document.getElementById('prod-export-btn').addEventListener('click', () => exportCSV(prodData, 'productivity'));
    document.getElementById('paysum-run-btn').addEventListener('click', runPayrollSummary);
    document.getElementById('paysum-export-btn').addEventListener('click', () => exportCSV(paysumData, 'payroll'));

    document.getElementById('kpi-run-btn').addEventListener('click', runKPIDashboard);
    document.getElementById('denial-run-btn').addEventListener('click', runDenialAnalytics);
    document.getElementById('denial-export-btn').addEventListener('click', () => exportCSV(denialData, 'denials'));
    document.getElementById('biller-run-btn').addEventListener('click', runBillerProductivity);
    document.getElementById('biller-export-btn').addEventListener('click', () => exportCSV(billerData, 'biller_productivity'));

    await runKPIDashboard();
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

// ============================================
// KPI DASHBOARD
// ============================================

async function runKPIDashboard() {
    const from = document.getElementById('kpi-from').value;
    const to = document.getElementById('kpi-to').value;

    // Fetch claims in range
    let claimsQuery = supabase.from('claims').select('*');
    if (from) claimsQuery = claimsQuery.gte('service_date', from);
    if (to) claimsQuery = claimsQuery.lte('service_date', to);
    const { data: claims } = await claimsQuery;

    // Fetch write-offs in range
    const { data: writeoffs } = await supabase
        .from('write_offs')
        .select('amount, created_at')
        .gte('created_at', from || '2000-01-01');

    // Fetch denials
    const { data: denials } = await supabase
        .from('claim_denials')
        .select('claim_id')
        .gte('denial_date', from || '2000-01-01')
        .lte('denial_date', to || '2099-12-31');

    if (!claims) return;

    // Calculate metrics
    const totalBilled = claims.reduce((s, c) => s + parseFloat(c.billed_amount || 0), 0);
    const totalPaid = claims.reduce((s, c) => s + parseFloat(c.paid_amount || 0), 0);
    const totalAdjustments = claims.reduce((s, c) => s + parseFloat(c.adjustment_amount || 0), 0);
    const totalWriteOffs = (writeoffs || []).reduce((s, w) => s + parseFloat(w.amount || 0), 0);

    // Gross collection rate: payments / billed
    const gcr = totalBilled > 0 ? (totalPaid / totalBilled * 100) : 0;

    // Net collection rate: payments / (billed - contractual adjustments)
    const netBilled = totalBilled - totalAdjustments;
    const ncr = netBilled > 0 ? (totalPaid / netBilled * 100) : 0;

    // First-pass resolution
    const deniedClaimIds = new Set((denials || []).map(d => d.claim_id));
    const paidFirstPass = claims.filter(c => c.status === 'paid' && !deniedClaimIds.has(c.id)).length;
    const fpr = claims.length > 0 ? (paidFirstPass / claims.length * 100) : 0;

    // Denial rate
    const denialCount = claims.filter(c => c.status === 'denied').length;
    const denialRate = claims.length > 0 ? (denialCount / claims.length * 100) : 0;

    // Avg days in AR
    const paidClaims = claims.filter(c => c.status === 'paid' && c.date_paid);
    const totalDays = paidClaims.reduce((s, c) => {
        return s + Math.floor((new Date(c.date_paid) - new Date(c.service_date)) / (1000 * 60 * 60 * 24));
    }, 0);
    const avgDays = paidClaims.length > 0 ? (totalDays / paidClaims.length) : 0;

    // Update KPI cards
    document.getElementById('kpi-gcr').textContent = gcr.toFixed(1) + '%';
    document.getElementById('kpi-ncr').textContent = ncr.toFixed(1) + '%';
    document.getElementById('kpi-fpr').textContent = fpr.toFixed(1) + '%';
    document.getElementById('kpi-denial-rate').textContent = denialRate.toFixed(1) + '%';
    document.getElementById('kpi-ar-days').textContent = Math.round(avgDays) + 'd';
    document.getElementById('kpi-writeoffs').textContent = formatCurrency(totalWriteOffs);
    document.getElementById('kpi-total-billed').textContent = formatCurrency(totalBilled);
    document.getElementById('kpi-total-paid').textContent = formatCurrency(totalPaid);

    // Build monthly trend charts
    const monthly = {};
    for (const c of claims) {
        const month = c.service_date.slice(0, 7);
        if (!monthly[month]) monthly[month] = { billed: 0, paid: 0, count: 0, denied: 0 };
        monthly[month].billed += parseFloat(c.billed_amount || 0);
        monthly[month].paid += parseFloat(c.paid_amount || 0);
        monthly[month].count++;
        if (c.status === 'denied') monthly[month].denied++;
    }

    const monthLabels = Object.keys(monthly).sort();

    // Collections chart
    const collCtx = document.getElementById('kpi-collections-chart');
    if (kpiCollectionsChart) kpiCollectionsChart.destroy();
    kpiCollectionsChart = new Chart(collCtx, {
        type: 'line',
        data: {
            labels: monthLabels,
            datasets: [
                { label: 'Billed', data: monthLabels.map(m => monthly[m].billed), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3 },
                { label: 'Collected', data: monthLabels.map(m => monthly[m].paid), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3 }
            ]
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } } },
            plugins: { legend: { position: 'bottom' } }
        }
    });

    // Denial rate chart
    const denCtx = document.getElementById('kpi-denial-chart');
    if (kpiDenialChart) kpiDenialChart.destroy();
    kpiDenialChart = new Chart(denCtx, {
        type: 'bar',
        data: {
            labels: monthLabels,
            datasets: [{
                label: 'Denial Rate %',
                data: monthLabels.map(m => monthly[m].count > 0 ? (monthly[m].denied / monthly[m].count * 100).toFixed(1) : 0),
                backgroundColor: '#ef4444'
            }]
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } },
            plugins: { legend: { display: false } }
        }
    });
}

// ============================================
// DENIAL ANALYTICS
// ============================================

async function runDenialAnalytics() {
    const from = document.getElementById('denial-from').value;
    const to = document.getElementById('denial-to').value;

    let query = supabase
        .from('claim_denials')
        .select(`
            *,
            claims(billed_amount, payer_id, insurance_payers(name))
        `);

    if (from) query = query.gte('denial_date', from);
    if (to) query = query.lte('denial_date', to);

    const { data } = await query;

    // Group by category
    const byCategory = {};
    const byPayer = {};

    for (const d of (data || [])) {
        const amt = parseFloat(d.denied_amount || d.claims?.billed_amount || 0);
        byCategory[d.denial_category] = (byCategory[d.denial_category] || 0) + amt;
        const payerName = d.claims?.insurance_payers?.name || '(Unknown)';
        byPayer[payerName] = (byPayer[payerName] || 0) + amt;
    }

    denialData = Object.entries(byCategory).map(([cat, amount]) => ({
        id: cat,
        category: cat.replace('_', ' '),
        count: (data || []).filter(d => d.denial_category === cat).length,
        total_amount: amount,
        avg_amount: ((data || []).filter(d => d.denial_category === cat).length) > 0
            ? amount / (data || []).filter(d => d.denial_category === cat).length
            : 0,
        resolved: (data || []).filter(d => d.denial_category === cat && d.status === 'resolved').length
    })).sort((a, b) => b.total_amount - a.total_amount);

    const colors = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b', '#78716c'];

    // Category chart
    const catCtx = document.getElementById('denial-cat-chart');
    if (denialCatChart) denialCatChart.destroy();
    denialCatChart = new Chart(catCtx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(byCategory).map(c => c.replace('_', ' ')),
            datasets: [{ data: Object.values(byCategory), backgroundColor: colors }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { position: 'bottom', labels: { font: { size: 11 } } },
                tooltip: { callbacks: { label: ctx => ctx.label + ': ' + formatCurrency(ctx.raw) } }
            }
        }
    });

    // Payer chart
    const payCtx = document.getElementById('denial-payer-chart');
    if (denialPayerChart) denialPayerChart.destroy();
    denialPayerChart = new Chart(payCtx, {
        type: 'bar',
        data: {
            labels: Object.keys(byPayer),
            datasets: [{ label: 'Denied $', data: Object.values(byPayer), backgroundColor: '#ef4444' }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            scales: { x: { ticks: { callback: v => '$' + v.toLocaleString() } } },
            plugins: { legend: { display: false } }
        }
    });

    // Table
    const table = new DataTable('denial-analytics-table', {
        columns: [
            { key: 'category', label: 'Category' },
            { key: 'count', label: 'Count', type: 'number', align: 'text-center' },
            { key: 'total_amount', label: 'Total $ Denied', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'avg_amount', label: 'Avg $ per Denial', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'resolved', label: 'Resolved', type: 'number', align: 'text-center' },
            { key: 'resolution_rate', label: 'Res. Rate', align: 'text-center', render: (_, r) => {
                const rate = r.count > 0 ? (r.resolved / r.count * 100).toFixed(0) : 0;
                return rate + '%';
            }}
        ],
        defaultSort: 'total_amount',
        defaultSortDir: 'desc'
    });
    table.setData(denialData);
}

// ============================================
// CASH PROJECTION
// ============================================

async function runCashProjection() {
    // Get all open claims
    const { data: claims } = await supabase
        .from('claims')
        .select('*, insurance_payers(name)')
        .in('status', ['submitted', 'partial', 'appealed']);

    if (!claims) return;

    // Get historical paid claims to calculate collection rate per payer
    const { data: paidClaims } = await supabase
        .from('claims')
        .select('payer_id, billed_amount, paid_amount, status')
        .in('status', ['paid', 'partial', 'denied', 'void'])
        .limit(2000);

    // Calculate collection rate per payer
    const payerRates = {};
    for (const c of (paidClaims || [])) {
        if (!payerRates[c.payer_id]) payerRates[c.payer_id] = { billed: 0, paid: 0 };
        payerRates[c.payer_id].billed += parseFloat(c.billed_amount || 0);
        payerRates[c.payer_id].paid += parseFloat(c.paid_amount || 0);
    }

    // Default collection rate if no history
    const defaultRate = 0.75;

    // Bucket claims by age
    const today = new Date();
    const projections = { '30': 0, '60': 0, '90': 0, 'risk': 0 };
    const byPayer = {};

    for (const c of claims) {
        const age = Math.floor((today - new Date(c.service_date)) / (1000 * 60 * 60 * 24));
        const outstanding = parseFloat(c.billed_amount) - parseFloat(c.paid_amount || 0);
        const rate = payerRates[c.payer_id]?.billed > 0
            ? payerRates[c.payer_id].paid / payerRates[c.payer_id].billed
            : defaultRate;
        const expectedCollection = outstanding * rate;

        const payerName = c.insurance_payers?.name || '(Unknown)';
        if (!byPayer[payerName]) byPayer[payerName] = { outstanding: 0, projected: 0, rate: rate, count: 0 };
        byPayer[payerName].outstanding += outstanding;
        byPayer[payerName].projected += expectedCollection;
        byPayer[payerName].count++;

        if (age <= 30) projections['30'] += expectedCollection;
        else if (age <= 60) projections['60'] += expectedCollection;
        else if (age <= 90) projections['90'] += expectedCollection;
        else projections['risk'] += expectedCollection;
    }

    document.getElementById('cash-30').textContent = formatCurrency(projections['30']);
    document.getElementById('cash-60').textContent = formatCurrency(projections['60']);
    document.getElementById('cash-90').textContent = formatCurrency(projections['90']);
    document.getElementById('cash-risk').textContent = formatCurrency(projections['risk']);

    // Table
    const cashTableData = Object.entries(byPayer).map(([name, d]) => ({
        id: name,
        payer_name: name,
        claim_count: d.count,
        outstanding: d.outstanding,
        projected: d.projected,
        collection_rate: d.rate,
        at_risk: d.outstanding - d.projected
    })).sort((a, b) => b.outstanding - a.outstanding);

    const table = new DataTable('cash-table', {
        columns: [
            { key: 'payer_name', label: 'Payer' },
            { key: 'claim_count', label: 'Open Claims', type: 'number', align: 'text-center' },
            { key: 'outstanding', label: 'Outstanding', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'collection_rate', label: 'Historical Rate', align: 'text-center', render: v => (v * 100).toFixed(1) + '%' },
            { key: 'projected', label: 'Projected Collection', type: 'number', align: 'text-right', render: v => `<strong class="text-success">${formatCurrency(v)}</strong>` },
            { key: 'at_risk', label: 'At Risk', type: 'number', align: 'text-right', render: v => `<span class="text-danger">${formatCurrency(v)}</span>` }
        ],
        defaultSort: 'outstanding',
        defaultSortDir: 'desc'
    });
    table.setData(cashTableData);
}

// ============================================
// BILLER PRODUCTIVITY
// ============================================

async function runBillerProductivity() {
    const from = document.getElementById('biller-from').value;
    const to = document.getElementById('biller-to').value;

    let query = supabase
        .from('claim_activities')
        .select(`
            *,
            app_users(first_name, last_name)
        `);

    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to + 'T23:59:59');

    const { data } = await query;

    // Group by biller
    const byBiller = {};
    for (const a of (data || [])) {
        const userId = a.user_id;
        const name = a.app_users ? `${a.app_users.first_name} ${a.app_users.last_name}` : 'Unknown';
        if (!byBiller[userId]) {
            byBiller[userId] = {
                id: userId,
                biller_name: name,
                total_actions: 0,
                claims_touched: new Set(),
                calls: 0,
                notes: 0,
                appeals: 0,
                resubmits: 0,
                followups: 0,
                denials_logged: 0,
                write_offs: 0
            };
        }
        const b = byBiller[userId];
        b.total_actions++;
        b.claims_touched.add(a.claim_id);
        if (a.action_type === 'called') b.calls++;
        else if (a.action_type === 'note') b.notes++;
        else if (a.action_type === 'appealed') b.appeals++;
        else if (a.action_type === 'resubmitted') b.resubmits++;
        else if (a.action_type === 'followup_scheduled') b.followups++;
        else if (a.action_type === 'denial_logged') b.denials_logged++;
        else if (a.action_type === 'write_off') b.write_offs++;
    }

    billerData = Object.values(byBiller).map(b => ({
        ...b,
        unique_claims: b.claims_touched.size
    })).sort((a, b) => b.total_actions - a.total_actions);

    // Chart
    const ctx = document.getElementById('biller-chart');
    if (billerChart) billerChart.destroy();
    billerChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: billerData.map(b => b.biller_name),
            datasets: [
                { label: 'Calls', data: billerData.map(b => b.calls), backgroundColor: '#3b82f6' },
                { label: 'Notes', data: billerData.map(b => b.notes), backgroundColor: '#8b5cf6' },
                { label: 'Appeals', data: billerData.map(b => b.appeals), backgroundColor: '#f59e0b' },
                { label: 'Resubmits', data: billerData.map(b => b.resubmits), backgroundColor: '#10b981' }
            ]
        },
        options: {
            responsive: true,
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
            plugins: { legend: { position: 'bottom' } }
        }
    });

    // Table
    const table = new DataTable('biller-table', {
        columns: [
            { key: 'biller_name', label: 'Biller' },
            { key: 'total_actions', label: 'Total Actions', type: 'number', align: 'text-center' },
            { key: 'unique_claims', label: 'Unique Claims', type: 'number', align: 'text-center' },
            { key: 'calls', label: 'Calls', type: 'number', align: 'text-center' },
            { key: 'notes', label: 'Notes', type: 'number', align: 'text-center' },
            { key: 'appeals', label: 'Appeals', type: 'number', align: 'text-center' },
            { key: 'resubmits', label: 'Resubmits', type: 'number', align: 'text-center' },
            { key: 'denials_logged', label: 'Denials', type: 'number', align: 'text-center' },
            { key: 'write_offs', label: 'Write-offs', type: 'number', align: 'text-center' }
        ],
        defaultSort: 'total_actions',
        defaultSortDir: 'desc'
    });
    table.setData(billerData);
}

// Also wire up cash projection to run when tab opens
const origSetupTabs = setupTabs;
function setupTabsExtended() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.tab === 'cash-projection') runCashProjection();
        });
    });
}

// Hook after init
setTimeout(setupTabsExtended, 100);

init();
