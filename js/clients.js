import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, formatDate, statusBadge } from './ui.js';

let table;
let allClients = [];
let payers = [];

async function init() {
    const auth = await requireAuth();
    if (!auth) return;
    renderNav();

    // Load payers for dropdown
    const { data: payerData } = await supabase
        .from('insurance_payers')
        .select('id, name')
        .eq('is_active', true)
        .order('name');
    payers = payerData || [];

    const payerSelect = document.getElementById('filter-payer');
    for (const p of payers) {
        payerSelect.innerHTML += `<option value="${p.id}">${p.name}</option>`;
    }

    table = new DataTable('clients-table', {
        columns: [
            { key: 'name', label: 'Client Name', render: (_, r) => `${r.first_name} ${r.last_name}` },
            { key: 'date_of_birth', label: 'DOB', type: 'date', render: v => formatDate(v) },
            { key: 'payer_name', label: 'Insurance Payer', render: v => v || '—' },
            { key: 'insurance_member_id', label: 'Member ID', className: 'text-mono', render: v => v || '—' },
            { key: 'authorization_number', label: 'Auth #', render: v => v || '—' },
            { key: 'authorized_units_per_week', label: 'Units/Wk', type: 'number', align: 'text-center', render: v => v ?? '—' },
            { key: 'is_active', label: 'Status', render: v => v ? statusBadge('active') : statusBadge('inactive') }
        ],
        defaultSort: 'name',
        onRowClick: (row) => openClientModal(row),
        emptyMessage: 'No clients found.'
    });

    await loadClients();
    setupFilters();

    document.getElementById('add-client-btn').addEventListener('click', () => openClientModal());
}

async function loadClients() {
    const { data, error } = await supabase
        .from('clients')
        .select('*, insurance_payers(name)')
        .order('last_name');

    if (error) {
        showToast('Failed to load clients: ' + error.message, 'error');
        return;
    }

    allClients = (data || []).map(c => ({
        ...c,
        payer_name: c.insurance_payers?.name || null
    }));
    applyFilters();
}

function applyFilters() {
    let filtered = [...allClients];
    const search = document.getElementById('filter-search').value.toLowerCase();
    const payer = document.getElementById('filter-payer').value;
    const active = document.getElementById('filter-active').value;

    if (search) {
        filtered = filtered.filter(c =>
            `${c.first_name} ${c.last_name}`.toLowerCase().includes(search) ||
            (c.insurance_member_id || '').toLowerCase().includes(search)
        );
    }
    if (payer) filtered = filtered.filter(c => c.insurance_payer_id === payer);
    if (active !== '') filtered = filtered.filter(c => String(c.is_active) === active);

    table.setData(filtered);
}

function setupFilters() {
    ['filter-search', 'filter-payer', 'filter-active'].forEach(id => {
        document.getElementById(id).addEventListener('input', applyFilters);
        document.getElementById(id).addEventListener('change', applyFilters);
    });
}

function payerOptions(selectedId) {
    let html = '<option value="">— Select Payer —</option>';
    for (const p of payers) {
        html += `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${p.name}</option>`;
    }
    return html;
}

function openClientModal(client = null) {
    const isEdit = !!client;
    const title = isEdit ? 'Edit Client' : 'Add Client';

    const bodyHTML = `
        <form id="client-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">First Name *</label>
                    <input class="form-input" name="first_name" required value="${client?.first_name || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Last Name *</label>
                    <input class="form-input" name="last_name" required value="${client?.last_name || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Date of Birth</label>
                    <input class="form-input" type="date" name="date_of_birth" value="${client?.date_of_birth || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">CR Client ID</label>
                    <input class="form-input" name="cr_client_id" value="${client?.cr_client_id || ''}" placeholder="Central Reach ID">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Insurance Payer</label>
                <select class="form-select" name="insurance_payer_id">${payerOptions(client?.insurance_payer_id)}</select>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Member ID</label>
                    <input class="form-input" name="insurance_member_id" value="${client?.insurance_member_id || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Authorization #</label>
                    <input class="form-input" name="authorization_number" value="${client?.authorization_number || ''}">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Authorized Units Per Week</label>
                <input class="form-input" type="number" min="0" name="authorized_units_per_week" value="${client?.authorized_units_per_week || ''}">
            </div>
            ${isEdit ? `
                <div class="form-group mt-2">
                    <div class="form-check">
                        <input type="checkbox" name="is_active" id="client-active" ${client.is_active ? 'checked' : ''}>
                        <label for="client-active">Active</label>
                    </div>
                </div>
            ` : ''}
        </form>
    `;

    const footerHTML = `
        <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
    `;

    createModal('client-modal', title, bodyHTML, footerHTML);
    openModal('client-modal');

    document.getElementById('modal-cancel').addEventListener('click', () => closeModal('client-modal'));
    document.getElementById('modal-save').addEventListener('click', () => saveClient(client?.id));
}

async function saveClient(existingId) {
    const form = document.getElementById('client-form');
    const fd = new FormData(form);

    const record = {
        first_name: fd.get('first_name').trim(),
        last_name: fd.get('last_name').trim(),
        date_of_birth: fd.get('date_of_birth') || null,
        cr_client_id: fd.get('cr_client_id').trim() || null,
        insurance_payer_id: fd.get('insurance_payer_id') || null,
        insurance_member_id: fd.get('insurance_member_id').trim() || null,
        authorization_number: fd.get('authorization_number').trim() || null,
        authorized_units_per_week: fd.get('authorized_units_per_week') ? parseInt(fd.get('authorized_units_per_week')) : null
    };

    if (!record.first_name || !record.last_name) {
        showToast('First and last name are required.', 'error');
        return;
    }

    if (existingId) {
        const activeCheckbox = document.getElementById('client-active');
        if (activeCheckbox) record.is_active = activeCheckbox.checked;

        const { error } = await supabase.from('clients').update(record).eq('id', existingId);
        if (error) { showToast('Failed to update: ' + error.message, 'error'); return; }
        showToast('Client updated.', 'success');
    } else {
        const { error } = await supabase.from('clients').insert(record);
        if (error) { showToast('Failed to add: ' + error.message, 'error'); return; }
        showToast('Client added.', 'success');
    }

    closeModal('client-modal');
    await loadClients();
}

init();
