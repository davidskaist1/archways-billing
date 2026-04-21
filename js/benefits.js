import { requireAuth, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { showToast, createModal, openModal, closeModal, formatCurrency, formatDate, statusBadge, confirmDialog } from './ui.js';

let currentTab = 'queue';
let allBVs = [];
let clients = [];
let payers = [];

async function init() {
    const auth = await requireAuth(['admin', 'billing']);
    if (!auth) return;
    renderNav();

    const [cd, pd] = await Promise.all([
        supabase.from('clients').select('id, first_name, last_name, date_of_birth, insurance_member_id, insurance_payer_id').eq('is_active', true).order('last_name'),
        supabase.from('insurance_payers').select('id, name').eq('is_active', true).order('name')
    ]);
    clients = cd.data || [];
    payers = pd.data || [];

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

    document.getElementById('refresh-btn').addEventListener('click', load);
    document.getElementById('add-bv-btn').addEventListener('click', () => openBVForm());

    await load();
}

async function load() {
    const { data, error } = await supabase
        .from('benefit_verifications')
        .select(`
            *,
            clients(id, first_name, last_name, date_of_birth, insurance_member_id, cr_client_id),
            insurance_payers(id, name)
        `)
        .order('created_at', { ascending: false });

    if (error) { showToast('Failed: ' + error.message, 'error'); return; }

    allBVs = (data || []).map(b => ({
        ...b,
        client_name: b.clients ? `${b.clients.last_name}, ${b.clients.first_name}` : '(Unknown)',
        payer_name: b.insurance_payers?.name || '(Unknown)',
        member_id: b.clients?.insurance_member_id || '',
        cr_client_id: b.clients?.cr_client_id || ''
    }));

    updateKPIs();
    render();
}

function updateKPIs() {
    const pending = allBVs.filter(b => b.status === 'pending').length;
    const inProgress = allBVs.filter(b => b.status === 'in_progress').length;

    const monthStart = new Date();
    monthStart.setDate(1);
    const completed = allBVs.filter(b => b.status === 'completed' && new Date(b.updated_at) >= monthStart).length;

    const pushed = allBVs.filter(b => b.crm_push_status === 'pushed').length;

    document.getElementById('kpi-pending').textContent = pending;
    document.getElementById('kpi-inprogress').textContent = inProgress;
    document.getElementById('kpi-completed').textContent = completed;
    document.getElementById('kpi-pushed').textContent = pushed;
}

function render() {
    const list = document.getElementById('bv-list');
    const clientFilter = document.getElementById('filter-client').value.toLowerCase();
    const payerFilter = document.getElementById('filter-payer').value;

    let filtered = [...allBVs];
    if (currentTab === 'queue') filtered = filtered.filter(b => ['pending', 'in_progress'].includes(b.status));
    else if (currentTab === 'completed') filtered = filtered.filter(b => b.status === 'completed');

    if (clientFilter) filtered = filtered.filter(b => b.client_name.toLowerCase().includes(clientFilter));
    if (payerFilter) filtered = filtered.filter(b => b.payer_id === payerFilter);

    if (filtered.length === 0) {
        list.innerHTML = `<div class="empty-state"><h3>Nothing here</h3><p>No verifications match these filters.</p></div>`;
        return;
    }

    let html = '';
    for (const bv of filtered) {
        const statusColor = bv.status === 'completed' ? 'badge-success' :
                          bv.status === 'in_progress' ? 'badge-warning' :
                          bv.status === 'pending' ? 'badge-info' : 'badge-secondary';

        const pushBadge = bv.crm_push_status === 'pushed'
            ? '<span class="badge badge-success text-xs">✓ CRM</span>'
            : bv.status === 'completed' && bv.crm_push_status !== 'pushed'
            ? '<span class="badge badge-warning text-xs">Needs CRM push</span>'
            : '';

        const networkBadge = bv.network_status
            ? `<span class="badge ${bv.network_status === 'inn' ? 'badge-success' : 'badge-warning'}">${bv.network_status.toUpperCase()}</span>`
            : '';

        const summary = bv.status === 'completed' || bv.status === 'in_progress'
            ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;font-size:0.85rem;margin-top:8px;">
                ${bv.individual_deductible !== null ? `<div><div class="text-xs text-muted">Deductible</div><div>${formatCurrency(bv.individual_deductible || 0)} <span class="text-muted">/ ${formatCurrency(bv.individual_deductible_met || 0)} met</span></div></div>` : ''}
                ${bv.after_deductible_type === 'copay' && bv.copay_amount ? `<div><div class="text-xs text-muted">Copay</div><div>${formatCurrency(bv.copay_amount)}</div></div>` : ''}
                ${bv.after_deductible_type === 'coinsurance' && bv.coinsurance_percent ? `<div><div class="text-xs text-muted">Coinsurance</div><div>${bv.coinsurance_percent}%</div></div>` : ''}
                ${bv.individual_oop_max !== null ? `<div><div class="text-xs text-muted">OOP Max</div><div>${formatCurrency(bv.individual_oop_max || 0)} <span class="text-muted">/ ${formatCurrency(bv.individual_oop_met || 0)} met</span></div></div>` : ''}
                ${bv.sca_required ? `<div><div class="text-xs text-muted">SCA</div><div>${bv.sca_status || 'Required'}</div></div>` : ''}
                ${bv.fee_schedule_percent ? `<div><div class="text-xs text-muted">Fee Schedule</div><div>${bv.fee_schedule_percent}% ${bv.fee_schedule_type === 'percent_of_medicare' ? 'of Medicare' : ''}</div></div>` : ''}
            </div>`
            : '';

        // Show "Request Auth" button if BV is completed and auth is required
        const canRequestAuth = bv.status === 'completed' && bv.auth_required;

        html += `<div class="card mb-2" data-bv-id="${bv.id}">
            <div class="flex-between mb-1" style="cursor:pointer;" data-open-bv="${bv.id}">
                <div>
                    <strong>${bv.client_name}</strong>
                    <span class="badge ${statusColor}">${bv.status.replace('_', ' ')}</span>
                    ${networkBadge}
                    ${pushBadge}
                </div>
                <div class="text-right">
                    <div class="text-sm">${bv.payer_name}</div>
                    ${bv.member_id ? `<div class="text-xs font-mono text-muted">${bv.member_id}</div>` : ''}
                </div>
            </div>
            <div style="cursor:pointer;" data-open-bv="${bv.id}">
                ${summary}
                ${bv.call_notes ? `<div class="text-xs text-muted mt-1" style="border-top:1px dashed var(--color-border);padding-top:6px;">📞 ${bv.call_notes.substring(0, 150)}${bv.call_notes.length > 150 ? '...' : ''}</div>` : ''}
            </div>
            ${canRequestAuth ? `
                <div class="mt-2" style="border-top:1px dashed var(--color-border);padding-top:10px;">
                    <button class="btn btn-sm btn-success request-auth-from-bv" data-bv-id="${bv.id}">
                        ➜ Request Auth from This BV
                    </button>
                    <span class="text-xs text-muted" style="margin-left:8px;">Opens the auth request form pre-filled with this client's info</span>
                </div>
            ` : ''}
        </div>`;
    }
    list.innerHTML = html;

    list.querySelectorAll('[data-open-bv]').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.request-auth-from-bv')) return;
            const bv = allBVs.find(b => b.id === el.dataset.openBv);
            if (bv) openBVForm(bv);
        });
    });

    list.querySelectorAll('.request-auth-from-bv').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const bvId = btn.dataset.bvId;
            // Navigate to authorizations page with the BV id as a query param
            window.location.href = `authorizations.html?fromBV=${bvId}`;
        });
    });
}

function openBVForm(bv = null) {
    const isEdit = !!bv;
    const clientOpts = clients.map(c =>
        `<option value="${c.id}" ${bv?.client_id === c.id ? 'selected' : ''} data-payer="${c.insurance_payer_id || ''}">${c.last_name}, ${c.first_name}${c.date_of_birth ? ' (DOB ' + formatDate(c.date_of_birth) + ')' : ''}</option>`
    ).join('');
    const payerOpts = payers.map(p =>
        `<option value="${p.id}" ${bv?.payer_id === p.id ? 'selected' : ''}>${p.name}</option>`
    ).join('');

    const client = bv?.clients || clients.find(c => c.id === bv?.client_id);
    const memberId = bv?.member_id || client?.insurance_member_id || '';

    const bodyHTML = `
        <form id="bv-form">
            <!-- Client & Payer Section -->
            <div class="card mb-2" style="background:var(--color-bg);">
                <h4 class="mb-1" style="font-size:0.9rem;">Client & Payer</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Client *</label>
                        <select class="form-select" name="client_id" id="bv-client" required ${isEdit ? 'disabled' : ''}>
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
                        <label class="form-label">Member ID</label>
                        <input class="form-input" id="bv-member-id" value="${memberId}" readonly style="background:#f9f9f9;">
                        <span class="text-xs text-muted">From client record</span>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Plan Year</label>
                        <input class="form-input" type="number" name="plan_year" value="${bv?.plan_year || new Date().getFullYear()}">
                    </div>
                </div>
            </div>

            <!-- Call Info Section -->
            <div class="card mb-2">
                <h4 class="mb-1" style="font-size:0.9rem;">📞 Call Details</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Call Date/Time</label>
                        <input class="form-input" type="datetime-local" name="call_date" value="${bv?.call_date ? bv.call_date.slice(0, 16) : new Date().toISOString().slice(0, 16)}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Representative Name</label>
                        <input class="form-input" name="call_representative" value="${bv?.call_representative || ''}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Rep ID</label>
                        <input class="form-input" name="call_representative_id" value="${bv?.call_representative_id || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Reference / Call #</label>
                        <input class="form-input" name="call_reference_number" value="${bv?.call_reference_number || ''}">
                    </div>
                </div>
            </div>

            <!-- 1. Network Status -->
            <div class="card mb-2">
                <h4 class="mb-1" style="font-size:0.9rem;">1. Network Status</h4>
                <div class="form-group">
                    <label class="form-label">INN or OON?</label>
                    <div style="display:flex;gap:12px;">
                        <label class="form-check" style="flex:1;">
                            <input type="radio" name="network_status" value="inn" ${bv?.network_status === 'inn' ? 'checked' : ''}>
                            <span>In-Network (INN)</span>
                        </label>
                        <label class="form-check" style="flex:1;">
                            <input type="radio" name="network_status" value="oon" ${bv?.network_status === 'oon' ? 'checked' : ''}>
                            <span>Out-of-Network (OON)</span>
                        </label>
                    </div>
                </div>
            </div>

            <!-- 2-3. Deductible -->
            <div class="card mb-2">
                <h4 class="mb-1" style="font-size:0.9rem;">2-3. Deductible</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Individual Deductible</label>
                        <input class="form-input" type="number" step="0.01" name="individual_deductible" value="${bv?.individual_deductible || ''}" placeholder="0.00">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Amount Already Met</label>
                        <input class="form-input" type="number" step="0.01" name="individual_deductible_met" value="${bv?.individual_deductible_met || ''}" placeholder="0.00">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Family Deductible</label>
                        <input class="form-input" type="number" step="0.01" name="family_deductible" value="${bv?.family_deductible || ''}" placeholder="0.00">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Family Deductible Met</label>
                        <input class="form-input" type="number" step="0.01" name="family_deductible_met" value="${bv?.family_deductible_met || ''}" placeholder="0.00">
                    </div>
                </div>
            </div>

            <!-- 4. After-Deductible Responsibility -->
            <div class="card mb-2">
                <h4 class="mb-1" style="font-size:0.9rem;">4. After Deductible</h4>
                <div class="form-group">
                    <label class="form-label">Copay or Coinsurance?</label>
                    <select class="form-select" name="after_deductible_type" id="bv-ad-type">
                        <option value="">— Select —</option>
                        <option value="none" ${bv?.after_deductible_type === 'none' ? 'selected' : ''}>None (covered 100%)</option>
                        <option value="copay" ${bv?.after_deductible_type === 'copay' ? 'selected' : ''}>Copay</option>
                        <option value="coinsurance" ${bv?.after_deductible_type === 'coinsurance' ? 'selected' : ''}>Coinsurance</option>
                        <option value="both" ${bv?.after_deductible_type === 'both' ? 'selected' : ''}>Both</option>
                    </select>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Copay Amount ($)</label>
                        <input class="form-input" type="number" step="0.01" name="copay_amount" value="${bv?.copay_amount || ''}" placeholder="0.00">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Coinsurance (%)</label>
                        <input class="form-input" type="number" step="0.01" name="coinsurance_percent" value="${bv?.coinsurance_percent || ''}" placeholder="e.g. 20 for 20%">
                    </div>
                </div>
            </div>

            <!-- 5-6. Out-of-Pocket Max -->
            <div class="card mb-2">
                <h4 class="mb-1" style="font-size:0.9rem;">5-6. Out-of-Pocket Maximum</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Individual OOP Max</label>
                        <input class="form-input" type="number" step="0.01" name="individual_oop_max" value="${bv?.individual_oop_max || ''}" placeholder="0.00">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Individual OOP Met</label>
                        <input class="form-input" type="number" step="0.01" name="individual_oop_met" value="${bv?.individual_oop_met || ''}" placeholder="0.00">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Family OOP Max</label>
                        <input class="form-input" type="number" step="0.01" name="family_oop_max" value="${bv?.family_oop_max || ''}" placeholder="0.00">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Family OOP Met</label>
                        <input class="form-input" type="number" step="0.01" name="family_oop_met" value="${bv?.family_oop_met || ''}" placeholder="0.00">
                    </div>
                </div>
            </div>

            <!-- 7. SCA -->
            <div class="card mb-2">
                <h4 class="mb-1" style="font-size:0.9rem;">7. Single-Case Agreement (SCA)</h4>
                <div class="form-group">
                    <div class="form-check">
                        <input type="checkbox" name="sca_required" id="bv-sca-req" ${bv?.sca_required ? 'checked' : ''}>
                        <label for="bv-sca-req">An SCA is required / being pursued</label>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">SCA Status</label>
                        <select class="form-select" name="sca_status">
                            <option value="">— Select —</option>
                            <option value="not_applicable" ${bv?.sca_status === 'not_applicable' ? 'selected' : ''}>Not Applicable</option>
                            <option value="not_started" ${bv?.sca_status === 'not_started' ? 'selected' : ''}>Not Started</option>
                            <option value="pending" ${bv?.sca_status === 'pending' ? 'selected' : ''}>Pending</option>
                            <option value="approved" ${bv?.sca_status === 'approved' ? 'selected' : ''}>Approved</option>
                            <option value="denied" ${bv?.sca_status === 'denied' ? 'selected' : ''}>Denied</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">SCA Notes</label>
                        <input class="form-input" name="sca_notes" value="${bv?.sca_notes || ''}" placeholder="Rate negotiated, etc.">
                    </div>
                </div>
            </div>

            <!-- 8. Fee Schedule -->
            <div class="card mb-2">
                <h4 class="mb-1" style="font-size:0.9rem;">8. Fee Schedule / Reimbursement</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Fee Schedule Type</label>
                        <select class="form-select" name="fee_schedule_type">
                            <option value="">— Select —</option>
                            <option value="fee_schedule" ${bv?.fee_schedule_type === 'fee_schedule' ? 'selected' : ''}>Contracted Fee Schedule</option>
                            <option value="percent_of_medicare" ${bv?.fee_schedule_type === 'percent_of_medicare' ? 'selected' : ''}>% of Medicare</option>
                            <option value="billed_charges" ${bv?.fee_schedule_type === 'billed_charges' ? 'selected' : ''}>Billed Charges</option>
                            <option value="u_and_c" ${bv?.fee_schedule_type === 'u_and_c' ? 'selected' : ''}>Usual & Customary</option>
                            <option value="other" ${bv?.fee_schedule_type === 'other' ? 'selected' : ''}>Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Percent (if applicable)</label>
                        <input class="form-input" type="number" step="0.01" name="fee_schedule_percent" value="${bv?.fee_schedule_percent || ''}" placeholder="e.g. 80 for 80%">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Fee Schedule Notes</label>
                    <input class="form-input" name="fee_schedule_notes" value="${bv?.fee_schedule_notes || ''}" placeholder="Additional details about reimbursement">
                </div>
            </div>

            <!-- Auth Requirements -->
            <div class="card mb-2">
                <h4 class="mb-1" style="font-size:0.9rem;">Auth Requirements</h4>
                <div class="form-group">
                    <div class="form-check">
                        <input type="checkbox" name="auth_required" id="bv-auth-req" ${bv?.auth_required ? 'checked' : ''}>
                        <label for="bv-auth-req">Prior authorization required</label>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Submission Method</label>
                        <select class="form-select" name="auth_submission_method">
                            <option value="">— Select —</option>
                            <option value="availity" ${bv?.auth_submission_method === 'availity' ? 'selected' : ''}>Availity</option>
                            <option value="fax" ${bv?.auth_submission_method === 'fax' ? 'selected' : ''}>Fax</option>
                            <option value="phone" ${bv?.auth_submission_method === 'phone' ? 'selected' : ''}>Phone</option>
                            <option value="online_portal" ${bv?.auth_submission_method === 'online_portal' ? 'selected' : ''}>Online Portal</option>
                            <option value="other" ${bv?.auth_submission_method === 'other' ? 'selected' : ''}>Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Auth Contact Phone</label>
                        <input class="form-input" name="auth_contact_phone" value="${bv?.auth_contact_phone || ''}">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">CPT Codes Covered (comma-separated)</label>
                    <input class="form-input" name="cpt_codes_covered" value="${(bv?.cpt_codes_covered || []).join(', ')}" placeholder="e.g. 97153, 97155, 97156">
                </div>
                <div class="form-group">
                    <label class="form-label">Auth Contact Notes</label>
                    <textarea class="form-textarea" name="auth_contact_notes" rows="2">${bv?.auth_contact_notes || ''}</textarea>
                </div>
            </div>

            <!-- Coverage Dates -->
            <div class="card mb-2">
                <h4 class="mb-1" style="font-size:0.9rem;">Coverage Dates</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Effective Date</label>
                        <input class="form-input" type="date" name="effective_date" value="${bv?.effective_date || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Termination Date</label>
                        <input class="form-input" type="date" name="termination_date" value="${bv?.termination_date || ''}">
                    </div>
                </div>
            </div>

            <!-- Call Notes -->
            <div class="form-group">
                <label class="form-label">Call Notes (everything else from the call)</label>
                <textarea class="form-textarea" name="call_notes" rows="4" placeholder="Anything else to remember from the call...">${bv?.call_notes || ''}</textarea>
            </div>
        </form>
    `;

    const isCompleted = bv?.status === 'completed';
    const crmPushed = bv?.crm_push_status === 'pushed';

    const footerHTML = `
        ${isEdit ? '<button class="btn btn-danger" id="bv-delete">Delete</button>' : ''}
        <button class="btn btn-secondary" id="bv-cancel">Cancel</button>
        <button class="btn btn-secondary" id="bv-save-draft">Save as Draft</button>
        <button class="btn btn-primary" id="bv-save-complete">
            ${isCompleted && crmPushed ? 'Re-Push to CRM' : isCompleted ? 'Push to CRM' : 'Complete & Push to CRM'}
        </button>
    `;

    createModal('bv-modal', isEdit ? 'Edit Benefits Verification' : 'New Benefits Verification', bodyHTML, footerHTML, 'modal-xl');
    openModal('bv-modal');

    // Auto-fill member ID and payer when client changes
    document.getElementById('bv-client').addEventListener('change', (e) => {
        const opt = e.target.selectedOptions[0];
        const client = clients.find(c => c.id === e.target.value);
        if (client) {
            document.getElementById('bv-member-id').value = client.insurance_member_id || '';
            if (client.insurance_payer_id) {
                const payerSelect = document.querySelector('[name="payer_id"]');
                if (payerSelect) payerSelect.value = client.insurance_payer_id;
            }
        }
    });

    document.getElementById('bv-cancel').addEventListener('click', () => closeModal('bv-modal'));

    if (isEdit) {
        document.getElementById('bv-delete').addEventListener('click', async () => {
            const ok = await confirmDialog('Delete this benefits verification?');
            if (!ok) return;
            const { error } = await supabase.from('benefit_verifications').delete().eq('id', bv.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Deleted.', 'success');
            closeModal('bv-modal');
            load();
        });
    }

    document.getElementById('bv-save-draft').addEventListener('click', () => saveBV('in_progress', bv, false));
    document.getElementById('bv-save-complete').addEventListener('click', () => saveBV('completed', bv, true));
}

async function saveBV(newStatus, existing, pushToCRM) {
    const fd = new FormData(document.getElementById('bv-form'));
    const user = getCurrentStaff();

    const clientId = existing ? existing.client_id : fd.get('client_id');
    const payerId = fd.get('payer_id');

    if (!clientId) { showToast('Client is required.', 'error'); return; }

    const cptRaw = fd.get('cpt_codes_covered').trim();

    const record = {
        client_id: clientId,
        payer_id: payerId || null,
        status: newStatus,
        plan_year: fd.get('plan_year') ? parseInt(fd.get('plan_year')) : null,

        network_status: fd.get('network_status') || null,

        individual_deductible: numOrNull(fd.get('individual_deductible')),
        individual_deductible_met: numOrNull(fd.get('individual_deductible_met')),
        family_deductible: numOrNull(fd.get('family_deductible')),
        family_deductible_met: numOrNull(fd.get('family_deductible_met')),

        after_deductible_type: fd.get('after_deductible_type') || null,
        copay_amount: numOrNull(fd.get('copay_amount')),
        coinsurance_percent: numOrNull(fd.get('coinsurance_percent')),

        individual_oop_max: numOrNull(fd.get('individual_oop_max')),
        individual_oop_met: numOrNull(fd.get('individual_oop_met')),
        family_oop_max: numOrNull(fd.get('family_oop_max')),
        family_oop_met: numOrNull(fd.get('family_oop_met')),

        sca_required: document.getElementById('bv-sca-req').checked,
        sca_status: fd.get('sca_status') || null,
        sca_notes: fd.get('sca_notes').trim() || null,

        fee_schedule_type: fd.get('fee_schedule_type') || null,
        fee_schedule_percent: numOrNull(fd.get('fee_schedule_percent')),
        fee_schedule_notes: fd.get('fee_schedule_notes').trim() || null,

        effective_date: fd.get('effective_date') || null,
        termination_date: fd.get('termination_date') || null,

        auth_required: document.getElementById('bv-auth-req').checked,
        auth_submission_method: fd.get('auth_submission_method') || null,
        auth_contact_phone: fd.get('auth_contact_phone').trim() || null,
        auth_contact_notes: fd.get('auth_contact_notes').trim() || null,
        cpt_codes_covered: cptRaw ? cptRaw.split(',').map(c => c.trim()).filter(Boolean) : [],

        call_representative: fd.get('call_representative').trim() || null,
        call_representative_id: fd.get('call_representative_id').trim() || null,
        call_reference_number: fd.get('call_reference_number').trim() || null,
        call_date: fd.get('call_date') ? new Date(fd.get('call_date')).toISOString() : null,
        call_notes: fd.get('call_notes').trim() || null
    };

    if (newStatus === 'completed') {
        record.verification_date = new Date().toISOString().split('T')[0];
        record.verified_by = user.id;
    }

    const saveBtn = document.getElementById('bv-save-complete');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    let bvId;
    if (existing) {
        const { error } = await supabase.from('benefit_verifications').update(record).eq('id', existing.id);
        if (error) { showToast('Failed: ' + error.message, 'error'); saveBtn.disabled = false; return; }
        bvId = existing.id;
    } else {
        const { data, error } = await supabase.from('benefit_verifications').insert(record).select().single();
        if (error) { showToast('Failed: ' + error.message, 'error'); saveBtn.disabled = false; return; }
        bvId = data.id;
    }

    showToast(newStatus === 'completed' ? 'Verification saved.' : 'Draft saved.', 'success');

    if (pushToCRM && newStatus === 'completed') {
        saveBtn.textContent = 'Pushing to CRM...';
        try {
            const pushRes = await fetch('/.netlify/functions/push-benefits-to-crm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ benefit_verification_id: bvId })
            });
            const pushResult = await pushRes.json();

            if (pushResult.ok) {
                showToast('Pushed to CRM successfully.', 'success');
            } else {
                showToast('Saved, but CRM push failed: ' + (pushResult.error || 'unknown error'), 'warning', 8000);
            }
        } catch (err) {
            showToast('Saved, but CRM push failed: ' + err.message, 'warning', 8000);
        }
    }

    closeModal('bv-modal');
    load();
}

function numOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
}

init();
