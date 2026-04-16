import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, formatCurrency, formatDate, statusBadge, createModal, openModal, closeModal } from './ui.js';

let eraTable, ackTable, syncLogTable;

async function init() {
    const auth = await requireAuth(['admin', 'billing']);
    if (!auth) return;
    renderNav();

    setupTabs();
    setupTables();
    setupSyncButton();
    setupTestUpload();

    await checkStatus();
    await loadKPIs();
    await loadERAs();
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');

            if (btn.dataset.tab === 'acks') loadAcks();
            if (btn.dataset.tab === 'sync-log') loadSyncLog();
        });
    });
}

function setupTables() {
    eraTable = new DataTable('era-table', {
        columns: [
            { key: 'check_date', label: 'Check Date', type: 'date', render: v => formatDate(v) },
            { key: 'payer_name', label: 'Payer', render: v => v || '—' },
            { key: 'check_number', label: 'Check/EFT #', className: 'text-mono' },
            { key: 'payment_method', label: 'Method', render: v => v || '—' },
            { key: 'total_paid', label: 'Total', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'claims_in_file', label: 'Claims', type: 'number', align: 'text-center' },
            { key: 'claims_matched', label: 'Matched', type: 'number', align: 'text-center', render: (v, r) => {
                const total = r.claims_in_file || 0;
                if (total === 0) return '—';
                const pct = Math.round((v / total) * 100);
                const cls = pct === 100 ? 'text-success' : pct > 0 ? 'text-warning' : 'text-danger';
                return `<span class="${cls}">${v}/${total}</span>`;
            }},
            { key: 'status', label: 'Status', render: v => {
                const map = { matched: 'badge-success', parsed: 'badge-info', error: 'badge-danger', pending: 'badge-secondary' };
                return `<span class="badge ${map[v] || 'badge-secondary'}">${v}</span>`;
            }},
            { key: 'created_at', label: 'Received', type: 'date', render: v => formatDate(v?.split('T')[0]) }
        ],
        defaultSort: 'created_at',
        defaultSortDir: 'desc',
        onRowClick: openEraDetail,
        emptyMessage: 'No ERA files received yet.'
    });

    ackTable = new DataTable('ack-table', {
        columns: [
            { key: 'ack_date', label: 'Date', type: 'date', render: v => formatDate(v) },
            { key: 'cr_claim_id', label: 'Claim ID', className: 'text-mono' },
            { key: 'status_description', label: 'Status' },
            { key: 'status_category', label: 'Category', render: v => {
                if (['A2', 'F0', 'F1'].includes(v)) return `<span class="badge badge-success">${v}</span>`;
                if (['A0', 'A3', 'A6', 'A7', 'A8', 'F2'].includes(v)) return `<span class="badge badge-danger">${v}</span>`;
                if (v?.startsWith('P')) return `<span class="badge badge-warning">${v}</span>`;
                return `<span class="badge badge-secondary">${v || '—'}</span>`;
            }},
            { key: 'payer_claim_id', label: 'Payer Claim ID', className: 'text-mono', render: v => v || '—' },
            { key: 'file_name', label: 'Source File', className: 'text-mono text-xs' }
        ],
        defaultSort: 'ack_date',
        defaultSortDir: 'desc',
        emptyMessage: 'No claim acknowledgments received yet.'
    });

    syncLogTable = new DataTable('sync-log-table', {
        columns: [
            { key: 'started_at', label: 'Started', type: 'date', render: v => new Date(v).toLocaleString() },
            { key: 'sync_type', label: 'Type' },
            { key: 'triggered_by', label: 'Trigger' },
            { key: 'status', label: 'Status', render: v => {
                const map = { success: 'badge-success', error: 'badge-danger', partial: 'badge-warning', running: 'badge-info' };
                return `<span class="badge ${map[v] || 'badge-secondary'}">${v}</span>`;
            }},
            { key: 'files_processed', label: 'Files', type: 'number', align: 'text-center', render: (v, r) => `${v}/${r.files_found || 0}` },
            { key: 'payments_created', label: 'Payments', type: 'number', align: 'text-center' },
            { key: 'claims_matched', label: 'Matched', type: 'number', align: 'text-center' },
            { key: 'acknowledgments_created', label: 'Acks', type: 'number', align: 'text-center' },
            { key: 'duration', label: 'Duration', render: (_, r) => {
                if (!r.completed_at) return '—';
                const ms = new Date(r.completed_at) - new Date(r.started_at);
                return `${(ms / 1000).toFixed(1)}s`;
            }}
        ],
        defaultSort: 'started_at',
        defaultSortDir: 'desc',
        emptyMessage: 'No sync attempts yet.',
        onRowClick: (row) => {
            if (row.error_message || row.details) {
                const details = row.details?.errors?.length > 0 ? row.details.errors.join('\n') : '';
                alert(`Sync ${row.status}\n\n${row.error_message || ''}\n\n${details}`);
            }
        }
    });
}

async function checkStatus() {
    // Ping the manual sync endpoint with GET to check if SFTP is configured
    try {
        const res = await fetch('/.netlify/functions/sync-office-ally-manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dry_run: true })
        });
        const result = await res.json();

        const banner = document.getElementById('status-banner');
        if (result.status === 'not_configured') {
            banner.style.display = 'block';
            banner.style.background = 'var(--color-warning-light)';
            banner.style.borderColor = 'var(--color-warning)';
            banner.innerHTML = `
                <div class="flex gap-2">
                    <div>
                        <strong>Office Ally SFTP is not configured yet.</strong>
                        <p class="text-sm text-muted mt-1">
                            Once your Office Ally account is active, add these environment variables in Netlify:
                            <code>OFFICE_ALLY_SFTP_HOST</code>, <code>OFFICE_ALLY_SFTP_USER</code>,
                            <code>OFFICE_ALLY_SFTP_PASSWORD</code>.
                            Use the "Test Upload" tab in the meantime to parse sample files.
                        </p>
                    </div>
                </div>
            `;
            document.getElementById('sync-now-btn').disabled = true;
        }
    } catch (err) {
        // Network error, ignore
    }
}

async function loadKPIs() {
    // Last sync
    const { data: lastSync } = await supabase
        .from('sync_logs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(1);

    if (lastSync && lastSync.length > 0) {
        const s = lastSync[0];
        const date = new Date(s.started_at);
        const diffMs = Date.now() - date.getTime();
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);

        let relativeTime;
        if (diffDays > 0) relativeTime = `${diffDays}d ago`;
        else if (diffHours > 0) relativeTime = `${diffHours}h ago`;
        else relativeTime = `${Math.max(1, Math.floor(diffMs / 60000))}m ago`;

        document.getElementById('kpi-last-sync').textContent = relativeTime;
        document.getElementById('kpi-last-sync-sub').textContent = date.toLocaleString();
    } else {
        document.getElementById('kpi-last-sync').textContent = 'Never';
    }

    // ERAs this month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { data: erasMonth } = await supabase
        .from('era_files')
        .select('id, total_paid')
        .gte('created_at', monthStart.toISOString());

    if (erasMonth) {
        const count = erasMonth.length;
        const total = erasMonth.reduce((sum, e) => sum + (parseFloat(e.total_paid) || 0), 0);
        document.getElementById('kpi-eras-month').textContent = count;
        document.getElementById('kpi-eras-month-sub').textContent = formatCurrency(total) + ' total';
    }

    // Total payments received (all time, from ERAs)
    const { data: allEras } = await supabase
        .from('era_files')
        .select('total_paid')
        .eq('source', 'office_ally');

    if (allEras) {
        const total = allEras.reduce((sum, e) => sum + (parseFloat(e.total_paid) || 0), 0);
        document.getElementById('kpi-total-payments').textContent = formatCurrency(total);
        document.getElementById('kpi-total-payments-sub').textContent = allEras.length + ' ERAs';
    }

    // Pending acks — claims submitted but no payment yet and no A2 ack
    const { data: pendingCount } = await supabase
        .from('claims')
        .select('id', { count: 'exact', head: true })
        .in('status', ['submitted', 'appealed']);

    if (pendingCount !== null) {
        document.getElementById('kpi-pending-acks').textContent = pendingCount.count || 0;
    }
}

async function loadERAs() {
    const { data, error } = await supabase
        .from('era_files')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        showToast('Failed to load ERAs: ' + error.message, 'error');
        return;
    }

    eraTable.setData(data || []);
}

async function loadAcks() {
    const { data, error } = await supabase
        .from('claim_acknowledgments')
        .select('*')
        .order('ack_date', { ascending: false })
        .limit(200);

    if (error) {
        showToast('Failed to load acknowledgments: ' + error.message, 'error');
        return;
    }

    ackTable.setData(data || []);
}

async function loadSyncLog() {
    const { data, error } = await supabase
        .from('sync_logs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(50);

    if (error) {
        showToast('Failed to load sync log: ' + error.message, 'error');
        return;
    }

    syncLogTable.setData(data || []);
}

function openEraDetail(era) {
    const paymentMethod = {
        'CHK': 'Paper Check',
        'ACH': 'ACH Direct Deposit',
        'NON': 'Non-Payment',
        'BOP': 'Financial Institution Option',
        'FWT': 'Federal Reserve Wire Transfer'
    }[era.payment_method] || era.payment_method || '—';

    const bodyHTML = `
        <div class="grid-2 gap-2">
            <div>
                <label class="form-label">Check/EFT Number</label>
                <p class="font-mono">${era.check_number || '—'}</p>
            </div>
            <div>
                <label class="form-label">Check Date</label>
                <p>${formatDate(era.check_date)}</p>
            </div>
            <div>
                <label class="form-label">Total Paid</label>
                <p class="font-bold text-success">${formatCurrency(era.total_paid)}</p>
            </div>
            <div>
                <label class="form-label">Payment Method</label>
                <p>${paymentMethod}</p>
            </div>
            <div>
                <label class="form-label">Payer</label>
                <p>${era.payer_name || '—'}</p>
            </div>
            <div>
                <label class="form-label">Payer ID</label>
                <p class="font-mono">${era.payer_id_number || '—'}</p>
            </div>
            <div>
                <label class="form-label">Payee</label>
                <p>${era.payee_name || '—'}</p>
            </div>
            <div>
                <label class="form-label">Payee NPI</label>
                <p class="font-mono">${era.payee_npi || '—'}</p>
            </div>
        </div>
        <hr style="border:none;border-top:1px solid var(--color-border);margin:16px 0;">
        <div class="flex-between">
            <div>
                <span class="text-sm text-muted">Claims in file: </span><strong>${era.claims_in_file || 0}</strong>
                &nbsp;&nbsp;
                <span class="text-sm text-muted">Matched: </span><strong>${era.claims_matched || 0}</strong>
            </div>
            <div>
                <span class="text-sm text-muted">File: </span><code>${era.file_name}</code>
            </div>
        </div>
    `;

    createModal('era-modal', 'ERA Detail', bodyHTML, `<button class="btn btn-secondary" id="era-close">Close</button>`, 'modal-lg');
    openModal('era-modal');
    document.getElementById('era-close').addEventListener('click', () => closeModal('era-modal'));
}

function setupSyncButton() {
    document.getElementById('sync-now-btn').addEventListener('click', async () => {
        const btn = document.getElementById('sync-now-btn');
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;"></div> Syncing...';

        try {
            const res = await fetch('/.netlify/functions/sync-office-ally-manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const result = await res.json();

            if (result.status === 'not_configured') {
                showToast(result.message, 'warning', 8000);
            } else if (res.ok) {
                showToast(`Sync complete: ${result.filesProcessed} files, ${result.paymentsCreated} payments, ${result.claimsMatched} matched`, 'success', 6000);
                await loadKPIs();
                await loadERAs();
            } else {
                showToast('Sync failed: ' + (result.error || 'Unknown error'), 'error');
            }
        } catch (err) {
            showToast('Sync error: ' + err.message, 'error');
        }

        btn.disabled = false;
        btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Sync Now
        `;
    });
}

function setupTestUpload() {
    document.getElementById('test-parse-btn').addEventListener('click', async () => {
        const content = document.getElementById('test-content').value.trim();
        if (!content) {
            showToast('Paste an EDI file first.', 'error');
            return;
        }

        const resultEl = document.getElementById('test-result');
        resultEl.innerHTML = '<div class="card"><div class="spinner"></div> Parsing...</div>';

        try {
            const res = await fetch('/.netlify/functions/parse-era-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content, fileName: 'test-upload.edi' })
            });
            const result = await res.json();

            if (!res.ok) {
                resultEl.innerHTML = `<div class="card" style="background:var(--color-danger-light);border-color:var(--color-danger);"><strong>Parse Error:</strong> ${result.error}</div>`;
                return;
            }

            if (result.type === 'era_835') {
                let html = `<div class="card">
                    <h3 class="mb-2">Parsed ERA (835)</h3>
                    <div class="grid-3 mb-3">
                        <div><span class="text-sm text-muted">Transactions:</span> <strong>${result.summary.transactions}</strong></div>
                        <div><span class="text-sm text-muted">Total Claims:</span> <strong>${result.summary.totalClaims}</strong></div>
                        <div><span class="text-sm text-muted">Total Paid:</span> <strong>${formatCurrency(result.summary.totalPaid)}</strong></div>
                    </div>`;

                for (const tx of result.parsed.transactions) {
                    html += `<div class="card mb-2">
                        <h4>Transaction: ${tx.trace?.checkOrEftNumber || '—'}</h4>
                        <p class="text-sm">
                            <strong>Payer:</strong> ${tx.payer?.name || '—'}<br>
                            <strong>Payee:</strong> ${tx.payee?.name || '—'}<br>
                            <strong>Payment:</strong> ${formatCurrency(tx.payment?.totalPaid)} via ${tx.payment?.paymentMethod || '—'}<br>
                            <strong>Date:</strong> ${formatDate(tx.payment?.effectiveDate)}
                        </p>`;

                    if (tx.claims.length > 0) {
                        html += '<table class="data-table mt-2"><thead><tr><th>Claim ID</th><th>Patient</th><th>Status</th><th class="text-right">Charged</th><th class="text-right">Paid</th><th>Services</th></tr></thead><tbody>';
                        for (const claim of tx.claims) {
                            const patient = claim.patient ? `${claim.patient.lastName}, ${claim.patient.firstName}` : '—';
                            html += `<tr>
                                <td class="text-mono">${claim.patientControlNumber}</td>
                                <td>${patient}</td>
                                <td>${claim.claimStatusText}</td>
                                <td class="text-right">${formatCurrency(claim.totalCharge)}</td>
                                <td class="text-right">${formatCurrency(claim.totalPaid)}</td>
                                <td>${claim.services.length}</td>
                            </tr>`;
                        }
                        html += '</tbody></table>';
                    }

                    html += '</div>';
                }

                html += '</div>';
                resultEl.innerHTML = html;
            } else if (result.type === '277ca') {
                let html = `<div class="card">
                    <h3 class="mb-2">Parsed 277CA Acknowledgment</h3>
                    <p><strong>${result.summary.acknowledgments}</strong> acknowledgments found.</p>
                    <table class="data-table mt-2"><thead><tr><th>Status</th><th>Code</th><th>Description</th><th>Date</th></tr></thead><tbody>`;
                for (const ack of result.parsed.acknowledgments) {
                    html += `<tr>
                        <td>${ack.statusCategory}</td>
                        <td class="text-mono">${ack.statusCode || '—'}</td>
                        <td>${ack.statusText}</td>
                        <td>${formatDate(ack.statusDate)}</td>
                    </tr>`;
                }
                html += '</tbody></table></div>';
                resultEl.innerHTML = html;
            }
        } catch (err) {
            resultEl.innerHTML = `<div class="card" style="background:var(--color-danger-light);border-color:var(--color-danger);"><strong>Error:</strong> ${err.message}</div>`;
        }
    });
}

init();
