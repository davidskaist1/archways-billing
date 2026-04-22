import { requireAuth, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, confirmDialog, statusBadge } from './ui.js';

let table;
let allUsers = [];

async function init() {
    const auth = await requireAuth(['admin']);
    if (!auth) return;
    renderNav();

    table = new DataTable('users-table', {
        columns: [
            { key: 'name', label: 'Name', render: (_, r) => `${r.first_name} ${r.last_name}` },
            { key: 'email', label: 'Email' },
            { key: 'role', label: 'Role', render: v => {
                const colors = { admin: 'badge-danger', billing: 'badge-info', payroll: 'badge-success' };
                const labels = { admin: 'Admin', billing: 'Billing', payroll: 'Payroll' };
                return `<span class="badge ${colors[v] || 'badge-secondary'}">${labels[v] || v}</span>`;
            }},
            { key: 'last_login_at', label: 'Last Login', render: v => {
                if (!v) return '<span class="text-muted">Never</span>';
                return new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
            }},
            { key: 'is_active', label: 'Status', render: v => v ? statusBadge('active') : statusBadge('inactive') },
            { key: 'created_at', label: 'Created', render: v => new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
        ],
        defaultSort: 'name',
        onRowClick: (row) => openEditModal(row),
        emptyMessage: 'No users found.'
    });

    await loadUsers();
    setupFilters();

    document.getElementById('add-user-btn').addEventListener('click', () => openAddModal());
}

async function loadUsers() {
    const { data, error } = await supabase
        .from('app_users')
        .select('*')
        .order('last_name');

    if (error) {
        showToast('Failed to load users: ' + error.message, 'error');
        return;
    }

    allUsers = data || [];
    applyFilters();
}

function applyFilters() {
    let filtered = [...allUsers];
    const search = document.getElementById('filter-search').value.toLowerCase();
    const role = document.getElementById('filter-role').value;
    const active = document.getElementById('filter-active').value;

    if (search) {
        filtered = filtered.filter(u =>
            `${u.first_name} ${u.last_name}`.toLowerCase().includes(search) ||
            u.email.toLowerCase().includes(search)
        );
    }
    if (role) filtered = filtered.filter(u => u.role === role);
    if (active !== '') filtered = filtered.filter(u => String(u.is_active) === active);

    table.setData(filtered);
}

function setupFilters() {
    ['filter-search', 'filter-role', 'filter-active'].forEach(id => {
        document.getElementById(id).addEventListener('input', applyFilters);
        document.getElementById(id).addEventListener('change', applyFilters);
    });
}

function roleDescription(role) {
    const descs = {
        admin: 'Full access to everything — billing, payroll, staff, clients, contracts, reports, users, clearinghouse, investor portal.',
        billing: 'Access to billing, claims, payments, clearinghouse, contracts, clients, and reports. No payroll or user management.',
        payroll: 'Access to payroll, sessions, clients, and reports. No billing or user management.',
        investor: 'Access to investor portal only — financial dashboard and pro forma. Cannot see clients, claims, staff, or any billing/payroll data.'
    };
    return descs[role] || '';
}

function openAddModal() {
    const bodyHTML = `
        <form id="user-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">First Name *</label>
                    <input class="form-input" name="first_name" required placeholder="Jane">
                </div>
                <div class="form-group">
                    <label class="form-label">Last Name *</label>
                    <input class="form-input" name="last_name" required placeholder="Doe">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Email *</label>
                <input class="form-input" type="email" name="email" required placeholder="jane@archways.com">
                <span class="text-xs text-muted">We'll email them an invite link. They'll set their own password on first login.</span>
            </div>
            <div class="form-group">
                <label class="form-label">Role *</label>
                <select class="form-select" name="role" id="role-select" required>
                    <option value="billing">Billing</option>
                    <option value="payroll">Payroll</option>
                    <option value="admin">Admin</option>
                    <option value="investor">Investor</option>
                </select>
                <p class="text-xs text-muted mt-1" id="role-desc">${roleDescription('billing')}</p>
            </div>
        </form>
    `;

    const footerHTML = `
        <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Send Invite</button>
    `;

    createModal('user-modal', 'Add User', bodyHTML, footerHTML);
    openModal('user-modal');

    // Role description
    document.getElementById('role-select').addEventListener('change', (e) => {
        document.getElementById('role-desc').textContent = roleDescription(e.target.value);
    });

    document.getElementById('modal-cancel').addEventListener('click', () => closeModal('user-modal'));
    document.getElementById('modal-save').addEventListener('click', createUser);
}

async function createUser() {
    const form = document.getElementById('user-form');
    const fd = new FormData(form);

    const first_name = fd.get('first_name').trim();
    const last_name = fd.get('last_name').trim();
    const email = fd.get('email').trim();
    const role = fd.get('role');

    if (!first_name || !last_name || !email || !role) {
        showToast('All fields are required.', 'error');
        return;
    }

    const saveBtn = document.getElementById('modal-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Sending invite…';

    try {
        const response = await fetch('/.netlify/functions/create-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ first_name, last_name, email, role })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Failed to send invite');
        }

        showToast(`Invite email sent to ${email}. They'll set their password from the link.`, 'success', 10000);
        closeModal('user-modal');
        await loadUsers();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Send Invite';
    }
}

function openEditModal(user) {
    const currentUser = getCurrentStaff();
    const isSelf = currentUser?.id === user.id;

    const bodyHTML = `
        <form id="edit-user-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">First Name</label>
                    <input class="form-input" name="first_name" value="${user.first_name}">
                </div>
                <div class="form-group">
                    <label class="form-label">Last Name</label>
                    <input class="form-input" name="last_name" value="${user.last_name}">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Email</label>
                <input class="form-input" type="email" name="email" value="${user.email}" disabled>
                <span class="text-xs text-muted">Email cannot be changed.</span>
            </div>
            <div class="form-group">
                <label class="form-label">Role</label>
                <select class="form-select" name="role" id="edit-role-select" ${isSelf ? 'disabled' : ''}>
                    <option value="billing" ${user.role === 'billing' ? 'selected' : ''}>Billing</option>
                    <option value="payroll" ${user.role === 'payroll' ? 'selected' : ''}>Payroll</option>
                    <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
                    <option value="investor" ${user.role === 'investor' ? 'selected' : ''}>Investor</option>
                </select>
                ${isSelf ? '<span class="text-xs text-muted">You cannot change your own role.</span>' : ''}
                <p class="text-xs text-muted mt-1" id="edit-role-desc">${roleDescription(user.role)}</p>
            </div>
            <div class="form-group">
                <div class="form-check">
                    <input type="checkbox" name="is_active" id="user-active" ${user.is_active ? 'checked' : ''} ${isSelf ? 'disabled' : ''}>
                    <label for="user-active">Active</label>
                </div>
                ${isSelf ? '<span class="text-xs text-muted">You cannot deactivate your own account.</span>' : ''}
            </div>
            <div class="form-group mt-2">
                <label class="form-label">Last Login</label>
                <p class="text-sm">${user.last_login_at ? new Date(user.last_login_at).toLocaleString() : 'Never'}</p>
            </div>
            <hr style="border:none;border-top:1px solid var(--color-border);margin:16px 0;">
            <div class="form-group">
                <label class="form-label">Account Actions</label>
                ${user.last_login_at ? '' : `
                    <div class="card mb-1" style="background:var(--color-warning-light);padding:10px;">
                        <p class="text-sm mb-1"><strong>This user hasn't logged in yet.</strong> If their invite email didn't arrive, resend it below.</p>
                        <button type="button" class="btn btn-primary btn-sm" id="resend-invite-btn">✉️ Resend Invite Email</button>
                    </div>
                `}
                <details style="margin-top:8px;">
                    <summary class="text-sm text-muted" style="cursor:pointer;">Force password reset (sets a new password manually)</summary>
                    <div class="mt-1">
                        <div class="flex gap-1">
                            <input class="form-input" type="text" id="reset-password-input" placeholder="New temporary password">
                            <button type="button" class="btn btn-secondary" id="gen-reset-pw" style="white-space:nowrap;">Generate</button>
                        </div>
                        <button type="button" class="btn btn-danger btn-sm mt-1" id="reset-password-btn">Reset Password</button>
                        <div id="reset-result" class="mt-1" style="display:none;"></div>
                    </div>
                </details>
            </div>
        </form>
    `;

    const footerHTML = `
        <button class="btn btn-secondary" id="edit-cancel">Cancel</button>
        <button class="btn btn-primary" id="edit-save">Save Changes</button>
    `;

    createModal('edit-user-modal', 'Edit User', bodyHTML, footerHTML);
    openModal('edit-user-modal');

    document.getElementById('edit-role-select')?.addEventListener('change', (e) => {
        document.getElementById('edit-role-desc').textContent = roleDescription(e.target.value);
    });

    // Resend invite (for users who haven't logged in)
    const resendBtn = document.getElementById('resend-invite-btn');
    if (resendBtn) {
        resendBtn.addEventListener('click', async () => {
            resendBtn.disabled = true;
            resendBtn.textContent = 'Sending…';
            try {
                const res = await fetch('/.netlify/functions/resend-invite', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: user.email })
                });
                const result = await res.json();
                if (!res.ok) throw new Error(result.error || 'Failed to resend');
                showToast(`Invite resent to ${user.email}.`, 'success');
                resendBtn.textContent = '✓ Sent';
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
                resendBtn.disabled = false;
                resendBtn.textContent = '✉️ Resend Invite Email';
            }
        });
    }

    // Generate password for reset
    document.getElementById('gen-reset-pw').addEventListener('click', () => {
        const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        let pwd = 'Arch';
        for (let i = 0; i < 8; i++) pwd += chars.charAt(Math.floor(Math.random() * chars.length));
        pwd += '!';
        document.getElementById('reset-password-input').value = pwd;
    });

    // Reset password
    document.getElementById('reset-password-btn').addEventListener('click', async () => {
        const newPw = document.getElementById('reset-password-input').value.trim();
        if (!newPw || newPw.length < 8) {
            showToast('Enter a password of at least 8 characters.', 'error');
            return;
        }

        const btn = document.getElementById('reset-password-btn');
        btn.disabled = true;
        btn.textContent = 'Resetting...';

        try {
            const res = await fetch('/.netlify/functions/reset-user-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auth_user_id: user.auth_user_id, new_password: newPw })
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || 'Failed to reset password');

            const resultEl = document.getElementById('reset-result');
            resultEl.style.display = 'block';
            resultEl.innerHTML = `<div style="background:var(--color-success-light);padding:8px 12px;border-radius:6px;">
                <p class="text-sm"><strong>Password reset!</strong></p>
                <p class="text-sm">New password: <code style="background:#fff;padding:2px 6px;border-radius:4px;font-weight:bold;">${newPw}</code></p>
                <p class="text-xs text-muted mt-1">Copy this and send it to the user.</p>
            </div>`;
        } catch (err) {
            showToast('Reset failed: ' + err.message, 'error');
        }

        btn.disabled = false;
        btn.textContent = 'Reset Password';
    });

    document.getElementById('edit-cancel').addEventListener('click', () => closeModal('edit-user-modal'));
    document.getElementById('edit-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('edit-user-form'));

        const updates = {
            first_name: fd.get('first_name').trim(),
            last_name: fd.get('last_name').trim()
        };

        if (!isSelf) {
            updates.role = fd.get('role');
            updates.is_active = document.getElementById('user-active').checked;
        }

        const { error } = await supabase.from('app_users').update(updates).eq('id', user.id);

        if (error) {
            showToast('Failed to update: ' + error.message, 'error');
            return;
        }

        showToast('User updated.', 'success');
        closeModal('edit-user-modal');
        await loadUsers();
    });
}

init();
