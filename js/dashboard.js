import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { formatCurrency, formatDate } from './ui.js';

async function init() {
    const auth = await requireAuth();
    if (!auth) return;
    renderNav();

    document.getElementById('current-date').textContent = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    await Promise.all([
        loadKPIs(),
        loadAgingChart(),
        loadRecentPayments(),
        loadHoursChart()
    ]);
}

async function loadKPIs() {
    // Outstanding claims
    const { data: outstanding } = await supabase
        .from('claims')
        .select('id, billed_amount, paid_amount')
        .in('status', ['submitted', 'partial', 'appealed']);

    if (outstanding) {
        const count = outstanding.length;
        const total = outstanding.reduce((sum, c) => sum + (parseFloat(c.billed_amount) - parseFloat(c.paid_amount || 0)), 0);
        document.getElementById('kpi-outstanding').textContent = count;
        document.getElementById('kpi-outstanding-sub').textContent = formatCurrency(total) + ' total';
    }

    // Payments this month
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStr = monthStart.toISOString().split('T')[0];

    const { data: payments } = await supabase
        .from('payments')
        .select('payment_amount')
        .gte('check_date', monthStr);

    if (payments) {
        const total = payments.reduce((sum, p) => sum + parseFloat(p.payment_amount || 0), 0);
        document.getElementById('kpi-payments').textContent = formatCurrency(total);
        document.getElementById('kpi-payments-sub').textContent = payments.length + ' payments';
    }

    // Denial rate (90 days)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const ninetyStr = ninetyDaysAgo.toISOString().split('T')[0];

    const { data: recentClaims } = await supabase
        .from('claims')
        .select('status')
        .gte('service_date', ninetyStr);

    if (recentClaims && recentClaims.length > 0) {
        const denied = recentClaims.filter(c => c.status === 'denied').length;
        const rate = ((denied / recentClaims.length) * 100).toFixed(1);
        document.getElementById('kpi-denials').textContent = rate + '%';
        document.getElementById('kpi-denials-sub').textContent = denied + ' of ' + recentClaims.length + ' claims';
    } else {
        document.getElementById('kpi-denials').textContent = '0%';
        document.getElementById('kpi-denials-sub').textContent = 'No claims in last 90 days';
    }

    // Payroll hours (current semi-monthly period)
    const now = new Date();
    const periodStart = now.getDate() <= 15
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getFullYear(), now.getMonth(), 16);
    const periodEnd = now.getDate() <= 15
        ? new Date(now.getFullYear(), now.getMonth(), 15)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const { data: sessions } = await supabase
        .from('sessions')
        .select('duration_hours')
        .eq('is_converted', true)
        .gte('session_date', periodStart.toISOString().split('T')[0])
        .lte('session_date', periodEnd.toISOString().split('T')[0]);

    if (sessions) {
        const totalHours = sessions.reduce((sum, s) => sum + parseFloat(s.duration_hours || 0), 0);
        document.getElementById('kpi-payroll').textContent = totalHours.toFixed(1);
        document.getElementById('kpi-payroll-sub').textContent = `${formatDate(periodStart.toISOString().split('T')[0])} – ${formatDate(periodEnd.toISOString().split('T')[0])}`;
    }
}

async function loadAgingChart() {
    const { data: claims } = await supabase
        .from('claims')
        .select('service_date, billed_amount, paid_amount')
        .in('status', ['submitted', 'partial', 'appealed']);

    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '120+': 0 };
    const today = new Date();

    if (claims) {
        for (const c of claims) {
            const days = Math.floor((today - new Date(c.service_date)) / (1000 * 60 * 60 * 24));
            const amt = parseFloat(c.billed_amount) - parseFloat(c.paid_amount || 0);
            if (days <= 30) buckets['0-30'] += amt;
            else if (days <= 60) buckets['31-60'] += amt;
            else if (days <= 90) buckets['61-90'] += amt;
            else if (days <= 120) buckets['91-120'] += amt;
            else buckets['120+'] += amt;
        }
    }

    const ctx = document.getElementById('aging-chart');
    if (!ctx) return;

    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Object.keys(buckets),
            datasets: [{
                label: 'Outstanding Amount',
                data: Object.values(buckets),
                backgroundColor: ['#3b82f6', '#60a5fa', '#f59e0b', '#f97316', '#ef4444']
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { callback: v => '$' + v.toLocaleString() }
                }
            }
        }
    });

    const total = Object.values(buckets).reduce((a, b) => a + b, 0);
    document.getElementById('aging-summary').textContent = total > 0
        ? `Total outstanding: ${formatCurrency(total)}`
        : 'No outstanding claims.';
}

async function loadRecentPayments() {
    const { data: payments } = await supabase
        .from('payments')
        .select(`
            id, check_number, check_date, payment_amount, payer_id,
            insurance_payers(name)
        `)
        .order('check_date', { ascending: false })
        .limit(8);

    const container = document.getElementById('recent-payments');
    if (!payments || payments.length === 0) {
        container.innerHTML = '<div class="empty-state"><p>No payments recorded yet.</p></div>';
        return;
    }

    let html = '<table class="data-table"><thead><tr><th>Date</th><th>Payer</th><th>Check #</th><th class="text-right">Amount</th></tr></thead><tbody>';
    for (const p of payments) {
        html += `<tr>
            <td>${formatDate(p.check_date)}</td>
            <td>${p.insurance_payers?.name || '—'}</td>
            <td class="text-mono">${p.check_number || '—'}</td>
            <td class="text-right">${formatCurrency(p.payment_amount)}</td>
        </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
}

async function loadHoursChart() {
    const now = new Date();
    const periodStart = now.getDate() <= 15
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getFullYear(), now.getMonth(), 16);
    const periodEnd = now.getDate() <= 15
        ? new Date(now.getFullYear(), now.getMonth(), 15)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const { data: sessions } = await supabase
        .from('sessions')
        .select(`
            staff_id, duration_hours, session_type, is_converted,
            staff(first_name, last_name)
        `)
        .eq('is_converted', true)
        .gte('session_date', periodStart.toISOString().split('T')[0])
        .lte('session_date', periodEnd.toISOString().split('T')[0]);

    const ctx = document.getElementById('hours-chart');
    if (!ctx) return;

    if (!sessions || sessions.length === 0) {
        new Chart(ctx, {
            type: 'bar',
            data: { labels: ['No data'], datasets: [{ data: [0] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
        return;
    }

    // Group by staff
    const staffHours = {};
    for (const s of sessions) {
        const name = s.staff ? `${s.staff.first_name} ${s.staff.last_name}` : s.staff_id;
        if (!staffHours[name]) staffHours[name] = { direct: 0, supervision: 0, other: 0 };
        const hours = parseFloat(s.duration_hours) || 0;
        if (s.session_type === 'direct') staffHours[name].direct += hours;
        else if (s.session_type === 'supervision') staffHours[name].supervision += hours;
        else staffHours[name].other += hours;
    }

    const labels = Object.keys(staffHours);

    new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'Direct', data: labels.map(l => staffHours[l].direct), backgroundColor: '#3b82f6' },
                { label: 'Supervision', data: labels.map(l => staffHours[l].supervision), backgroundColor: '#8b5cf6' },
                { label: 'Other', data: labels.map(l => staffHours[l].other), backgroundColor: '#d1d5db' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } },
            plugins: { legend: { position: 'bottom' } }
        }
    });
}

init();
