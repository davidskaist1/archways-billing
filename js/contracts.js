import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, formatCurrency, formatDate, confirmDialog } from './ui.js';

let allPayers = [];
let selectedPayer = null;
let ratesTable;

async function init() {
    const auth = await requireAuth(['admin', 'billing']);
    if (!auth) return;
    renderNav();

    ratesTable = new DataTable('rates-table', {
        columns: [
            { key: 'cpt_code', label: 'CPT Code', className: 'text-mono font-bold' },
            { key: 'modifier', label: 'Modifier', render: v => v || '—' },
            { key: 'rate_per_unit', label: 'Rate/Unit', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'effective_date', label: 'Effective', type: 'date', render: v => formatDate(v) },
            { key: 'end_date', label: 'End Date', type: 'date', render: v => v ? formatDate(v) : 'Active' },
            {
                key: 'actions', label: '', render: (_, row) => `
                    <button class="btn btn-ghost btn-sm edit-rate" data-id="${row.id}">Edit</button>
                    <button class="btn btn-ghost btn-sm text-danger delete-rate" data-id="${row.id}">Delete</button>
                `
            }
        ],
        defaultSort: 'cpt_code',
        emptyMessage: 'No contract rates. Click "+ Add Rate" to add one.'
    });

    await loadPayers();

    document.getElementById('add-payer-btn').addEventListener('click', () => openPayerModal());
    document.getElementById('edit-payer-btn').addEventListener('click', () => {
        if (selectedPayer) openPayerModal(selectedPayer);
    });
    document.getElementById('add-rate-btn').addEventListener('click', () => {
        if (selectedPayer) openRateModal();
    });
}

async function loadPayers() {
    const { data, error } = await supabase
        .from('insurance_payers')
        .select('*')
        .order('name');

    if (error) {
        showToast('Failed to load payers: ' + error.message, 'error');
        return;
    }

    allPayers = data || [];
    renderPayerList();
}

function renderPayerList() {
    const container = document.getElementById('payer-list');

    if (allPayers.length === 0) {
        container.innerHTML = '<div class="empty-state"><p class="text-sm">No payers yet.</p></div>';
        return;
    }

    let html = '';
    for (const p of allPayers) {
        const isSelected = selectedPayer?.id === p.id;
        const activeClass = isSelected ? 'active' : '';
        const inactiveTag = !p.is_active ? ' <span class="badge badge-secondary">Inactive</span>' : '';
        html += `<a href="#" class="nav-link ${activeClass}" data-payer-id="${p.id}" style="padding:10px 12px;">
            <span>${p.name}${inactiveTag}</span>
        </a>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('[data-payer-id]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            const id = el.dataset.payerId;
            selectedPayer = allPayers.find(p => p.id === id);
            renderPayerList();
            loadRates();
        });
    });
}

async function loadRates() {
    if (!selectedPayer) return;

    document.getElementById('rates-title').textContent = selectedPayer.name;
    document.getElementById('rates-actions').style.display = 'flex';

    const detailsEl = document.getElementById('payer-details');
    if (selectedPayer.payer_id_number || selectedPayer.notes) {
        detailsEl.style.display = 'block';
        detailsEl.innerHTML = `
            ${selectedPayer.payer_id_number ? `<p class="text-sm text-muted">EDI Payer ID: <span class="font-mono">${selectedPayer.payer_id_number}</span></p>` : ''}
            ${selectedPayer.notes ? `<p class="text-sm text-muted">${selectedPayer.notes}</p>` : ''}
        `;
    } else {
        detailsEl.style.display = 'none';
    }

    const { data, error } = await supabase
        .from('contract_rates')
        .select('*')
        .eq('payer_id', selectedPayer.id)
        .order('cpt_code')
        .order('effective_date', { ascending: false });

    if (error) {
        showToast('Failed to load rates: ' + error.message, 'error');
        return;
    }

    ratesTable.setData(data || []);

    // Bind edit/delete buttons
    document.querySelectorAll('.edit-rate').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rate = (data || []).find(r => r.id === btn.dataset.id);
            if (rate) openRateModal(rate);
        });
    });

    document.querySelectorAll('.delete-rate').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmed = await confirmDialog('Delete this contract rate?');
            if (!confirmed) return;

            const { error: delErr } = await supabase
                .from('contract_rates')
                .delete()
                .eq('id', btn.dataset.id);

            if (delErr) {
                showToast('Failed to delete: ' + delErr.message, 'error');
                return;
            }
            showToast('Rate deleted.', 'success');
            loadRates();
        });
    });
}

function openPayerModal(payer = null) {
    const isEdit = !!payer;
    const title = isEdit ? 'Edit Payer' : 'Add Payer';

    const bodyHTML = `
        <form id="payer-form">
            <div class="form-group">
                <label class="form-label">Payer Name *</label>
                <input class="form-input" name="name" required value="${payer?.name || ''}" placeholder="e.g. UnitedHealthcare, Medicaid MO">
            </div>
            <div class="form-group">
                <label class="form-label">EDI Payer ID</label>
                <input class="form-input" name="payer_id_number" value="${payer?.payer_id_number || ''}" placeholder="Clearinghouse payer ID">
            </div>
            <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" name="notes" rows="3" placeholder="Contract details, contact info...">${payer?.notes || ''}</textarea>
            </div>
            ${isEdit ? `
                <div class="form-group">
                    <div class="form-check">
                        <input type="checkbox" name="is_active" id="payer-active" ${payer.is_active ? 'checked' : ''}>
                        <label for="payer-active">Active</label>
                    </div>
                </div>
            ` : ''}
        </form>
    `;

    const footerHTML = `
        <button class="btn btn-secondary" id="payer-cancel">Cancel</button>
        <button class="btn btn-primary" id="payer-save">Save</button>
    `;

    createModal('payer-modal', title, bodyHTML, footerHTML);
    openModal('payer-modal');

    document.getElementById('payer-cancel').addEventListener('click', () => closeModal('payer-modal'));
    document.getElementById('payer-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('payer-form'));
        const record = {
            name: fd.get('name').trim(),
            payer_id_number: fd.get('payer_id_number').trim() || null,
            notes: fd.get('notes').trim() || null
        };

        if (!record.name) {
            showToast('Payer name is required.', 'error');
            return;
        }

        if (isEdit) {
            const activeCheckbox = document.getElementById('payer-active');
            if (activeCheckbox) record.is_active = activeCheckbox.checked;

            const { error } = await supabase.from('insurance_payers').update(record).eq('id', payer.id);
            if (error) { showToast('Failed to update: ' + error.message, 'error'); return; }
            showToast('Payer updated.', 'success');
        } else {
            const { error } = await supabase.from('insurance_payers').insert(record);
            if (error) { showToast('Failed to add: ' + error.message, 'error'); return; }
            showToast('Payer added.', 'success');
        }

        closeModal('payer-modal');
        await loadPayers();
        if (isEdit && selectedPayer?.id === payer.id) {
            selectedPayer = allPayers.find(p => p.id === payer.id);
            loadRates();
        }
    });
}

function openRateModal(rate = null) {
    const isEdit = !!rate;
    const title = isEdit ? 'Edit Contract Rate' : 'Add Contract Rate';

    const bodyHTML = `
        <form id="rate-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">CPT Code *</label>
                    <input class="form-input" name="cpt_code" required value="${rate?.cpt_code || ''}" placeholder="e.g. 97153">
                </div>
                <div class="form-group">
                    <label class="form-label">Modifier</label>
                    <input class="form-input" name="modifier" value="${rate?.modifier || ''}" placeholder="e.g. HM, HN">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Rate Per Unit ($) *</label>
                <input class="form-input" type="number" step="0.01" min="0" name="rate_per_unit" required value="${rate?.rate_per_unit || ''}">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Effective Date *</label>
                    <input class="form-input" type="date" name="effective_date" required value="${rate?.effective_date || new Date().toISOString().split('T')[0]}">
                </div>
                <div class="form-group">
                    <label class="form-label">End Date</label>
                    <input class="form-input" type="date" name="end_date" value="${rate?.end_date || ''}">
                    <span class="text-xs text-muted">Leave blank if still active</span>
                </div>
            </div>
        </form>
    `;

    const footerHTML = `
        <button class="btn btn-secondary" id="rate-cancel">Cancel</button>
        <button class="btn btn-primary" id="rate-save">Save</button>
    `;

    createModal('rate-modal', title, bodyHTML, footerHTML);
    openModal('rate-modal');

    document.getElementById('rate-cancel').addEventListener('click', () => closeModal('rate-modal'));
    document.getElementById('rate-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('rate-form'));
        const record = {
            payer_id: selectedPayer.id,
            cpt_code: fd.get('cpt_code').trim(),
            modifier: fd.get('modifier').trim() || null,
            rate_per_unit: parseFloat(fd.get('rate_per_unit')),
            effective_date: fd.get('effective_date'),
            end_date: fd.get('end_date') || null
        };

        if (!record.cpt_code || !record.rate_per_unit || !record.effective_date) {
            showToast('CPT code, rate, and effective date are required.', 'error');
            return;
        }

        if (isEdit) {
            const { error } = await supabase.from('contract_rates').update(record).eq('id', rate.id);
            if (error) { showToast('Failed to update: ' + error.message, 'error'); return; }
            showToast('Rate updated.', 'success');
        } else {
            const { error } = await supabase.from('contract_rates').insert(record);
            if (error) { showToast('Failed to add: ' + error.message, 'error'); return; }
            showToast('Rate added.', 'success');
        }

        closeModal('rate-modal');
        loadRates();
    });
}

init();
