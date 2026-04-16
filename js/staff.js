import { requireAuth, hasRole } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, confirmDialog, statusBadge, formatCurrency } from './ui.js';

let table;
let allStaff = [];

async function init() {
    const auth = await requireAuth(['admin', 'payroll']);
    if (!auth) return;
    renderNav();

    table = new DataTable('staff-table', {
        columns: [
            { key: 'name', label: 'Name', render: (_, r) => `${r.first_name} ${r.last_name}` },
            { key: 'email', label: 'Email' },
            { key: 'role', label: 'Role', render: v => statusBadge(v) },
            { key: 'credential', label: 'Credential', render: v => v || '—' },
            { key: 'npi', label: 'NPI', render: v => v || '—', className: 'text-mono' },
            { key: 'hourly_rate', label: 'Rate', type: 'number', align: 'text-right', render: v => v ? formatCurrency(v) : '—' },
            { key: 'is_active', label: 'Status', render: v => v ? statusBadge('active') : statusBadge('inactive') }
        ],
        defaultSort: 'name',
        onRowClick: (row) => openStaffModal(row),
        emptyMessage: 'No staff members found.'
    });

    await loadStaff();
    setupFilters();

    document.getElementById('add-staff-btn').addEventListener('click', () => openStaffModal());
}

async function loadStaff() {
    const { data, error } = await supabase
        .from('staff')
        .select('*')
        .order('last_name');

    if (error) {
        showToast('Failed to load staff: ' + error.message, 'error');
        return;
    }

    allStaff = data || [];
    applyFilters();
}

function applyFilters() {
    let filtered = [...allStaff];
    const search = document.getElementById('filter-search').value.toLowerCase();
    const role = document.getElementById('filter-role').value;
    const credential = document.getElementById('filter-credential').value;
    const active = document.getElementById('filter-active').value;

    if (search) {
        filtered = filtered.filter(s =>
            `${s.first_name} ${s.last_name}`.toLowerCase().includes(search) ||
            s.email.toLowerCase().includes(search)
        );
    }
    if (role) filtered = filtered.filter(s => s.role === role);
    if (credential) filtered = filtered.filter(s => s.credential === credential);
    if (active !== '') filtered = filtered.filter(s => String(s.is_active) === active);

    table.setData(filtered);
}

function setupFilters() {
    ['filter-search', 'filter-role', 'filter-credential', 'filter-active'].forEach(id => {
        document.getElementById(id).addEventListener('input', applyFilters);
        document.getElementById(id).addEventListener('change', applyFilters);
    });
}

function openStaffModal(staff = null) {
    const isEdit = !!staff;
    const title = isEdit ? 'Edit Staff Member' : 'Add Staff Member';

    const bodyHTML = `
        <form id="staff-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">First Name *</label>
                    <input class="form-input" name="first_name" required value="${staff?.first_name || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Last Name *</label>
                    <input class="form-input" name="last_name" required value="${staff?.last_name || ''}">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Email *</label>
                <input class="form-input" type="email" name="email" required value="${staff?.email || ''}">
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Role *</label>
                    <select class="form-select" name="role" required>
                        <option value="admin" ${staff?.role === 'admin' ? 'selected' : ''}>Admin</option>
                        <option value="billing" ${staff?.role === 'billing' ? 'selected' : ''}>Billing</option>
                        <option value="payroll" ${staff?.role === 'payroll' ? 'selected' : ''}>Payroll</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Credential</label>
                    <select class="form-select" name="credential">
                        <option value="">None</option>
                        <option value="RBT" ${staff?.credential === 'RBT' ? 'selected' : ''}>RBT</option>
                        <option value="BCBA" ${staff?.credential === 'BCBA' ? 'selected' : ''}>BCBA</option>
                        <option value="BCaBA" ${staff?.credential === 'BCaBA' ? 'selected' : ''}>BCaBA</option>
                        <option value="Other" ${staff?.credential === 'Other' ? 'selected' : ''}>Other</option>
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">NPI</label>
                    <input class="form-input" name="npi" value="${staff?.npi || ''}" placeholder="10-digit NPI">
                </div>
                <div class="form-group">
                    <label class="form-label">Hourly Rate ($)</label>
                    <input class="form-input" type="number" step="0.01" min="0" name="hourly_rate" value="${staff?.hourly_rate || ''}">
                </div>
            </div>
            ${isEdit ? `
                <div class="form-group mt-2">
                    <div class="form-check">
                        <input type="checkbox" name="is_active" id="staff-active" ${staff.is_active ? 'checked' : ''}>
                        <label for="staff-active">Active</label>
                    </div>
                </div>
            ` : ''}
            ${isEdit && !staff.auth_user_id ? `
                <div class="card mt-2" style="background:var(--color-warning-light);border-color:var(--color-warning);">
                    <p class="text-sm mb-1"><strong>No login account</strong> — This staff member cannot sign in yet.</p>
                    <button type="button" class="btn btn-sm btn-primary" id="create-login-btn">Create Login Account</button>
                </div>
            ` : ''}
        </form>
    `;

    const footerHTML = `
        <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
    `;

    createModal('staff-modal', title, bodyHTML, footerHTML);
    openModal('staff-modal');

    document.getElementById('modal-cancel').addEventListener('click', () => closeModal('staff-modal'));
    document.getElementById('modal-save').addEventListener('click', () => saveStaff(staff?.id));

    const createLoginBtn = document.getElementById('create-login-btn');
    if (createLoginBtn) {
        createLoginBtn.addEventListener('click', () => createLogin(staff));
    }
}

async function saveStaff(existingId) {
    const form = document.getElementById('staff-form');
    const formData = new FormData(form);

    const record = {
        first_name: formData.get('first_name').trim(),
        last_name: formData.get('last_name').trim(),
        email: formData.get('email').trim(),
        role: formData.get('role'),
        credential: formData.get('credential') || null,
        npi: formData.get('npi').trim() || null,
        hourly_rate: formData.get('hourly_rate') ? parseFloat(formData.get('hourly_rate')) : null
    };

    if (!record.first_name || !record.last_name || !record.email) {
        showToast('Please fill in all required fields.', 'error');
        return;
    }

    if (existingId) {
        const activeCheckbox = document.getElementById('staff-active');
        if (activeCheckbox) record.is_active = activeCheckbox.checked;

        const { error } = await supabase
            .from('staff')
            .update(record)
            .eq('id', existingId);

        if (error) {
            showToast('Failed to update: ' + error.message, 'error');
            return;
        }
        showToast('Staff member updated.', 'success');
    } else {
        const { error } = await supabase
            .from('staff')
            .insert(record);

        if (error) {
            showToast('Failed to add: ' + error.message, 'error');
            return;
        }
        showToast('Staff member added.', 'success');
    }

    closeModal('staff-modal');
    await loadStaff();
}

async function createLogin(staff) {
    const tempPassword = 'Archways' + Math.random().toString(36).slice(2, 8) + '!';

    try {
        const response = await fetch('/.netlify/functions/create-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: staff.email,
                password: tempPassword,
                staff_id: staff.id
            })
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Failed to create login');

        showToast(`Login created. Temporary password: ${tempPassword}`, 'success', 10000);
        closeModal('staff-modal');
        await loadStaff();
    } catch (err) {
        showToast('Failed to create login: ' + err.message, 'error');
    }
}

init();
