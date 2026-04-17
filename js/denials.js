import { requireAuth, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, formatCurrency, formatDate, statusBadge, confirmDialog } from './ui.js';
import { openClaimDetailModal } from './claim-detail.js';
import { logActivity } from './claim-workflow.js';

let denialsTable;
let allDenials = [];
let allAppeals = [];
let payers = [];

async function init() {
    const auth = await requireAuth(['admin', 'billing']);
    if (!auth) return;
    renderNav();

    const { data: payerData } = await supabase.from('insurance_payers').select('id, name').eq('is_active', true).order('name');
    payers = payerData || [];
    for (const p of payers) {
        document.getElementById('filter-payer').innerHTML += `<option value="${p.id}">${p.name}</option>`;
    }

    setupTabs();
    setupDenialsTable();
    setupFilters();

    await loadAll();
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
            if (btn.dataset.tab === 'appeals') renderAppeals();
        });
    });
}

function setupDenialsTable() {
    denialsTable = new DataTable('denials-table', {
        columns: [
            { key: 'denial_date', label: 'Denied', type: 'date', render: v => formatDate(v) },
            { key: 'client_name', label: 'Client' },
            { key: 'payer_name', label: 'Payer' },
            { key: 'service_date', label: 'DOS', type: 'date', render: v => formatDate(v) },
            { key: 'cpt_code', label: 'CPT', className: 'text-mono' },
            { key: 'denial_category', label: 'Category', render: v => `<span class="denial-category">${v.replace('_', ' ')}</span>` },
            { key: 'denial_code', label: 'Code', className: 'text-mono', render: v => v || '—' },
            { key: 'billed_amount', label: 'Amount', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'appeal_deadline', label: 'Deadline', render: (v, r) => {
                if (!v) return '—';
                const days = Math.floor((new Date(v) - new Date()) / (1000 * 60 * 60 * 24));
                const cls = days < 0 ? 'text-danger font-bold' : days < 14 ? 'text-warning' : '';
                return `<span class="${cls}">${formatDate(v)}${days >= 0 ? ` (${days}d)` : ' OVERDUE'}</span>`;
            }},
            { key: 'action_plan', label: 'Plan', render: v => v ? v.replace('_', ' ') : '—' },
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'actions', label: '', render: (_, r) => `
                <div style="display:flex;gap:4px;">
                    <button class="btn btn-ghost btn-sm work-denial" data-id="${r.id}" title="Work this denial">▶</button>
                    ${r.action_plan === 'appeal' && r.status !== 'appealed' ? `<button class="btn btn-ghost btn-sm btn-primary build-appeal" data-id="${r.id}" title="Build appeal">⚖️</button>` : ''}
                </div>
            `}
        ],
        defaultSort: 'denial_date',
        defaultSortDir: 'desc',
        onRowClick: (r) => openClaimDetailModal(r.claim_id, loadAll),
        emptyMessage: 'No denials match these filters.'
    });
}

function setupFilters() {
    ['filter-status', 'filter-category', 'filter-action', 'filter-payer'].forEach(id => {
        document.getElementById(id).addEventListener('change', renderDenials);
    });
}

async function loadAll() {
    // Load denials with claim info
    const { data: denials } = await supabase
        .from('claim_denials')
        .select(`
            *,
            claims(
                id, service_date, cpt_code, billed_amount, payer_id,
                clients(first_name, last_name),
                insurance_payers(name)
            )
        `)
        .order('denial_date', { ascending: false });

    allDenials = (denials || []).map(d => ({
        ...d,
        client_name: d.claims?.clients ? `${d.claims.clients.last_name}, ${d.claims.clients.first_name}` : '(Unknown)',
        payer_name: d.claims?.insurance_payers?.name || '(Unknown)',
        payer_id: d.claims?.payer_id,
        service_date: d.claims?.service_date,
        cpt_code: d.claims?.cpt_code,
        billed_amount: d.claims?.billed_amount
    }));

    // Load appeals
    const { data: appeals } = await supabase
        .from('claim_appeals')
        .select(`
            *,
            claims(id, service_date, cpt_code, billed_amount, clients(first_name, last_name), insurance_payers(name))
        `)
        .order('created_at', { ascending: false });

    allAppeals = appeals || [];

    updateKPIs();
    renderDenials();
    renderAppeals();
}

function updateKPIs() {
    const open = allDenials.filter(d => ['open', 'in_progress'].includes(d.status));
    const now = new Date();
    const in14Days = new Date(now); in14Days.setDate(in14Days.getDate() + 14);

    const approaching = open.filter(d =>
        d.appeal_deadline && new Date(d.appeal_deadline) <= in14Days
    );

    const totalDollars = open.reduce((sum, d) => sum + parseFloat(d.denied_amount || d.billed_amount || 0), 0);

    document.getElementById('kpi-open').textContent = open.length;
    document.getElementById('kpi-open-sub').textContent = `of ${allDenials.length} total`;
    document.getElementById('kpi-deadline').textContent = approaching.length;
    document.getElementById('kpi-dollars').textContent = formatCurrency(totalDollars);

    // Resolution rate (last 90 days)
    const ninetyAgo = new Date(now); ninetyAgo.setDate(ninetyAgo.getDate() - 90);
    const recent = allDenials.filter(d => new Date(d.denial_date) >= ninetyAgo);
    const resolved = recent.filter(d => d.status === 'resolved');
    const rate = recent.length > 0 ? Math.round(resolved.length / recent.length * 100) : 0;
    document.getElementById('kpi-resolution').textContent = rate + '%';

    // Appeal KPIs
    document.getElementById('appeal-draft').textContent = allAppeals.filter(a => a.status === 'draft').length;
    document.getElementById('appeal-submitted').textContent = allAppeals.filter(a => ['submitted', 'pending'].includes(a.status)).length;
    document.getElementById('appeal-approved').textContent = allAppeals.filter(a => ['approved', 'overturned'].includes(a.status)).length;
    document.getElementById('appeal-denied').textContent = allAppeals.filter(a => a.status === 'denied').length;
}

function renderDenials() {
    const status = document.getElementById('filter-status').value;
    const category = document.getElementById('filter-category').value;
    const action = document.getElementById('filter-action').value;
    const payer = document.getElementById('filter-payer').value;

    let filtered = [...allDenials];

    if (status === '') {
        filtered = filtered.filter(d => ['open', 'in_progress'].includes(d.status));
    } else {
        filtered = filtered.filter(d => d.status === status);
    }

    if (category) filtered = filtered.filter(d => d.denial_category === category);
    if (action) filtered = filtered.filter(d => d.action_plan === action);
    if (payer) filtered = filtered.filter(d => d.payer_id === payer);

    denialsTable.setData(filtered);

    // Bind action buttons
    setTimeout(() => {
        document.querySelectorAll('.work-denial').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const denial = allDenials.find(d => d.id === btn.dataset.id);
                if (denial) openClaimDetailModal(denial.claim_id, loadAll);
            });
        });

        document.querySelectorAll('.build-appeal').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const denial = allDenials.find(d => d.id === btn.dataset.id);
                if (denial) openAppealBuilder(denial);
            });
        });
    }, 50);
}

function renderAppeals() {
    const kanban = document.getElementById('appeals-kanban');

    const columns = [
        { status: 'draft', label: 'Draft', color: 'badge-secondary' },
        { status: 'submitted', label: 'Submitted', color: 'badge-info' },
        { status: 'pending', label: 'Pending', color: 'badge-warning' },
        { status: 'approved', label: 'Approved', color: 'badge-success' },
        { status: 'denied', label: 'Denied', color: 'badge-danger' }
    ];

    let html = '';
    for (const col of columns) {
        const items = allAppeals.filter(a => a.status === col.status);
        html += `<div class="kanban-column">
            <div class="kanban-column-header">
                <span>${col.label}</span>
                <span class="badge ${col.color}">${items.length}</span>
            </div>`;

        for (const a of items) {
            const client = a.claims?.clients ? `${a.claims.clients.last_name}, ${a.claims.clients.first_name}` : '';
            const payer = a.claims?.insurance_payers?.name || '';
            html += `<div class="kanban-card" data-appeal-id="${a.id}" data-claim-id="${a.claim_id}">
                <div><strong>${client}</strong></div>
                <div class="text-xs text-muted">${payer}</div>
                <div class="text-xs">${a.claims?.service_date ? formatDate(a.claims.service_date) : ''} · ${a.claims?.cpt_code || ''}</div>
                ${a.deadline ? `<div class="text-xs text-warning mt-1">Deadline: ${formatDate(a.deadline)}</div>` : ''}
                ${a.submitted_date ? `<div class="text-xs text-muted">Sent: ${formatDate(a.submitted_date)}</div>` : ''}
                <div class="text-xs mt-1"><strong>${formatCurrency(a.claims?.billed_amount || 0)}</strong> · ${a.appeal_level}</div>
            </div>`;
        }

        html += '</div>';
    }

    kanban.innerHTML = html;

    // Click to open
    kanban.querySelectorAll('.kanban-card').forEach(card => {
        card.addEventListener('click', () => {
            openAppealModal(card.dataset.appealId);
        });
    });
}

async function openAppealBuilder(denial) {
    // Fetch templates
    const { data: templates } = await supabase
        .from('appeal_templates')
        .select('*')
        .eq('is_active', true)
        .order('name');

    // Fetch full claim data
    const { data: claim } = await supabase
        .from('claims')
        .select('*, clients(first_name, last_name, insurance_member_id), insurance_payers(name)')
        .eq('id', denial.claim_id)
        .single();

    // Find relevant templates (prefer same category)
    const matchingTemplates = (templates || []).filter(t =>
        !t.denial_category || t.denial_category === denial.denial_category
    );

    const templateOptions = matchingTemplates.map(t =>
        `<option value="${t.id}">${t.name}${t.denial_category ? ' (' + t.denial_category.replace('_', ' ') + ')' : ''}</option>`
    ).join('');

    const bodyHTML = `
        <form id="appeal-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Template</label>
                    <select class="form-select" id="template-select">
                        <option value="">— Start blank —</option>
                        ${templateOptions}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Appeal Level</label>
                    <select class="form-select" name="appeal_level">
                        <option value="first">First-level</option>
                        <option value="second">Second-level</option>
                        <option value="external">External Review</option>
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Deadline *</label>
                    <input class="form-input" type="date" name="deadline" value="${denial.appeal_deadline || ''}" required>
                </div>
                <div class="form-group">
                    <label class="form-label">Reference Number</label>
                    <input class="form-input" name="reference_number" placeholder="Internal tracking #">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Subject</label>
                <input class="form-input" id="appeal-subject" placeholder="Appeal Subject">
            </div>
            <div class="form-group">
                <label class="form-label">Appeal Letter</label>
                <textarea class="form-textarea" id="appeal-letter" rows="14" style="font-family:var(--font-mono);font-size:0.85rem;"></textarea>
                <p class="text-xs text-muted mt-1">Variables like {{patient_name}} are auto-filled. Edit freely before saving.</p>
            </div>
            <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" name="notes" rows="2" placeholder="Internal notes..."></textarea>
            </div>
        </form>
    `;

    createModal('appeal-builder-modal', 'Build Appeal', bodyHTML, `
        <button class="btn btn-secondary" id="ab-cancel">Cancel</button>
        <button class="btn btn-secondary" id="ab-save-draft">Save as Draft</button>
        <button class="btn btn-primary" id="ab-submit">Mark as Submitted</button>
    `, 'modal-lg');
    openModal('appeal-builder-modal');

    // Template selector fills content
    document.getElementById('template-select').addEventListener('change', (e) => {
        const tpl = matchingTemplates.find(t => t.id === e.target.value);
        if (tpl && claim) {
            const vars = {
                patient_name: `${claim.clients?.first_name || ''} ${claim.clients?.last_name || ''}`.trim(),
                member_id: claim.clients?.insurance_member_id || '',
                claim_number: claim.cr_claim_id || '',
                service_date: formatDate(claim.service_date),
                cpt_code: claim.cpt_code,
                modifier: claim.modifier || '',
                billed_amount: parseFloat(claim.billed_amount).toFixed(2),
                denial_code: denial.denial_code || '',
                denial_description: denial.denial_reason || '',
                payer_name: claim.insurance_payers?.name || '',
                authorization_number: claim.clients?.authorization_number || '',
                current_date: new Date().toLocaleDateString()
            };

            let content = tpl.content;
            let subject = tpl.subject || '';

            for (const [k, v] of Object.entries(vars)) {
                const re = new RegExp(`{{${k}}}`, 'g');
                content = content.replace(re, v);
                subject = subject.replace(re, v);
            }

            document.getElementById('appeal-letter').value = content;
            document.getElementById('appeal-subject').value = subject;
        }
    });

    const saveAppeal = async (status) => {
        const fd = new FormData(document.getElementById('appeal-form'));
        const user = getCurrentStaff();

        const record = {
            claim_id: denial.claim_id,
            denial_id: denial.id,
            appeal_level: fd.get('appeal_level'),
            deadline: fd.get('deadline') || null,
            reference_number: fd.get('reference_number').trim() || null,
            letter_content: document.getElementById('appeal-letter').value,
            notes: fd.get('notes').trim() || null,
            status,
            submitted_date: status === 'submitted' ? new Date().toISOString().split('T')[0] : null,
            created_by: user.id
        };

        const { error } = await supabase.from('claim_appeals').insert(record);
        if (error) {
            showToast('Failed to save appeal: ' + error.message, 'error');
            return;
        }

        // Update denial status
        await supabase.from('claim_denials').update({
            status: status === 'submitted' ? 'appealed' : 'in_progress'
        }).eq('id', denial.id);

        // Update claim status
        if (status === 'submitted') {
            await supabase.from('claims').update({ status: 'appealed' }).eq('id', denial.claim_id);
        }

        await logActivity(denial.claim_id, 'appealed',
            `Appeal ${status === 'submitted' ? 'submitted' : 'drafted'} (${record.appeal_level} level)`
        );

        closeModal('appeal-builder-modal');
        showToast('Appeal saved.', 'success');
        await loadAll();
    };

    document.getElementById('ab-cancel').addEventListener('click', () => closeModal('appeal-builder-modal'));
    document.getElementById('ab-save-draft').addEventListener('click', () => saveAppeal('draft'));
    document.getElementById('ab-submit').addEventListener('click', () => saveAppeal('submitted'));
}

async function openAppealModal(appealId) {
    const appeal = allAppeals.find(a => a.id === appealId);
    if (!appeal) return;

    const bodyHTML = `
        <div class="grid-2 gap-lg">
            <div>
                <h4 class="mb-1">Appeal Info</h4>
                <div class="card mb-2">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.85rem;">
                        <div><strong>Level:</strong><br>${appeal.appeal_level}</div>
                        <div><strong>Status:</strong><br>${statusBadge(appeal.status)}</div>
                        <div><strong>Deadline:</strong><br>${appeal.deadline ? formatDate(appeal.deadline) : '—'}</div>
                        <div><strong>Submitted:</strong><br>${appeal.submitted_date ? formatDate(appeal.submitted_date) : '—'}</div>
                        <div><strong>Reference:</strong><br><span class="font-mono">${appeal.reference_number || '—'}</span></div>
                        <div><strong>Outcome:</strong><br>${appeal.outcome_amount ? formatCurrency(appeal.outcome_amount) : '—'}</div>
                    </div>
                </div>

                <h4 class="mb-1">Update Status</h4>
                <div class="form-group">
                    <select class="form-select" id="new-status">
                        <option value="draft" ${appeal.status === 'draft' ? 'selected' : ''}>Draft</option>
                        <option value="submitted" ${appeal.status === 'submitted' ? 'selected' : ''}>Submitted</option>
                        <option value="pending" ${appeal.status === 'pending' ? 'selected' : ''}>Pending</option>
                        <option value="approved" ${appeal.status === 'approved' ? 'selected' : ''}>Approved</option>
                        <option value="overturned" ${appeal.status === 'overturned' ? 'selected' : ''}>Overturned</option>
                        <option value="denied" ${appeal.status === 'denied' ? 'selected' : ''}>Denied</option>
                    </select>
                </div>

                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Outcome Date</label>
                        <input class="form-input" type="date" id="outcome-date" value="${appeal.outcome_date || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Outcome Amount</label>
                        <input class="form-input" type="number" step="0.01" id="outcome-amount" value="${appeal.outcome_amount || ''}">
                    </div>
                </div>

                <button class="btn btn-primary" id="update-status-btn" style="width:100%;">Update Appeal</button>

                <div class="mt-2">
                    <button class="btn btn-ghost" id="view-claim-btn" style="width:100%;">View Claim Details</button>
                </div>
            </div>
            <div>
                <h4 class="mb-1">Appeal Letter</h4>
                <div class="card" style="white-space:pre-wrap;font-family:var(--font-mono);font-size:0.8rem;max-height:500px;overflow-y:auto;">${appeal.letter_content || 'No letter content'}</div>
                ${appeal.notes ? `<h4 class="mb-1 mt-2">Notes</h4><div class="card">${appeal.notes}</div>` : ''}
            </div>
        </div>
    `;

    createModal('view-appeal-modal', 'Appeal Detail', bodyHTML, `
        <button class="btn btn-secondary" id="va-close">Close</button>
    `, 'modal-xl');
    openModal('view-appeal-modal');

    document.getElementById('va-close').addEventListener('click', () => closeModal('view-appeal-modal'));
    document.getElementById('view-claim-btn').addEventListener('click', () => {
        closeModal('view-appeal-modal');
        openClaimDetailModal(appeal.claim_id, loadAll);
    });

    document.getElementById('update-status-btn').addEventListener('click', async () => {
        const newStatus = document.getElementById('new-status').value;
        const outcomeDate = document.getElementById('outcome-date').value;
        const outcomeAmount = document.getElementById('outcome-amount').value;

        const updates = { status: newStatus };
        if (outcomeDate) updates.outcome_date = outcomeDate;
        if (outcomeAmount) updates.outcome_amount = parseFloat(outcomeAmount);

        const { error } = await supabase.from('claim_appeals').update(updates).eq('id', appeal.id);
        if (error) { showToast('Failed: ' + error.message, 'error'); return; }

        // If approved/overturned, update claim and denial status
        if (['approved', 'overturned'].includes(newStatus)) {
            await supabase.from('claim_denials').update({
                status: 'resolved',
                resolved_at: new Date().toISOString(),
                resolution_outcome: 'Appeal ' + newStatus
            }).eq('id', appeal.denial_id);

            await logActivity(appeal.claim_id, 'status_changed', `Appeal ${newStatus}${outcomeAmount ? ' for ' + formatCurrency(outcomeAmount) : ''}`);
        }

        showToast('Appeal updated.', 'success');
        closeModal('view-appeal-modal');
        await loadAll();
    });
}

init();
