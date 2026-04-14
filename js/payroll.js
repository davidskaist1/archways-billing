import { requireAuth, hasRole, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, formatCurrency, formatDate, statusBadge } from './ui.js';
import { createImportUI } from './import.js';

let sessionsTable, payrollTable;
let staffList = [];
let payrollData = [];

async function init() {
    const auth = await requireAuth(['admin', 'payroll']);
    if (!auth) return;
    renderNav();

    // Load staff for dropdown
    const { data: staffData } = await supabase
        .from('staff')
        .select('id, first_name, last_name, credential, hourly_rate')
        .eq('is_active', true)
        .order('last_name');
    staffList = staffData || [];

    const staffSelect = document.getElementById('sessions-staff');
    for (const s of staffList) {
        staffSelect.innerHTML += `<option value="${s.id}">${s.last_name}, ${s.first_name}</option>`;
    }

    setupTabs();
    setupSessionsTable();
    setupPayrollCalc();
    setupImport();

    // Default date range: current semi-monthly period
    const now = new Date();
    const periodStart = now.getDate() <= 15
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getFullYear(), now.getMonth(), 16);
    const periodEnd = now.getDate() <= 15
        ? new Date(now.getFullYear(), now.getMonth(), 15)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0);

    document.getElementById('sessions-date-from').value = periodStart.toISOString().split('T')[0];
    document.getElementById('sessions-date-to').value = periodEnd.toISOString().split('T')[0];
    document.getElementById('payroll-start').value = periodStart.toISOString().split('T')[0];
    document.getElementById('payroll-end').value = periodEnd.toISOString().split('T')[0];

    await loadSessions();
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
// SESSIONS
// ============================================

function setupSessionsTable() {
    sessionsTable = new DataTable('sessions-table', {
        columns: [
            { key: 'session_date', label: 'Date', type: 'date', render: v => formatDate(v) },
            { key: 'staff_name', label: 'Staff' },
            { key: 'client_name', label: 'Client' },
            { key: 'start_time', label: 'Start', render: v => v || '—' },
            { key: 'end_time', label: 'End', render: v => v || '—' },
            { key: 'duration_hours', label: 'Hours', type: 'number', align: 'text-center', render: v => parseFloat(v).toFixed(2) },
            { key: 'session_type', label: 'Type', render: v => {
                const labels = { direct: 'Direct', supervision: 'Supervision', assessment: 'Assessment', parent_training: 'Parent Training', other: 'Other' };
                return labels[v] || v;
            }},
            { key: 'cpt_code', label: 'CPT', className: 'text-mono', render: v => v || '—' },
            { key: 'is_converted', label: 'Converted', render: v => v ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-secondary">No</span>' }
        ],
        defaultSort: 'session_date',
        defaultSortDir: 'desc',
        emptyMessage: 'No sessions found.'
    });

    document.getElementById('sessions-filter-btn').addEventListener('click', loadSessions);
}

async function loadSessions() {
    let query = supabase
        .from('sessions')
        .select('*, staff(first_name, last_name), clients(first_name, last_name)')
        .order('session_date', { ascending: false });

    const from = document.getElementById('sessions-date-from').value;
    const to = document.getElementById('sessions-date-to').value;
    const staffId = document.getElementById('sessions-staff').value;
    const type = document.getElementById('sessions-type').value;
    const convertedOnly = document.getElementById('sessions-converted-only').checked;

    if (from) query = query.gte('session_date', from);
    if (to) query = query.lte('session_date', to);
    if (staffId) query = query.eq('staff_id', staffId);
    if (type) query = query.eq('session_type', type);
    if (convertedOnly) query = query.eq('is_converted', true);

    const { data, error } = await query;
    if (error) { showToast('Failed to load sessions: ' + error.message, 'error'); return; }

    const sessions = (data || []).map(s => ({
        ...s,
        staff_name: s.staff ? `${s.staff.last_name}, ${s.staff.first_name}` : '(Unknown)',
        client_name: s.clients ? `${s.clients.last_name}, ${s.clients.first_name}` : '(Unknown)'
    }));

    sessionsTable.setData(sessions);
}

// ============================================
// CALCULATE PAYROLL
// ============================================

function setupPayrollCalc() {
    payrollTable = new DataTable('payroll-table', {
        columns: [
            { key: 'staff_name', label: 'Staff Member' },
            { key: 'credential', label: 'Credential', render: v => v || '—' },
            { key: 'direct_hours', label: 'Direct Hrs', type: 'number', align: 'text-center', render: v => v.toFixed(2) },
            { key: 'supervision_hours', label: 'Supervision Hrs', type: 'number', align: 'text-center', render: v => v.toFixed(2) },
            { key: 'other_hours', label: 'Other Hrs', type: 'number', align: 'text-center', render: v => v.toFixed(2) },
            { key: 'total_hours', label: 'Total Hrs', type: 'number', align: 'text-center', render: v => `<strong>${v.toFixed(2)}</strong>` },
            { key: 'hourly_rate', label: 'Rate', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'gross_pay', label: 'Gross Pay', type: 'number', align: 'text-right', render: v => `<strong>${formatCurrency(v)}</strong>` },
            { key: 'status', label: 'Status', render: v => statusBadge(v) }
        ],
        defaultSort: 'staff_name',
        emptyMessage: 'Click "Calculate Payroll" to generate results.'
    });

    document.getElementById('calculate-btn').addEventListener('click', calculatePayroll);
    document.getElementById('export-payroll-btn').addEventListener('click', exportPayrollCSV);
    document.getElementById('approve-payroll-btn').addEventListener('click', approveAll);

    if (hasRole('admin')) {
        document.getElementById('approve-payroll-btn').style.display = 'inline-flex';
    }
}

async function calculatePayroll() {
    const start = document.getElementById('payroll-start').value;
    const end = document.getElementById('payroll-end').value;

    if (!start || !end) {
        showToast('Select a pay period date range.', 'error');
        return;
    }

    const btn = document.getElementById('calculate-btn');
    btn.disabled = true;
    btn.textContent = 'Calculating...';

    try {
        // Get converted sessions in date range
        const { data: sessions, error } = await supabase
            .from('sessions')
            .select('staff_id, duration_hours, session_type')
            .eq('is_converted', true)
            .gte('session_date', start)
            .lte('session_date', end);

        if (error) throw error;

        // Check for existing payroll periods
        const { data: existing } = await supabase
            .from('payroll_periods')
            .select('*')
            .gte('period_start', start)
            .lte('period_end', end);

        const existingMap = {};
        if (existing) {
            for (const e of existing) {
                existingMap[e.staff_id] = e;
            }
        }

        // Group by staff
        const staffHours = {};
        for (const s of (sessions || [])) {
            if (!staffHours[s.staff_id]) {
                staffHours[s.staff_id] = { direct: 0, supervision: 0, other: 0 };
            }
            const hours = parseFloat(s.duration_hours) || 0;
            if (s.session_type === 'direct') staffHours[s.staff_id].direct += hours;
            else if (s.session_type === 'supervision') staffHours[s.staff_id].supervision += hours;
            else staffHours[s.staff_id].other += hours;
        }

        // Build payroll rows
        payrollData = [];
        for (const staff of staffList) {
            const hours = staffHours[staff.id] || { direct: 0, supervision: 0, other: 0 };
            const totalHours = hours.direct + hours.supervision + hours.other;
            const rate = parseFloat(staff.hourly_rate) || 0;
            const existingRecord = existingMap[staff.id];

            if (totalHours === 0 && !existingRecord) continue;

            payrollData.push({
                id: existingRecord?.id || staff.id,
                staff_id: staff.id,
                staff_name: `${staff.last_name}, ${staff.first_name}`,
                credential: staff.credential,
                direct_hours: hours.direct,
                supervision_hours: hours.supervision,
                other_hours: hours.other,
                total_hours: totalHours,
                hourly_rate: rate,
                gross_pay: totalHours * rate,
                status: existingRecord?.status || 'draft',
                existing_id: existingRecord?.id || null
            });
        }

        // Show results
        document.getElementById('payroll-results').style.display = 'block';
        document.getElementById('payroll-period-label').textContent =
            `${formatDate(start)} – ${formatDate(end)}`;

        payrollTable.setData(payrollData);

        // Totals
        const totalHours = payrollData.reduce((sum, r) => sum + r.total_hours, 0);
        const totalPay = payrollData.reduce((sum, r) => sum + r.gross_pay, 0);
        document.getElementById('payroll-totals').innerHTML = `
            <div class="flex-between">
                <div>
                    <span class="text-sm text-muted">Total Staff: </span>
                    <strong>${payrollData.length}</strong>
                </div>
                <div>
                    <span class="text-sm text-muted">Total Hours: </span>
                    <strong>${totalHours.toFixed(2)}</strong>
                </div>
                <div>
                    <span class="text-sm text-muted">Total Gross Pay: </span>
                    <strong class="font-bold">${formatCurrency(totalPay)}</strong>
                </div>
            </div>
        `;

        // Save/update payroll periods in Supabase
        for (const row of payrollData) {
            const record = {
                staff_id: row.staff_id,
                period_start: start,
                period_end: end,
                total_direct_hours: row.direct_hours,
                total_supervision_hours: row.supervision_hours,
                total_other_hours: row.other_hours,
                total_hours: row.total_hours,
                hourly_rate: row.hourly_rate,
                gross_pay: row.gross_pay
            };

            if (row.existing_id) {
                await supabase.from('payroll_periods').update(record).eq('id', row.existing_id);
            } else {
                await supabase.from('payroll_periods').insert({ ...record, status: 'draft' });
            }
        }

        showToast('Payroll calculated and saved.', 'success');
    } catch (err) {
        showToast('Calculation failed: ' + err.message, 'error');
    }

    btn.disabled = false;
    btn.textContent = 'Calculate Payroll';
}

async function approveAll() {
    const start = document.getElementById('payroll-start').value;
    const end = document.getElementById('payroll-end').value;
    const currentStaff = getCurrentStaff();

    const { error } = await supabase
        .from('payroll_periods')
        .update({
            status: 'approved',
            approved_by: currentStaff.id,
            approved_at: new Date().toISOString()
        })
        .eq('period_start', start)
        .eq('period_end', end)
        .eq('status', 'draft');

    if (error) {
        showToast('Failed to approve: ' + error.message, 'error');
        return;
    }

    showToast('Payroll approved.', 'success');

    // Refresh
    payrollData = payrollData.map(r => ({ ...r, status: r.status === 'draft' ? 'approved' : r.status }));
    payrollTable.setData(payrollData);
}

function exportPayrollCSV() {
    if (payrollData.length === 0) {
        showToast('No payroll data to export.', 'error');
        return;
    }

    const start = document.getElementById('payroll-start').value;
    const end = document.getElementById('payroll-end').value;

    const headers = ['Staff Name', 'Credential', 'Direct Hours', 'Supervision Hours', 'Other Hours', 'Total Hours', 'Hourly Rate', 'Gross Pay', 'Status'];
    const rows = payrollData.map(r => [
        r.staff_name,
        r.credential || '',
        r.direct_hours.toFixed(2),
        r.supervision_hours.toFixed(2),
        r.other_hours.toFixed(2),
        r.total_hours.toFixed(2),
        r.hourly_rate.toFixed(2),
        r.gross_pay.toFixed(2),
        r.status
    ]);

    // Add totals row
    const totalHours = payrollData.reduce((s, r) => s + r.total_hours, 0);
    const totalPay = payrollData.reduce((s, r) => s + r.gross_pay, 0);
    rows.push(['TOTAL', '', '', '', '', totalHours.toFixed(2), '', totalPay.toFixed(2), '']);

    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll_${start}_to_${end}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    showToast('Payroll CSV exported.', 'success');

    // Mark as exported
    supabase
        .from('payroll_periods')
        .update({ status: 'exported' })
        .eq('period_start', start)
        .eq('period_end', end)
        .in('status', ['draft', 'approved'])
        .then(() => {
            payrollData = payrollData.map(r => ({ ...r, status: 'exported' }));
            payrollTable.setData(payrollData);
        });
}

// ============================================
// IMPORT
// ============================================

function setupImport() {
    createImportUI('import-sessions-zone', 'sessions', () => {
        showToast('Sessions imported. Switch to the Sessions tab to view.', 'success');
    });
}

init();
