import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { showToast, createModal, openModal, closeModal, formatDate, statusBadge, confirmDialog } from './ui.js';

let currentTab = 'active';
let allAuths = [];
let clients = [];
let payers = [];

async function init() {
    const auth = await requireAuth(['admin', 'billing']);
    if (!auth) return;
    renderNav();

    // Load clients and payers for forms
    const [clientsRes, payersRes] = await Promise.all([
        supabase.from('clients').select('id, first_name, last_name').eq('is_active', true).order('last_name'),
        supabase.from('insurance_payers').select('id, name').eq('is_active', true).order('name')
    ]);
    clients = clientsRes.data || [];
    payers = payersRes.data || [];

    for (const p of payers) {
        document.getElementById('filter-payer').innerHTML += `<option value="${p.id}">${p.name}</option>`;
    }

    // Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.dataset.tab;
            render();
        });
    });

    // Filters
    document.getElementById('filter-client').addEventListener('input', render);
    document.getElementById('filter-payer').addEventListener('change', render);
    document.getElementById('filter-util').addEventListener('change', render);

    document.getElementById('refresh-btn').addEventListener('click', load);
    document.getElementById('add-auth-btn').addEventListener('click', () => openAuthForm());
    document.getElementById('backfill-btn').addEventListener('click', runBackfill);

    await load();
}

async function runBackfill() {
    const btn = document.getElementById('backfill-btn');
    btn.disabled = true;
    btn.textContent = 'Syncing...';

    try {
        const res = await fetch('/.netlify/functions/backfill-authorizations');
        const result = await res.json();

        if (!result.ok) {
            throw new Error(result.error || 'Sync failed');
        }

        const msg = `Synced ${result.total} auths: ${result.created} created, ${result.updated} updated${result.failed ? ', ' + result.failed + ' failed' : ''}.`;
        showToast(msg, result.failed > 0 ? 'warning' : 'success', 6000);
        await load();
    } catch (err) {
        showToast('Sync failed: ' + err.message, 'error');
    }

    btn.disabled = false;
    btn.textContent = '🔄 Sync from CRM';
}

async function load() {
    // Fetch authorizations with utilization
    const { data: auths } = await supabase
        .from('authorizations')
        .select(`
            *,
            clients(id, first_name, last_name),
            insurance_payers(id, name)
        `)
        .order('end_date');

    // For each auth, prefer CRM-provided used_hours, fall back to unit-based calc from claims
    const enriched = [];
    for (const a of (auths || [])) {
        let usedUnits = 0;
        let usedHours = parseFloat(a.used_hours) || 0;

        // If we don't have used_hours from CRM, try to compute from claims
        if (!a.used_hours && a.client_id && a.cpt_codes?.length) {
            const { data: claims } = await supabase
                .from('claims')
                .select('units')
                .eq('client_id', a.client_id)
                .in('cpt_code', a.cpt_codes)
                .gte('service_date', a.start_date)
                .lte('service_date', a.end_date);

            usedUnits = (claims || []).reduce((sum, c) => sum + parseFloat(c.units || 0), 0);
            usedHours = usedUnits / 4; // CPT codes are usually in 15-min units, so 4 units = 1 hour
        }

        // Utilization: prefer hours-based calc if we have totalApprovedHours, else units
        let utilization = 0;
        if (a.total_approved_hours && a.total_approved_hours > 0) {
            utilization = Math.min(100, Math.round(usedHours / parseFloat(a.total_approved_hours) * 100));
        } else if (a.approved_units > 0) {
            utilization = Math.min(100, Math.round(usedUnits / a.approved_units * 100));
        }

        const now = new Date();
        const end = new Date(a.end_date);
        const daysLeft = Math.floor((end - now) / (1000 * 60 * 60 * 24));

        let computedStatus = a.status;
        if (a.status === 'active') {
            if (daysLeft < 0) computedStatus = 'expired';
            else if (daysLeft <= 30) computedStatus = 'expiring';
        }

        enriched.push({
            ...a,
            used_units: usedUnits,
            used_hours: usedHours,
            utilization_pct: utilization,
            days_left: daysLeft,
            computed_status: computedStatus,
            client_name: a.clients ? `${a.clients.last_name}, ${a.clients.first_name}` : '(Unknown)',
            payer_name: a.insurance_payers?.name || '(Unknown)'
        });
    }

    allAuths = enriched;
    updateKPIs();
    render();
}

function updateKPIs() {
    const active = allAuths.filter(a => a.computed_status === 'active');
    const expiring = allAuths.filter(a => a.computed_status === 'expiring');
    const expired = allAuths.filter(a => a.computed_status === 'expired');

    document.getElementById('kpi-active').textContent = active.length;
    document.getElementById('kpi-expiring').textContent = expiring.length;
    document.getElementById('kpi-expired').textContent = expired.length;

    const activeAuths = allAuths.filter(a => ['active', 'expiring'].includes(a.computed_status));
    const avgUtil = activeAuths.length > 0
        ? Math.round(activeAuths.reduce((s, a) => s + a.utilization_pct, 0) / activeAuths.length)
        : 0;
    document.getElementById('kpi-utilization').textContent = avgUtil + '%';
}

function render() {
    const list = document.getElementById('auth-list');
    const clientFilter = document.getElementById('filter-client').value.toLowerCase();
    const payerFilter = document.getElementById('filter-payer').value;
    const utilFilter = document.getElementById('filter-util').value;

    let filtered = [...allAuths];

    // Tab filter
    if (currentTab === 'active') filtered = filtered.filter(a => a.computed_status === 'active');
    else if (currentTab === 'expiring') filtered = filtered.filter(a => a.computed_status === 'expiring');
    else if (currentTab === 'expired') filtered = filtered.filter(a => a.computed_status === 'expired');

    // Other filters
    if (clientFilter) filtered = filtered.filter(a => a.client_name.toLowerCase().includes(clientFilter));
    if (payerFilter) filtered = filtered.filter(a => a.payer_id === payerFilter);
    if (utilFilter === 'high') filtered = filtered.filter(a => a.utilization_pct >= 75);
    else if (utilFilter === 'exhausted') filtered = filtered.filter(a => a.utilization_pct >= 90);
    else if (utilFilter === 'low') filtered = filtered.filter(a => a.utilization_pct < 25);

    if (filtered.length === 0) {
        list.innerHTML = `<div class="empty-state"><h3>No authorizations</h3><p>No auths match these filters.</p></div>`;
        return;
    }

    let html = '';
    for (const a of filtered) {
        const utilClass = a.utilization_pct >= 90 ? 'util-danger' : a.utilization_pct >= 75 ? 'util-warning' : '';
        const statusColor = a.computed_status === 'expired' ? 'badge-danger' : a.computed_status === 'expiring' ? 'badge-warning' : 'badge-success';
        const daysText = a.days_left < 0
            ? `<span class="text-danger font-bold">Expired ${Math.abs(a.days_left)} days ago</span>`
            : a.days_left <= 30
            ? `<span class="text-warning">${a.days_left} days left</span>`
            : `<span class="text-muted">${a.days_left} days left</span>`;

        // Utilization display — prefer hours if we have totalApprovedHours
        let utilizationLine = '';
        if (a.total_approved_hours) {
            utilizationLine = `<strong>${a.used_hours.toFixed(1)}</strong> / ${a.total_approved_hours} hours (${a.utilization_pct}%)`;
        } else if (a.approved_units) {
            utilizationLine = `<strong>${a.used_units}</strong> / ${a.approved_units} units (${a.utilization_pct}%)`;
        } else {
            utilizationLine = `<span class="text-muted">No total specified</span>`;
        }

        const sourceTag = a.source === 'archways-crm'
            ? '<span class="badge badge-info text-xs" title="Synced from CRM">🔄 CRM</span>'
            : a.source === 'manual'
            ? ''
            : '';

        html += `<div class="card mb-2" style="cursor:pointer;" data-auth-id="${a.id}">
            <div class="flex-between mb-1">
                <div>
                    <strong>${a.client_name}</strong>
                    <span class="badge ${statusColor}">${a.computed_status}</span>
                    ${sourceTag}
                    ${a.service_type ? `<span class="badge badge-secondary">${a.service_type.replace(/_/g, ' ')}</span>` : ''}
                </div>
                <div class="text-right">
                    <div class="font-mono text-sm">#${a.auth_number}</div>
                    <div class="text-xs text-muted">${a.payer_name}</div>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:16px;font-size:0.85rem;margin-bottom:8px;">
                <div>
                    <div class="text-xs text-muted">Effective</div>
                    <div>${formatDate(a.start_date)} – ${formatDate(a.end_date)}</div>
                </div>
                <div>
                    <div class="text-xs text-muted">Hours/Week</div>
                    <div>${a.approved_hours_per_week || '—'}</div>
                </div>
                <div>
                    <div class="text-xs text-muted">Total Hours</div>
                    <div>${a.total_approved_hours || '—'}</div>
                </div>
                <div>
                    <div class="text-xs text-muted">Time Remaining</div>
                    <div>${daysText}</div>
                </div>
            </div>
            <div style="display:flex;gap:12px;align-items:center;">
                <div style="flex:1;">
                    <div class="flex-between text-xs mb-1">
                        <span class="text-muted">Utilization</span>
                        <span>${utilizationLine}</span>
                    </div>
                    <div class="util-bar">
                        <div class="util-bar-fill ${utilClass}" style="width:${a.utilization_pct}%"></div>
                    </div>
                </div>
            </div>
        </div>`;
    }
    list.innerHTML = html;

    // Click to edit
    list.querySelectorAll('[data-auth-id]').forEach(card => {
        card.addEventListener('click', () => {
            const a = allAuths.find(x => x.id === card.dataset.authId);
            if (a) openAuthForm(a);
        });
    });
}

function openAuthForm(auth = null) {
    const isEdit = !!auth;
    const clientOpts = clients.map(c =>
        `<option value="${c.id}" ${auth?.client_id === c.id ? 'selected' : ''}>${c.last_name}, ${c.first_name}</option>`
    ).join('');
    const payerOpts = payers.map(p =>
        `<option value="${p.id}" ${auth?.payer_id === p.id ? 'selected' : ''}>${p.name}</option>`
    ).join('');

    const bodyHTML = `
        <form id="auth-form">
            ${auth?.crm_auth_id ? `<div class="card mb-2" style="background:var(--color-info-light);">
                <p class="text-sm">This auth is synced from the CRM (ID: <code>${auth.crm_auth_id}</code>). Changes here will be overwritten by the next CRM sync.</p>
            </div>` : ''}
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Client *</label>
                    <select class="form-select" name="client_id" required>
                        <option value="">— Select Client —</option>
                        ${clientOpts}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Payer *</label>
                    <select class="form-select" name="payer_id" required>
                        <option value="">— Select Payer —</option>
                        ${payerOpts}
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Auth Number *</label>
                    <input class="form-input" name="auth_number" required value="${auth?.auth_number || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Status</label>
                    <select class="form-select" name="status">
                        <option value="active" ${auth?.status === 'active' ? 'selected' : ''}>Active</option>
                        <option value="pending" ${auth?.status === 'pending' ? 'selected' : ''}>Pending</option>
                        <option value="expired" ${auth?.status === 'expired' ? 'selected' : ''}>Expired</option>
                        <option value="denied" ${auth?.status === 'denied' ? 'selected' : ''}>Denied</option>
                        <option value="cancelled" ${auth?.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Start Date *</label>
                    <input class="form-input" type="date" name="start_date" required value="${auth?.start_date || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">End Date *</label>
                    <input class="form-input" type="date" name="end_date" required value="${auth?.end_date || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Hours / Week</label>
                    <input class="form-input" type="number" step="0.25" name="approved_hours_per_week" value="${auth?.approved_hours_per_week || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Total Approved Hours</label>
                    <input class="form-input" type="number" step="0.25" name="total_approved_hours" value="${auth?.total_approved_hours || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Used Hours</label>
                    <input class="form-input" type="number" step="0.25" name="used_hours" value="${auth?.used_hours || 0}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Service Type</label>
                    <input class="form-input" name="service_type" value="${auth?.service_type || ''}" placeholder="e.g. initial_assessment, direct_therapy">
                </div>
                <div class="form-group">
                    <label class="form-label">Approved Units (Total, optional)</label>
                    <input class="form-input" type="number" name="approved_units" value="${auth?.approved_units || ''}">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">CPT Codes (comma-separated)</label>
                <input class="form-input" name="cpt_codes" value="${(auth?.cpt_codes || []).join(', ')}" placeholder="e.g. 97153, 97155, 97156">
            </div>
            <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" name="notes" rows="3">${auth?.notes || ''}</textarea>
            </div>
        </form>
    `;

    const footerHTML = `
        ${isEdit ? '<button class="btn btn-danger" id="auth-delete">Delete</button>' : ''}
        <button class="btn btn-secondary" id="auth-cancel">Cancel</button>
        <button class="btn btn-primary" id="auth-save">Save</button>
    `;

    createModal('auth-modal', isEdit ? 'Edit Authorization' : 'Add Authorization', bodyHTML, footerHTML);
    openModal('auth-modal');

    document.getElementById('auth-cancel').addEventListener('click', () => closeModal('auth-modal'));

    if (isEdit) {
        document.getElementById('auth-delete').addEventListener('click', async () => {
            const ok = await confirmDialog('Delete this authorization? This cannot be undone.');
            if (!ok) return;
            const { error } = await supabase.from('authorizations').delete().eq('id', auth.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Authorization deleted.', 'success');
            closeModal('auth-modal');
            load();
        });
    }

    document.getElementById('auth-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('auth-form'));
        const cptRaw = fd.get('cpt_codes').trim();

        const record = {
            client_id: fd.get('client_id') || null,
            payer_id: fd.get('payer_id') || null,
            auth_number: fd.get('auth_number').trim(),
            status: fd.get('status'),
            start_date: fd.get('start_date'),
            end_date: fd.get('end_date'),
            approved_units: fd.get('approved_units') ? parseInt(fd.get('approved_units')) : null,
            approved_hours_per_week: fd.get('approved_hours_per_week') ? parseFloat(fd.get('approved_hours_per_week')) : null,
            total_approved_hours: fd.get('total_approved_hours') ? parseFloat(fd.get('total_approved_hours')) : null,
            used_hours: fd.get('used_hours') ? parseFloat(fd.get('used_hours')) : 0,
            service_type: fd.get('service_type').trim() || null,
            cpt_codes: cptRaw ? cptRaw.split(',').map(c => c.trim()).filter(Boolean) : [],
            notes: fd.get('notes').trim() || null,
            source: auth?.source || 'manual'
        };

        if (!record.client_id || !record.payer_id || !record.auth_number || !record.start_date || !record.end_date) {
            showToast('Client, payer, auth number, and dates are required.', 'error');
            return;
        }

        if (isEdit) {
            const { error } = await supabase.from('authorizations').update(record).eq('id', auth.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Authorization updated.', 'success');
        } else {
            const { error } = await supabase.from('authorizations').insert(record);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Authorization created.', 'success');
        }

        closeModal('auth-modal');
        load();
    });
}

init();
