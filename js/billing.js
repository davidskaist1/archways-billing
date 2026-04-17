import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, formatCurrency, formatDate, statusBadge, confirmDialog } from './ui.js';
import { createImportUI } from './import.js';
import { openClaimDetailModal } from './claim-detail.js';
import { openCallModal, openNoteModal, openFollowUpModal } from './claim-workflow.js';

let claimsTable, paymentsTable, unmatchedPaymentsTable, problemClaimsTable;
let payers = [];

async function init() {
    const auth = await requireAuth(['admin', 'billing']);
    if (!auth) return;
    renderNav();

    // Load payers for dropdowns
    const { data: payerData } = await supabase.from('insurance_payers').select('id, name').eq('is_active', true).order('name');
    payers = payerData || [];
    populatePayerDropdowns();

    setupTabs();
    setupClaimsTable();
    setupPaymentsTable();
    setupUnmatchedTables();
    setupImport();

    // Default date range: last 90 days
    const now = new Date();
    const ninetyAgo = new Date(now);
    ninetyAgo.setDate(ninetyAgo.getDate() - 90);
    document.getElementById('claims-date-from').value = ninetyAgo.toISOString().split('T')[0];
    document.getElementById('claims-date-to').value = now.toISOString().split('T')[0];

    await loadClaims();
}

function populatePayerDropdowns() {
    for (const id of ['claims-payer', 'payments-payer']) {
        const select = document.getElementById(id);
        for (const p of payers) {
            select.innerHTML += `<option value="${p.id}">${p.name}</option>`;
        }
    }
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');

            if (btn.dataset.tab === 'payments') loadPayments();
            if (btn.dataset.tab === 'unmatched') loadUnmatched();
        });
    });
}

// ============================================
// CLAIMS
// ============================================

function setupClaimsTable() {
    claimsTable = new DataTable('claims-table', {
        columns: [
            { key: 'service_date', label: 'Service Date', type: 'date', render: v => formatDate(v) },
            { key: 'client_name', label: 'Client' },
            { key: 'payer_name', label: 'Payer' },
            { key: 'cpt_code', label: 'CPT', className: 'text-mono' },
            { key: 'modifier', label: 'Mod', render: v => v || '' },
            { key: 'units', label: 'Units', type: 'number', align: 'text-center' },
            { key: 'billed_amount', label: 'Billed', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'expected_amount', label: 'Expected', type: 'number', align: 'text-right', render: v => v ? formatCurrency(v) : '—' },
            { key: 'paid_amount', label: 'Paid', type: 'number', align: 'text-right', render: (v, row) => {
                const paid = parseFloat(v) || 0;
                const expected = parseFloat(row.expected_amount) || parseFloat(row.billed_amount);
                const cls = paid >= expected * 0.95 ? 'text-success' : paid > 0 ? 'text-warning' : '';
                return `<span class="${cls}">${formatCurrency(paid)}</span>`;
            }},
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'days_old', label: 'Age', type: 'number', align: 'text-center', render: v => {
                const cls = v > 90 ? 'text-danger font-bold' : v > 60 ? 'text-warning' : '';
                return `<span class="${cls}">${v}d</span>`;
            }},
            { key: 'actions', label: '', render: (_, r) => `
                <div style="display:flex;gap:4px;">
                    <button class="btn btn-ghost btn-sm quick-call" data-id="${r.id}" title="Log call">📞</button>
                    <button class="btn btn-ghost btn-sm quick-note" data-id="${r.id}" title="Add note">📝</button>
                    <button class="btn btn-ghost btn-sm quick-fu" data-id="${r.id}" title="Follow-up">📅</button>
                </div>
            `}
        ],
        defaultSort: 'service_date',
        defaultSortDir: 'desc',
        onRowClick: openClaimDetail,
        emptyMessage: 'No claims found.'
    });

    document.getElementById('claims-filter-btn').addEventListener('click', loadClaims);
}

async function loadClaims() {
    let query = supabase
        .from('claims')
        .select('*, clients(first_name, last_name), insurance_payers(name), staff!claims_rendering_provider_id_fkey(first_name, last_name)')
        .order('service_date', { ascending: false });

    const from = document.getElementById('claims-date-from').value;
    const to = document.getElementById('claims-date-to').value;
    const payer = document.getElementById('claims-payer').value;
    const status = document.getElementById('claims-status').value;
    const clientSearch = document.getElementById('claims-client-search').value.trim().toLowerCase();
    const cpt = document.getElementById('claims-cpt').value.trim();

    if (from) query = query.gte('service_date', from);
    if (to) query = query.lte('service_date', to);
    if (payer) query = query.eq('payer_id', payer);
    if (status) query = query.eq('status', status);
    if (cpt) query = query.eq('cpt_code', cpt);

    const { data, error } = await query;
    if (error) { showToast('Failed to load claims: ' + error.message, 'error'); return; }

    let claims = (data || []).map(c => {
        const now = new Date();
        const svcDate = new Date(c.service_date);
        return {
            ...c,
            client_name: c.clients ? `${c.clients.last_name}, ${c.clients.first_name}` : '(Unknown)',
            payer_name: c.insurance_payers?.name || '(Unknown)',
            provider_name: c.staff ? `${c.staff.first_name} ${c.staff.last_name}` : '',
            days_old: Math.floor((now - svcDate) / (1000 * 60 * 60 * 24))
        };
    });

    if (clientSearch) {
        claims = claims.filter(c => c.client_name.toLowerCase().includes(clientSearch));
    }

    claimsTable.setData(claims);

    // Wire up quick action buttons (after table renders)
    setTimeout(() => {
        document.querySelectorAll('.quick-call').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const c = claims.find(cl => cl.id === btn.dataset.id);
                if (c) openCallModal(c, loadClaims);
            });
        });
        document.querySelectorAll('.quick-note').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const c = claims.find(cl => cl.id === btn.dataset.id);
                if (c) openNoteModal(c, loadClaims);
            });
        });
        document.querySelectorAll('.quick-fu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const c = claims.find(cl => cl.id === btn.dataset.id);
                if (c) openFollowUpModal(c, loadClaims);
            });
        });
    }, 50);
}

function openClaimDetail(claim) {
    openClaimDetailModal(claim.id, loadClaims);
}

// ============================================
// PAYMENTS
// ============================================

function setupPaymentsTable() {
    paymentsTable = new DataTable('payments-table', {
        columns: [
            { key: 'check_date', label: 'Check Date', type: 'date', render: v => formatDate(v) },
            { key: 'payer_name', label: 'Payer' },
            { key: 'check_number', label: 'Check #', className: 'text-mono' },
            { key: 'payment_amount', label: 'Payment', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'adjustment_amount', label: 'Adjustment', type: 'number', align: 'text-right', render: v => v ? formatCurrency(v) : '—' },
            { key: 'is_matched', label: 'Matched', render: v => v ? statusBadge('paid') : statusBadge('submitted') }
        ],
        defaultSort: 'check_date',
        defaultSortDir: 'desc',
        emptyMessage: 'No payments found.'
    });

    document.getElementById('payments-filter-btn').addEventListener('click', loadPayments);
    document.getElementById('auto-match-btn').addEventListener('click', runAutoMatch);
}

async function loadPayments() {
    let query = supabase
        .from('payments')
        .select('*, insurance_payers(name)')
        .order('check_date', { ascending: false });

    const from = document.getElementById('payments-date-from').value;
    const to = document.getElementById('payments-date-to').value;
    const payer = document.getElementById('payments-payer').value;
    const check = document.getElementById('payments-check').value.trim();

    if (from) query = query.gte('check_date', from);
    if (to) query = query.lte('check_date', to);
    if (payer) query = query.eq('payer_id', payer);
    if (check) query = query.ilike('check_number', `%${check}%`);

    const { data, error } = await query;
    if (error) { showToast('Failed to load payments: ' + error.message, 'error'); return; }

    const payments = (data || []).map(p => ({
        ...p,
        payer_name: p.insurance_payers?.name || '(Unknown)'
    }));

    paymentsTable.setData(payments);
}

// ============================================
// PAYMENT MATCHING ALGORITHM
// ============================================

async function runAutoMatch() {
    const btn = document.getElementById('auto-match-btn');
    btn.disabled = true;
    btn.textContent = 'Matching...';

    try {
        // Get unmatched payments
        const { data: unmatched } = await supabase
            .from('payments')
            .select('*')
            .eq('is_matched', false);

        if (!unmatched || unmatched.length === 0) {
            showToast('No unmatched payments to process.', 'info');
            btn.disabled = false;
            btn.textContent = 'Auto-Match Payments';
            return;
        }

        // Get all open claims
        const { data: openClaims } = await supabase
            .from('claims')
            .select('*')
            .in('status', ['submitted', 'partial', 'appealed']);

        if (!openClaims || openClaims.length === 0) {
            showToast('No open claims to match against.', 'info');
            btn.disabled = false;
            btn.textContent = 'Auto-Match Payments';
            return;
        }

        let matched = 0;
        let suggested = 0;

        for (const payment of unmatched) {
            const result = await matchPayment(payment, openClaims);
            if (result.matched) matched++;
            if (result.suggested) suggested++;
        }

        // Update claim statuses based on paid amounts
        await updateClaimStatuses();

        showToast(`Auto-match complete: ${matched} matched, ${suggested} need review.`, matched > 0 ? 'success' : 'info');
        loadPayments();
        loadUnmatched();
    } catch (err) {
        showToast('Matching failed: ' + err.message, 'error');
    }

    btn.disabled = false;
    btn.textContent = 'Auto-Match Payments';
}

async function matchPayment(payment, openClaims) {
    // TIER 1: Exact match by CR Claim ID
    // (payment imports include cr_claim_id in the metadata)
    // We check if claim_id is already set from import mapping
    if (payment.claim_id) {
        // Already linked during import
        await supabase.from('payments').update({ is_matched: true }).eq('id', payment.id);
        await updateClaimPayment(payment.claim_id, payment.payment_amount, payment.adjustment_amount);
        return { matched: true, suggested: false };
    }

    // TIER 2: Match by composite key
    // Since payment records may not have direct claim references, try matching by
    // payer + amount patterns. Look for single open claim from same payer with matching amount.
    const samePayer = openClaims.filter(c => c.payer_id === payment.payer_id);

    if (samePayer.length === 1) {
        // Only one open claim from this payer — match it
        const claim = samePayer[0];
        await supabase.from('payments').update({
            claim_id: claim.id,
            is_matched: true
        }).eq('id', payment.id);
        await updateClaimPayment(claim.id, payment.payment_amount, payment.adjustment_amount);

        // Remove from openClaims so it won't be matched again
        const idx = openClaims.indexOf(claim);
        if (idx > -1) openClaims.splice(idx, 1);
        return { matched: true, suggested: false };
    }

    // TIER 2b: Match by billed amount (look for claims where billed matches payment)
    const amountMatch = samePayer.filter(c => {
        const outstanding = parseFloat(c.billed_amount) - parseFloat(c.paid_amount || 0);
        return Math.abs(outstanding - parseFloat(payment.payment_amount)) < 0.01;
    });

    if (amountMatch.length === 1) {
        const claim = amountMatch[0];
        await supabase.from('payments').update({
            claim_id: claim.id,
            is_matched: true
        }).eq('id', payment.id);
        await updateClaimPayment(claim.id, payment.payment_amount, payment.adjustment_amount);

        const idx = openClaims.indexOf(claim);
        if (idx > -1) openClaims.splice(idx, 1);
        return { matched: true, suggested: false };
    }

    // TIER 3: No confident match — leave for manual review
    return { matched: false, suggested: samePayer.length > 0 };
}

async function updateClaimPayment(claimId, paymentAmount, adjustmentAmount) {
    const { data: claim } = await supabase.from('claims').select('*').eq('id', claimId).single();
    if (!claim) return;

    const newPaid = parseFloat(claim.paid_amount || 0) + parseFloat(paymentAmount || 0);
    const newAdj = parseFloat(claim.adjustment_amount || 0) + parseFloat(adjustmentAmount || 0);
    const expected = parseFloat(claim.expected_amount || claim.billed_amount);

    let newStatus = claim.status;
    if (newPaid >= expected * 0.95) {
        newStatus = 'paid';
    } else if (newPaid > 0) {
        newStatus = 'partial';
    } else if (parseFloat(paymentAmount) === 0 && parseFloat(adjustmentAmount) > 0) {
        newStatus = 'denied';
    }

    await supabase.from('claims').update({
        paid_amount: newPaid,
        adjustment_amount: newAdj,
        status: newStatus,
        date_paid: newStatus === 'paid' ? new Date().toISOString().split('T')[0] : claim.date_paid
    }).eq('id', claimId);
}

async function updateClaimStatuses() {
    // Flag stale claims (45+ days, no payment)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 45);

    const { data: stale } = await supabase
        .from('claims')
        .select('id')
        .eq('status', 'submitted')
        .eq('paid_amount', 0)
        .lt('service_date', cutoff.toISOString().split('T')[0]);

    // We don't auto-change status — just report them in the unmatched tab
}

// ============================================
// UNMATCHED / ACTION REQUIRED
// ============================================

function setupUnmatchedTables() {
    unmatchedPaymentsTable = new DataTable('unmatched-payments-table', {
        columns: [
            { key: 'check_date', label: 'Date', type: 'date', render: v => formatDate(v) },
            { key: 'payer_name', label: 'Payer' },
            { key: 'check_number', label: 'Check #', className: 'text-mono' },
            { key: 'payment_amount', label: 'Amount', type: 'number', align: 'text-right', render: v => formatCurrency(v) }
        ],
        pageSize: 10,
        emptyMessage: 'All payments are matched.'
    });

    problemClaimsTable = new DataTable('problem-claims-table', {
        columns: [
            { key: 'service_date', label: 'Date', type: 'date', render: v => formatDate(v) },
            { key: 'client_name', label: 'Client' },
            { key: 'issue', label: 'Issue', render: v => `<span class="badge badge-warning">${v}</span>` },
            { key: 'billed_amount', label: 'Billed', type: 'number', align: 'text-right', render: v => formatCurrency(v) }
        ],
        pageSize: 10,
        onRowClick: openClaimDetail,
        emptyMessage: 'No claims need attention.'
    });
}

async function loadUnmatched() {
    // Unmatched payments
    const { data: unmatched } = await supabase
        .from('payments')
        .select('*, insurance_payers(name)')
        .eq('is_matched', false)
        .order('check_date', { ascending: false });

    unmatchedPaymentsTable.setData((unmatched || []).map(p => ({
        ...p,
        payer_name: p.insurance_payers?.name || '(Unknown)'
    })));

    // Problem claims: denied, underpaid, or stale (45+ days no payment)
    const cutoff45 = new Date();
    cutoff45.setDate(cutoff45.getDate() - 45);

    const { data: problems } = await supabase
        .from('claims')
        .select('*, clients(first_name, last_name), insurance_payers(name)')
        .or(`status.eq.denied,status.eq.partial,and(status.eq.submitted,paid_amount.eq.0,service_date.lt.${cutoff45.toISOString().split('T')[0]})`)
        .order('service_date', { ascending: false })
        .limit(50);

    const problemRows = (problems || []).map(c => {
        let issue = c.status;
        if (c.status === 'submitted' && parseFloat(c.paid_amount) === 0) {
            issue = 'No payment 45+ days';
        } else if (c.status === 'partial') {
            const expected = parseFloat(c.expected_amount || c.billed_amount);
            const paid = parseFloat(c.paid_amount);
            issue = `Underpaid by ${formatCurrency(expected - paid)}`;
        } else if (c.status === 'denied') {
            issue = 'Denied' + (c.denial_reason ? ': ' + c.denial_reason : '');
        }
        return {
            ...c,
            client_name: c.clients ? `${c.clients.last_name}, ${c.clients.first_name}` : '(Unknown)',
            payer_name: c.insurance_payers?.name || '(Unknown)',
            issue
        };
    });

    problemClaimsTable.setData(problemRows);
}

// ============================================
// IMPORT
// ============================================

function setupImport() {
    createImportUI('import-claims-zone', 'claims', () => {
        showToast('Claims imported. Switch to the Claims tab to view.', 'success');
    });

    createImportUI('import-payments-zone', 'payments', () => {
        showToast('Payments imported. Run Auto-Match on the Payments tab.', 'success');
    });
}

init();
