import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { showToast, createModal, openModal, closeModal, formatDate, statusBadge, confirmDialog } from './ui.js';

let currentTab = 'requests';
let allAuths = [];
let clients = [];
let payers = [];
let bcbas = [];  // Active BCBAs with NPI (eligible to be listed on an auth request)

async function init() {
    const auth = await requireAuth(['admin', 'billing']);
    if (!auth) return;
    renderNav();

    const [clientsRes, payersRes, bcbasRes] = await Promise.all([
        supabase.from('clients').select('id, first_name, last_name, cr_client_id, insurance_payer_id').eq('is_active', true).order('last_name'),
        supabase.from('insurance_payers').select('id, name').eq('is_active', true).order('name'),
        supabase.from('staff')
            .select('id, first_name, last_name, credential, npi, licensed_states, credentialed_payer_ids')
            .eq('is_active', true)
            .in('credential', ['BCBA', 'BCaBA'])
            .order('last_name')
    ]);
    clients = clientsRes.data || [];
    payers = payersRes.data || [];
    bcbas = bcbasRes.data || [];

    for (const p of payers) {
        document.getElementById('filter-payer').innerHTML += `<option value="${p.id}">${p.name}</option>`;
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTab = btn.dataset.tab;
            render();
        });
    });

    document.getElementById('filter-client').addEventListener('input', render);
    document.getElementById('filter-payer').addEventListener('change', render);
    document.getElementById('filter-util').addEventListener('change', render);

    document.getElementById('refresh-btn').addEventListener('click', load);
    document.getElementById('add-auth-btn').addEventListener('click', () => openAuthForm(null, 'existing'));
    document.getElementById('request-auth-btn').addEventListener('click', () => openAuthForm(null, 'request'));
    document.getElementById('backfill-btn').addEventListener('click', runBackfill);

    await load();

    // If navigated here from a BV, pre-fill an auth request
    const params = new URLSearchParams(window.location.search);
    const fromBV = params.get('fromBV');
    if (fromBV) {
        await openAuthRequestFromBV(fromBV);
        // Clean URL so refreshing doesn't re-open
        window.history.replaceState({}, '', 'authorizations.html');
    }
}

async function openAuthRequestFromBV(bvId) {
    const { data: bv, error } = await supabase
        .from('benefit_verifications')
        .select(`
            *,
            clients(id, first_name, last_name, cr_client_id, insurance_member_id),
            insurance_payers(id, name)
        `)
        .eq('id', bvId)
        .single();

    if (error || !bv) {
        showToast('Could not load benefits verification', 'error');
        return;
    }

    // Build a synthetic "prefill" object shaped like an auth
    const prefill = {
        client_id: bv.client_id,
        payer_id: bv.payer_id,
        cpt_codes: bv.cpt_codes_covered || [],
        request_submission_method: bv.auth_submission_method || '',
        // Pre-fill notes with the BV context
        request_notes: buildBVContextNote(bv),
        _fromBV: bv
    };

    openAuthForm(prefill, 'request', true /* prefillOnly, not a real edit */);
}

function buildBVContextNote(bv) {
    const client = bv.clients ? `${bv.clients.first_name} ${bv.clients.last_name}` : '';
    const payer = bv.insurance_payers?.name || '';
    const memberId = bv.clients?.insurance_member_id || '';

    let note = `--- Context from Benefits Verification ---\n`;
    note += `Client: ${client}\nPayer: ${payer}${memberId ? ' (Member ID: ' + memberId + ')' : ''}\n`;
    if (bv.network_status) note += `Network: ${bv.network_status.toUpperCase()}\n`;
    if (bv.auth_contact_phone) note += `Auth contact phone: ${bv.auth_contact_phone}\n`;
    if (bv.auth_contact_notes) note += `Auth contact notes: ${bv.auth_contact_notes}\n`;
    note += `--------------------------------------\n\n`;
    return note;
}

async function runBackfill() {
    const btn = document.getElementById('backfill-btn');
    btn.disabled = true;
    btn.textContent = 'Syncing...';

    try {
        const res = await fetch('/.netlify/functions/backfill-authorizations');
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'Sync failed');

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
    const { data: auths } = await supabase
        .from('authorizations')
        .select(`
            *,
            clients(id, first_name, last_name, cr_client_id),
            insurance_payers(id, name)
        `)
        .order('end_date', { ascending: true, nullsFirst: false });

    const enriched = [];
    for (const a of (auths || [])) {
        let usedUnits = 0;
        let usedHours = parseFloat(a.used_hours) || 0;

        if (!a.used_hours && a.client_id && a.cpt_codes?.length) {
            const { data: claims } = await supabase
                .from('claims')
                .select('units')
                .eq('client_id', a.client_id)
                .in('cpt_code', a.cpt_codes)
                .gte('service_date', a.start_date || '1900-01-01')
                .lte('service_date', a.end_date || '2099-12-31');
            usedUnits = (claims || []).reduce((sum, c) => sum + parseFloat(c.units || 0), 0);
            usedHours = usedUnits / 4;
        }

        let utilization = 0;
        if (a.total_approved_hours && a.total_approved_hours > 0) {
            utilization = Math.min(100, Math.round(usedHours / parseFloat(a.total_approved_hours) * 100));
        } else if (a.approved_units > 0) {
            utilization = Math.min(100, Math.round(usedUnits / a.approved_units * 100));
        }

        const now = new Date();
        const end = a.end_date ? new Date(a.end_date) : null;
        const daysLeft = end ? Math.floor((end - now) / (1000 * 60 * 60 * 24)) : null;
        const daysWaiting = a.request_date
            ? Math.floor((now - new Date(a.request_date)) / (1000 * 60 * 60 * 24))
            : null;

        let computedStatus = a.status;
        if (a.status === 'active' && end) {
            if (daysLeft < 0) computedStatus = 'expired';
            else if (daysLeft <= 30) computedStatus = 'expiring';
        }

        enriched.push({
            ...a,
            used_units: usedUnits,
            used_hours: usedHours,
            utilization_pct: utilization,
            days_left: daysLeft,
            days_waiting: daysWaiting,
            computed_status: computedStatus,
            client_name: a.clients ? `${a.clients.last_name}, ${a.clients.first_name}` : '(Unknown)',
            payer_name: a.insurance_payers?.name || '(Unknown)',
            cr_client_id: a.clients?.cr_client_id || null
        });
    }

    allAuths = enriched;
    updateKPIs();
    render();
}

function updateKPIs() {
    const pending = allAuths.filter(a => ['requested', 'in_review'].includes(a.status)).length;
    const active = allAuths.filter(a => a.computed_status === 'active').length;
    const expiring = allAuths.filter(a => a.computed_status === 'expiring').length;
    const expired = allAuths.filter(a => a.computed_status === 'expired').length;

    document.getElementById('kpi-pending').textContent = pending;
    document.getElementById('kpi-active').textContent = active;
    document.getElementById('kpi-expiring').textContent = expiring;
    document.getElementById('kpi-expired').textContent = expired;
}

function render() {
    const list = document.getElementById('auth-list');
    const clientFilter = document.getElementById('filter-client').value.toLowerCase();
    const payerFilter = document.getElementById('filter-payer').value;
    const utilFilter = document.getElementById('filter-util').value;

    let filtered = [...allAuths];

    if (currentTab === 'requests') filtered = filtered.filter(a => ['requested', 'in_review'].includes(a.status));
    else if (currentTab === 'active') filtered = filtered.filter(a => a.computed_status === 'active');
    else if (currentTab === 'expiring') filtered = filtered.filter(a => a.computed_status === 'expiring');
    else if (currentTab === 'expired') filtered = filtered.filter(a => a.computed_status === 'expired');

    if (clientFilter) filtered = filtered.filter(a => a.client_name.toLowerCase().includes(clientFilter));
    if (payerFilter) filtered = filtered.filter(a => a.payer_id === payerFilter);
    if (utilFilter === 'high') filtered = filtered.filter(a => a.utilization_pct >= 75);
    else if (utilFilter === 'exhausted') filtered = filtered.filter(a => a.utilization_pct >= 90);
    else if (utilFilter === 'low') filtered = filtered.filter(a => a.utilization_pct < 25);

    // Sort requests by oldest first (longest waiting), others by end_date
    if (currentTab === 'requests') {
        filtered.sort((a, b) => (b.days_waiting || 0) - (a.days_waiting || 0));
    }

    if (filtered.length === 0) {
        list.innerHTML = `<div class="empty-state"><h3>No authorizations</h3><p>No auths match these filters.</p></div>`;
        return;
    }

    let html = '';
    for (const a of filtered) {
        html += a.status === 'requested' || a.status === 'in_review'
            ? renderRequestCard(a)
            : renderApprovedCard(a);
    }
    list.innerHTML = html;

    list.querySelectorAll('[data-auth-id]').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('.card-action')) return;
            const a = allAuths.find(x => x.id === card.dataset.authId);
            if (a) openAuthForm(a, a.status === 'requested' || a.status === 'in_review' ? 'request' : 'existing');
        });
    });

    list.querySelectorAll('.approve-auth').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const a = allAuths.find(x => x.id === btn.dataset.id);
            if (a) openAuthForm(a, 'approval');
        });
    });

    list.querySelectorAll('.push-auth').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await pushToCRM(btn.dataset.id);
        });
    });
}

function renderRequestCard(a) {
    const waitingText = a.days_waiting !== null
        ? a.days_waiting > 14
            ? `<span class="text-danger font-bold">${a.days_waiting} days waiting</span>`
            : a.days_waiting > 7
            ? `<span class="text-warning">${a.days_waiting} days waiting</span>`
            : `<span class="text-muted">${a.days_waiting} days waiting</span>`
        : '<span class="text-muted">No request date</span>';

    const followUpText = a.request_follow_up_date
        ? new Date(a.request_follow_up_date) <= new Date()
            ? `<span class="text-danger font-bold">📅 Follow up due ${formatDate(a.request_follow_up_date)}</span>`
            : `<span>📅 Follow up ${formatDate(a.request_follow_up_date)}</span>`
        : '';

    const pushBadge = a.crm_push_status === 'pushed'
        ? '<span class="badge badge-success text-xs">✓ CRM</span>'
        : '';

    return `<div class="card mb-2" style="cursor:pointer;border-left:4px solid var(--color-warning);" data-auth-id="${a.id}">
        <div class="flex-between mb-1">
            <div>
                <strong>${a.client_name}</strong>
                <span class="badge badge-warning">${a.status.replace('_', ' ')}</span>
                ${pushBadge}
            </div>
            <div class="text-right">
                <div class="text-sm">${a.payer_name}</div>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));gap:16px;font-size:0.85rem;margin-bottom:8px;">
            <div>
                <div class="text-xs text-muted">Requested</div>
                <div>${a.request_date ? formatDate(a.request_date.split('T')[0]) : '—'}</div>
            </div>
            <div>
                <div class="text-xs text-muted">Reference #</div>
                <div class="font-mono">${a.request_reference_number || '—'}</div>
            </div>
            <div>
                <div class="text-xs text-muted">Method</div>
                <div>${a.request_submission_method || '—'}</div>
            </div>
            <div>
                <div class="text-xs text-muted">BCBA</div>
                <div>${getBCBAName(a.requesting_bcba_id)}${a.requesting_bcba_npi ? '<div class="text-xs font-mono text-muted">NPI: ' + a.requesting_bcba_npi + '</div>' : ''}</div>
            </div>
            <div>
                <div class="text-xs text-muted">Rep</div>
                <div>${a.request_representative || '—'}</div>
            </div>
            <div>
                <div class="text-xs text-muted">Waiting</div>
                <div>${waitingText}</div>
            </div>
        </div>
        ${followUpText ? `<div class="text-sm mb-1">${followUpText}</div>` : ''}
        ${a.request_notes ? `<div class="text-xs text-muted" style="border-top:1px dashed var(--color-border);padding-top:6px;margin-top:6px;">📞 ${escapeHtml(a.request_notes.substring(0, 200))}${a.request_notes.length > 200 ? '...' : ''}</div>` : ''}
        <div style="display:flex;gap:8px;margin-top:10px;">
            <button class="btn btn-sm btn-success card-action approve-auth" data-id="${a.id}">✓ Record Approval</button>
            <button class="btn btn-sm btn-secondary card-action push-auth" data-id="${a.id}">Push to CRM</button>
        </div>
    </div>`;
}

function renderApprovedCard(a) {
    const utilClass = a.utilization_pct >= 90 ? 'util-danger' : a.utilization_pct >= 75 ? 'util-warning' : '';
    const statusColor = a.computed_status === 'expired' ? 'badge-danger' : a.computed_status === 'expiring' ? 'badge-warning' : 'badge-success';
    const daysText = a.days_left === null ? '' : a.days_left < 0
        ? `<span class="text-danger font-bold">Expired ${Math.abs(a.days_left)} days ago</span>`
        : a.days_left <= 30
        ? `<span class="text-warning">${a.days_left} days left</span>`
        : `<span class="text-muted">${a.days_left} days left</span>`;

    let utilizationLine = '';
    if (a.total_approved_hours) {
        utilizationLine = `<strong>${a.used_hours.toFixed(1)}</strong> / ${a.total_approved_hours} hours (${a.utilization_pct}%)`;
    } else if (a.approved_units) {
        utilizationLine = `<strong>${a.used_units}</strong> / ${a.approved_units} units (${a.utilization_pct}%)`;
    } else {
        utilizationLine = `<span class="text-muted">No total specified</span>`;
    }

    const sourceTag = a.source === 'archways-crm' ? '<span class="badge badge-info text-xs">🔄 CRM</span>' : '';
    const pushBadge = a.crm_push_status === 'pushed' ? '<span class="badge badge-success text-xs">✓ CRM</span>' : '';

    return `<div class="card mb-2" style="cursor:pointer;" data-auth-id="${a.id}">
        <div class="flex-between mb-1">
            <div>
                <strong>${a.client_name}</strong>
                <span class="badge ${statusColor}">${a.computed_status}</span>
                ${sourceTag}
                ${pushBadge}
                ${a.service_type ? `<span class="badge badge-secondary">${a.service_type.replace(/_/g, ' ')}</span>` : ''}
            </div>
            <div class="text-right">
                <div class="font-mono text-sm">#${a.auth_number || '—'}</div>
                <div class="text-xs text-muted">${a.payer_name}</div>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:16px;font-size:0.85rem;margin-bottom:8px;">
            <div>
                <div class="text-xs text-muted">Effective</div>
                <div>${a.start_date ? formatDate(a.start_date) : '—'} – ${a.end_date ? formatDate(a.end_date) : '—'}</div>
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
        <div style="display:flex;gap:8px;margin-top:10px;">
            <button class="btn btn-sm btn-secondary card-action push-auth" data-id="${a.id}">Push to CRM</button>
        </div>
    </div>`;
}

async function pushToCRM(authId) {
    const btn = document.querySelector(`[data-id="${authId}"].push-auth`);
    if (btn) { btn.disabled = true; btn.textContent = 'Pushing...'; }

    try {
        const res = await fetch('/.netlify/functions/push-authorization-to-crm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authorization_id: authId })
        });
        const result = await res.json();
        if (result.ok) {
            showToast('Pushed to CRM.', 'success');
            await load();
        } else {
            showToast('Push failed: ' + (result.error || 'unknown'), 'error', 8000);
        }
    } catch (err) {
        showToast('Push failed: ' + err.message, 'error');
    }

    if (btn) { btn.disabled = false; btn.textContent = 'Push to CRM'; }
}

function openAuthForm(auth = null, mode = 'request', prefillOnly = false) {
    // mode can be: 'request' (new or edit request), 'approval' (record approval on existing request), 'existing' (add or edit fully-approved auth)
    // prefillOnly = true means auth is just pre-fill data (from BV), not a real saved record
    const isEdit = !!auth && !prefillOnly;
    const isRequestMode = mode === 'request';
    const isApprovalMode = mode === 'approval';
    const isExistingMode = mode === 'existing';

    const clientOpts = clients.map(c =>
        `<option value="${c.id}" ${auth?.client_id === c.id ? 'selected' : ''} data-payer="${c.insurance_payer_id || ''}">${c.last_name}, ${c.first_name}</option>`
    ).join('');
    const payerOpts = payers.map(p =>
        `<option value="${p.id}" ${auth?.payer_id === p.id ? 'selected' : ''}>${p.name}</option>`
    ).join('');

    // BCBAs with NPI (can be listed on an auth)
    const eligibleBCBAs = bcbas.filter(b => b.npi);
    const bcbasWithoutNpi = bcbas.filter(b => !b.npi);
    const bcbaOpts = eligibleBCBAs.map(b => {
        const cred = b.credential || '';
        const label = `${b.last_name}, ${b.first_name} (${cred}) — NPI ${b.npi}`;
        return `<option value="${b.id}" data-npi="${b.npi || ''}" ${auth?.requesting_bcba_id === b.id ? 'selected' : ''}>${label}</option>`;
    }).join('');

    // Warning line if some BCBAs don't have NPI set
    const noNpiWarning = bcbasWithoutNpi.length > 0
        ? `<div class="text-xs text-warning mt-1">⚠️ ${bcbasWithoutNpi.length} BCBA${bcbasWithoutNpi.length > 1 ? 's are' : ' is'} hidden because they don't have an NPI on file: ${bcbasWithoutNpi.map(b => b.first_name + ' ' + b.last_name).join(', ')}. Add their NPI on the Staff page to use them.</div>`
        : '';

    const title = isApprovalMode ? '✓ Record Auth Approval' :
                  isRequestMode && isEdit ? 'Edit Auth Request' :
                  isRequestMode && prefillOnly ? '📞 Request Auth (from Benefits Verification)' :
                  isRequestMode ? '📞 Log Auth Request Call' :
                  isEdit ? 'Edit Authorization' : 'Add Existing Authorization';

    const prefillBanner = prefillOnly && auth?._fromBV ? `
        <div class="card mb-2" style="background:var(--color-info-light);border-left:4px solid var(--color-info);">
            <p class="text-sm mb-0"><strong>💡 Pre-filled from Benefits Verification</strong></p>
            <p class="text-xs text-muted mb-0">Client, payer, CPT codes, and submission method are auto-populated. Confirm the Request Date and add the Reference # when you call.</p>
        </div>
    ` : '';

    // Request section (shown in request mode OR approval mode where it's already filled)
    const requestSection = !isExistingMode ? `
        <div class="card mb-2" ${isApprovalMode ? 'style="background:var(--color-bg);"' : ''}>
            <h4 class="mb-1" style="font-size:0.9rem;">📞 Request Call</h4>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Client *</label>
                    <select class="form-select" name="client_id" required ${isEdit ? 'disabled' : ''}>
                        <option value="">— Select —</option>
                        ${clientOpts}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Payer *</label>
                    <select class="form-select" name="payer_id" required>
                        <option value="">— Select —</option>
                        ${payerOpts}
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Request Date/Time *</label>
                    <input class="form-input" type="datetime-local" name="request_date" ${!isApprovalMode ? 'required' : ''}
                        value="${auth?.request_date ? auth.request_date.slice(0, 16) : new Date().toISOString().slice(0, 16)}">
                </div>
                <div class="form-group">
                    <label class="form-label">Submission Method *</label>
                    <select class="form-select" name="request_submission_method" ${!isApprovalMode ? 'required' : ''}>
                        <option value="">— Select —</option>
                        <option value="availity" ${auth?.request_submission_method === 'availity' ? 'selected' : ''}>Availity</option>
                        <option value="phone" ${auth?.request_submission_method === 'phone' ? 'selected' : ''}>Phone</option>
                        <option value="fax" ${auth?.request_submission_method === 'fax' ? 'selected' : ''}>Fax</option>
                        <option value="online_portal" ${auth?.request_submission_method === 'online_portal' ? 'selected' : ''}>Online Portal</option>
                        <option value="other" ${auth?.request_submission_method === 'other' ? 'selected' : ''}>Other</option>
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Reference / Confirmation #</label>
                    <input class="form-input" name="request_reference_number" value="${auth?.request_reference_number || ''}" placeholder="Their tracking number">
                </div>
                <div class="form-group">
                    <label class="form-label">Rep Name</label>
                    <input class="form-input" name="request_representative" value="${auth?.request_representative || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Rep ID</label>
                    <input class="form-input" name="request_representative_id" value="${auth?.request_representative_id || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Follow-up Date</label>
                    <input class="form-input" type="date" name="request_follow_up_date" value="${auth?.request_follow_up_date || ''}">
                    <span class="text-xs text-muted">When to check back if no response</span>
                </div>
                <div class="form-group">
                    <label class="form-label">CPT Codes Requested (comma-separated)</label>
                    <input class="form-input" name="cpt_codes" value="${(auth?.cpt_codes || []).join(', ')}" placeholder="e.g. 97153, 97155">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group" style="grid-column: 1 / -1;">
                    <label class="form-label">Requesting BCBA *</label>
                    <select class="form-select" name="requesting_bcba_id" id="bcba-select" required>
                        <option value="">— Select BCBA —</option>
                        ${bcbaOpts}
                    </select>
                    <div class="flex gap-1 mt-1" style="align-items:center;">
                        <span class="text-xs text-muted">NPI:</span>
                        <input class="form-input" type="text" id="bcba-npi-display" readonly value="${auth?.requesting_bcba_npi || ''}" placeholder="Auto-filled from BCBA selection" style="background:#f9f9f9;font-family:var(--font-mono);flex:1;max-width:200px;">
                    </div>
                    ${noNpiWarning}
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Request Notes</label>
                <textarea class="form-textarea" name="request_notes" rows="3" placeholder="Anything from the call — who we spoke to, what docs they asked for, etc.">${auth?.request_notes || ''}</textarea>
            </div>
        </div>
    ` : '';

    // Approval section (shown in approval mode OR existing mode)
    const approvalSection = (isApprovalMode || isExistingMode) ? `
        <div class="card mb-2" ${isApprovalMode ? 'style="background:var(--color-success-light);"' : ''}>
            <h4 class="mb-1" style="font-size:0.9rem;">${isApprovalMode ? '✓ Approval Details' : 'Authorization Details'}</h4>
            ${isExistingMode ? `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Client *</label>
                        <select class="form-select" name="client_id" required>
                            <option value="">— Select —</option>
                            ${clientOpts}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Payer *</label>
                        <select class="form-select" name="payer_id" required>
                            <option value="">— Select —</option>
                            ${payerOpts}
                        </select>
                    </div>
                </div>
            ` : ''}
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Auth Number *</label>
                    <input class="form-input" name="auth_number" required value="${auth?.auth_number || ''}" placeholder="e.g. A1234567">
                </div>
                <div class="form-group">
                    <label class="form-label">Decision Date</label>
                    <input class="form-input" type="date" name="decision_date" value="${auth?.decision_date || new Date().toISOString().split('T')[0]}">
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
                    <label class="form-label">Service Type</label>
                    <input class="form-input" name="service_type" value="${auth?.service_type || ''}" placeholder="e.g. direct_therapy">
                </div>
            </div>
            ${!isApprovalMode ? `
                <div class="form-group">
                    <label class="form-label">CPT Codes (comma-separated)</label>
                    <input class="form-input" name="cpt_codes_approval" value="${(auth?.cpt_codes || []).join(', ')}" placeholder="e.g. 97153, 97155">
                </div>
                <div class="form-row">
                    <div class="form-group" style="grid-column: 1 / -1;">
                        <label class="form-label">Requesting BCBA *</label>
                        <select class="form-select" name="requesting_bcba_id_existing" required>
                            <option value="">— Select BCBA —</option>
                            ${bcbaOpts}
                        </select>
                        <div class="flex gap-1 mt-1" style="align-items:center;">
                            <span class="text-xs text-muted">NPI:</span>
                            <input class="form-input" type="text" id="bcba-npi-display-existing" readonly value="${auth?.requesting_bcba_npi || ''}" placeholder="Auto-filled" style="background:#f9f9f9;font-family:var(--font-mono);flex:1;max-width:200px;">
                        </div>
                        ${noNpiWarning}
                    </div>
                </div>
            ` : ''}
            <div class="form-group">
                <label class="form-label">Decision Notes</label>
                <textarea class="form-textarea" name="decision_notes" rows="2">${auth?.decision_notes || ''}</textarea>
            </div>
        </div>
    ` : '';

    // Notes
    const notesSection = `
        <div class="form-group">
            <label class="form-label">General Notes</label>
            <textarea class="form-textarea" name="notes" rows="2">${auth?.notes || ''}</textarea>
        </div>
    `;

    const bodyHTML = `<form id="auth-form">${prefillBanner}${requestSection}${approvalSection}${notesSection}</form>`;

    const footerHTML = `
        ${isEdit ? '<button class="btn btn-danger" id="auth-delete">Delete</button>' : ''}
        <button class="btn btn-secondary" id="auth-cancel">Cancel</button>
        <button class="btn btn-primary" id="auth-save">
            ${isApprovalMode ? 'Save Approval' :
              isRequestMode && !isEdit ? 'Log Request' :
              isRequestMode ? 'Save Changes' :
              'Save'}
        </button>
    `;

    createModal('auth-modal', title, bodyHTML, footerHTML, 'modal-lg');
    openModal('auth-modal');

    // Auto-fill NPI when BCBA is selected (request mode)
    const bcbaSelect = document.getElementById('bcba-select');
    if (bcbaSelect) {
        bcbaSelect.addEventListener('change', (e) => {
            const opt = e.target.selectedOptions[0];
            document.getElementById('bcba-npi-display').value = opt?.dataset?.npi || '';
        });
    }
    // Same for existing-mode
    const bcbaSelectExisting = document.querySelector('[name="requesting_bcba_id_existing"]');
    if (bcbaSelectExisting) {
        // Pre-select if auth already has a BCBA
        if (auth?.requesting_bcba_id) bcbaSelectExisting.value = auth.requesting_bcba_id;
        bcbaSelectExisting.addEventListener('change', (e) => {
            const opt = e.target.selectedOptions[0];
            document.getElementById('bcba-npi-display-existing').value = opt?.dataset?.npi || '';
        });
    }

    document.getElementById('auth-cancel').addEventListener('click', () => closeModal('auth-modal'));

    if (isEdit) {
        document.getElementById('auth-delete').addEventListener('click', async () => {
            const ok = await confirmDialog('Delete this authorization? This cannot be undone.');
            if (!ok) return;
            const { error } = await supabase.from('authorizations').delete().eq('id', auth.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Deleted.', 'success');
            closeModal('auth-modal');
            load();
        });
    }

    document.getElementById('auth-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('auth-form'));
        const record = {
            source: auth?.source || 'manual'
        };

        // Client/payer handling (may be disabled in edit mode for requests)
        if (!isEdit || isExistingMode) {
            record.client_id = fd.get('client_id') || null;
            record.payer_id = fd.get('payer_id') || null;
        }

        // Request fields
        if (!isExistingMode) {
            if (fd.get('request_date')) record.request_date = new Date(fd.get('request_date')).toISOString();
            record.request_submission_method = fd.get('request_submission_method') || null;
            record.request_reference_number = (fd.get('request_reference_number') || '').trim() || null;
            record.request_representative = (fd.get('request_representative') || '').trim() || null;
            record.request_representative_id = (fd.get('request_representative_id') || '').trim() || null;
            record.request_follow_up_date = fd.get('request_follow_up_date') || null;
            record.request_notes = (fd.get('request_notes') || '').trim() || null;

            const cptReq = (fd.get('cpt_codes') || '').trim();
            if (cptReq) record.cpt_codes = cptReq.split(',').map(c => c.trim()).filter(Boolean);

            // BCBA requirement
            const bcbaId = fd.get('requesting_bcba_id');
            if (!bcbaId) {
                showToast('A requesting BCBA is required on all auth requests.', 'error');
                return;
            }
            const bcba = bcbas.find(b => b.id === bcbaId);
            if (!bcba) {
                showToast('Selected BCBA not found.', 'error');
                return;
            }
            if (!bcba.npi) {
                showToast('Selected BCBA has no NPI on file. Add it on the Staff page first.', 'error');
                return;
            }
            record.requesting_bcba_id = bcbaId;
            record.requesting_bcba_npi = bcba.npi;
        }

        // Approval fields
        if (isApprovalMode || isExistingMode) {
            record.auth_number = (fd.get('auth_number') || '').trim();
            if (!record.auth_number) {
                showToast('Auth number is required.', 'error');
                return;
            }
            record.decision_date = fd.get('decision_date') || null;
            record.start_date = fd.get('start_date') || null;
            record.end_date = fd.get('end_date') || null;
            record.approved_hours_per_week = fd.get('approved_hours_per_week') ? parseFloat(fd.get('approved_hours_per_week')) : null;
            record.total_approved_hours = fd.get('total_approved_hours') ? parseFloat(fd.get('total_approved_hours')) : null;
            record.service_type = (fd.get('service_type') || '').trim() || null;
            record.decision_notes = (fd.get('decision_notes') || '').trim() || null;
            record.status = 'approved';

            if (isExistingMode) {
                const cptApp = (fd.get('cpt_codes_approval') || '').trim();
                if (cptApp) record.cpt_codes = cptApp.split(',').map(c => c.trim()).filter(Boolean);

                // BCBA required in existing mode too
                const bcbaIdExisting = fd.get('requesting_bcba_id_existing');
                if (!bcbaIdExisting) {
                    showToast('A requesting BCBA is required.', 'error');
                    return;
                }
                const bcbaEx = bcbas.find(b => b.id === bcbaIdExisting);
                if (!bcbaEx) { showToast('Selected BCBA not found.', 'error'); return; }
                if (!bcbaEx.npi) {
                    showToast('Selected BCBA has no NPI on file. Add it on the Staff page first.', 'error');
                    return;
                }
                record.requesting_bcba_id = bcbaIdExisting;
                record.requesting_bcba_npi = bcbaEx.npi;
            }
        } else if (isRequestMode) {
            // If editing a request, keep status as 'requested' unless already in_review
            if (!isEdit) record.status = 'requested';
        }

        record.notes = (fd.get('notes') || '').trim() || null;

        // Basic validation
        if (record.client_id === undefined && !auth) {
            showToast('Client is required.', 'error');
            return;
        }

        try {
            let savedAuthId;

            if (isEdit) {
                const { error } = await supabase.from('authorizations').update(record).eq('id', auth.id);
                if (error) throw error;
                savedAuthId = auth.id;
                showToast(isApprovalMode ? 'Approval recorded.' : 'Updated.', 'success');
            } else {
                const { data, error } = await supabase.from('authorizations').insert(record).select().single();
                if (error) throw error;
                savedAuthId = data.id;
                showToast(isRequestMode ? 'Request logged.' : 'Authorization added.', 'success');
            }

            closeModal('auth-modal');
            await load();

            // Offer to push to CRM
            const shouldPush = await confirmDialog('Push this to the CRM now?', 'Push to CRM');
            if (shouldPush) {
                await pushToCRM(savedAuthId);
            }
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
        }
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getBCBAName(bcbaId) {
    if (!bcbaId) return '—';
    const b = bcbas.find(x => x.id === bcbaId);
    return b ? `${b.first_name} ${b.last_name}` : '—';
}

init();
