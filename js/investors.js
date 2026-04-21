import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { showToast, createModal, openModal, closeModal, formatDate, statusBadge, confirmDialog } from './ui.js';
import { fmtMoney } from './investor-helpers.js';

let investors = [];
let appUsers = [];

async function init() {
    const auth = await requireAuth(['admin']);
    if (!auth) return;
    renderNav();

    const { data: users } = await supabase.from('app_users').select('id, first_name, last_name, email, role').eq('role', 'investor');
    appUsers = users || [];

    document.getElementById('add-investor-btn').addEventListener('click', () => openForm());

    await load();
}

async function load() {
    const { data, error } = await supabase
        .from('investors')
        .select(`
            *,
            app_users(id, first_name, last_name, email),
            investor_contributions(id, contribution_date, amount, contribution_type, notes),
            investor_distributions(id, distribution_date, amount, distribution_type, notes)
        `)
        .order('name');

    if (error) { showToast('Failed: ' + error.message, 'error'); return; }
    investors = data || [];
    render();
}

function render() {
    const list = document.getElementById('investors-list');

    if (investors.length === 0) {
        list.innerHTML = `<div class="empty-state"><h3>No investors yet</h3><p>Click "+ Add Investor" to add your first one.</p></div>`;
        return;
    }

    let html = '';
    for (const inv of investors) {
        const contributed = (inv.investor_contributions || []).reduce((s, c) => s + parseFloat(c.amount), 0);
        const hasLogin = !!inv.app_users;
        const contribCount = (inv.investor_contributions || []).length;

        html += `<div class="card mb-2">
            <div class="flex-between mb-2">
                <div>
                    <strong style="font-size:1.1rem;">${inv.name}</strong>
                    ${inv.is_active ? statusBadge('active') : statusBadge('inactive')}
                    ${hasLogin ? '<span class="badge badge-info text-xs">🔑 Portal Access</span>' : '<span class="badge badge-secondary text-xs">No Login</span>'}
                    <span class="badge badge-secondary text-xs">${inv.investor_type}</span>
                    ${inv.equity_percent ? `<span class="badge badge-secondary text-xs">${inv.equity_percent}% equity</span>` : ''}
                </div>
                <div class="text-right">
                    <div class="text-sm">${inv.email || ''}</div>
                    <div class="text-xs text-muted">${inv.phone || ''}</div>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(2, 1fr);gap:16px;margin-bottom:12px;">
                <div>
                    <div class="text-xs text-muted">Total Contributed</div>
                    <div style="font-size:1.5rem;font-weight:700;" class="text-success">${fmtMoney(contributed)}</div>
                </div>
                <div>
                    <div class="text-xs text-muted">Contributions on Record</div>
                    <div style="font-size:1.5rem;font-weight:700;">${contribCount}</div>
                </div>
            </div>
            <div class="flex gap-1">
                <button class="btn btn-sm btn-secondary edit-inv" data-id="${inv.id}">Edit Investor</button>
                <button class="btn btn-sm btn-success add-contrib" data-id="${inv.id}">+ Record Investment</button>
                <button class="btn btn-sm btn-ghost view-history" data-id="${inv.id}">View History</button>
            </div>
        </div>`;
    }

    list.innerHTML = html;

    list.querySelectorAll('.edit-inv').forEach(btn => {
        btn.addEventListener('click', () => openForm(investors.find(i => i.id === btn.dataset.id)));
    });
    list.querySelectorAll('.add-contrib').forEach(btn => {
        btn.addEventListener('click', () => openContribForm(btn.dataset.id));
    });
    list.querySelectorAll('.view-history').forEach(btn => {
        btn.addEventListener('click', () => openHistoryModal(investors.find(i => i.id === btn.dataset.id)));
    });
}

function openForm(inv = null) {
    const isEdit = !!inv;
    const hasLogin = !!inv?.app_user_id;

    // Suggested first/last names from the full name (for new investors)
    const nameParts = (inv?.name || '').trim().split(/\s+/);
    const firstNameGuess = nameParts[0] || '';
    const lastNameGuess = nameParts.slice(1).join(' ') || '';

    const bodyHTML = `
        <form id="inv-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">First Name *</label>
                    <input class="form-input" name="first_name" required value="${firstNameGuess}">
                </div>
                <div class="form-group">
                    <label class="form-label">Last Name *</label>
                    <input class="form-input" name="last_name" required value="${lastNameGuess}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Email *</label>
                    <input class="form-input" type="email" name="email" required value="${inv?.email || ''}" ${hasLogin ? 'readonly style="background:#f9f9f9;"' : ''}>
                    ${hasLogin ? '<span class="text-xs text-muted">Email cannot be changed once a login account exists.</span>' : ''}
                </div>
                <div class="form-group">
                    <label class="form-label">Phone</label>
                    <input class="form-input" name="phone" value="${inv?.phone || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Investor Type</label>
                    <select class="form-select" name="investor_type">
                        <option value="equity" ${inv?.investor_type === 'equity' ? 'selected' : ''}>Equity</option>
                        <option value="loan" ${inv?.investor_type === 'loan' ? 'selected' : ''}>Loan</option>
                        <option value="convertible" ${inv?.investor_type === 'convertible' ? 'selected' : ''}>Convertible</option>
                        <option value="other" ${inv?.investor_type === 'other' ? 'selected' : ''}>Other</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Equity %</label>
                    <input class="form-input" type="number" step="0.001" name="equity_percent" value="${inv?.equity_percent || ''}">
                </div>
            </div>

            ${!hasLogin ? `
                <div class="card mb-2" style="background:var(--color-info-light);">
                    <div class="form-check mb-1">
                        <input type="checkbox" name="create_login" id="inv-create-login" checked>
                        <label for="inv-create-login"><strong>Create portal login for this investor</strong></label>
                    </div>
                    <p class="text-xs text-muted mb-1">They'll be able to log in at <code>finance.archwaysaba.com</code> and see only the Investor Portal (Dashboard + Pro Forma).</p>
                    <div class="form-group mt-1">
                        <label class="form-label">Temporary Password *</label>
                        <div class="flex gap-1">
                            <input class="form-input" type="text" name="password" id="inv-password" placeholder="Min 8 characters">
                            <button type="button" class="btn btn-secondary btn-sm" id="inv-gen-pw" style="white-space:nowrap;">Generate</button>
                        </div>
                        <span class="text-xs text-muted">You'll see this password after saving — copy it and share it with them. They can change it on first login.</span>
                    </div>
                </div>
            ` : `
                <div class="card mb-2" style="background:var(--color-success-light);">
                    <p class="text-sm mb-0">✓ <strong>Portal access enabled</strong> — this investor has a login account. They can reset their password from the login page.</p>
                </div>
            `}

            <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" name="notes" rows="3">${inv?.notes || ''}</textarea>
            </div>
            ${isEdit ? `<div class="form-group"><div class="form-check"><input type="checkbox" name="is_active" id="inv-active" ${inv.is_active ? 'checked' : ''}><label for="inv-active">Active</label></div></div>` : ''}
        </form>
    `;

    createModal('inv-modal', isEdit ? 'Edit Investor' : 'Add Investor', bodyHTML, `
        ${isEdit ? '<button class="btn btn-danger" id="inv-delete">Delete</button>' : ''}
        <button class="btn btn-secondary" id="inv-cancel">Cancel</button>
        <button class="btn btn-primary" id="inv-save">Save</button>
    `);
    openModal('inv-modal');

    // Password generator
    const genBtn = document.getElementById('inv-gen-pw');
    if (genBtn) {
        genBtn.addEventListener('click', () => {
            const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
            let pwd = 'Arch';
            for (let i = 0; i < 8; i++) pwd += chars.charAt(Math.floor(Math.random() * chars.length));
            pwd += '!';
            document.getElementById('inv-password').value = pwd;
        });
    }

    document.getElementById('inv-cancel').addEventListener('click', () => closeModal('inv-modal'));

    if (isEdit) {
        document.getElementById('inv-delete').addEventListener('click', async () => {
            const ok = await confirmDialog('Delete this investor and all their contribution/distribution history? This cannot be undone.');
            if (!ok) return;
            const { error } = await supabase.from('investors').delete().eq('id', inv.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Deleted.', 'success');
            closeModal('inv-modal');
            load();
        });
    }

    document.getElementById('inv-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('inv-form'));
        const firstName = fd.get('first_name').trim();
        const lastName = fd.get('last_name').trim();
        const email = fd.get('email').trim();
        const phone = fd.get('phone').trim() || null;
        const investorType = fd.get('investor_type');
        const equityPct = fd.get('equity_percent') ? parseFloat(fd.get('equity_percent')) : null;
        const notes = fd.get('notes').trim() || null;

        if (!firstName || !lastName) { showToast('First and last name are required.', 'error'); return; }
        if (!email) { showToast('Email is required.', 'error'); return; }

        const createLoginCheckbox = document.getElementById('inv-create-login');
        const createLogin = createLoginCheckbox && createLoginCheckbox.checked;
        const password = document.getElementById('inv-password')?.value || '';

        if (createLogin) {
            if (!password || password.length < 8) {
                showToast('Temporary password required (at least 8 characters). Click Generate for a random one.', 'error');
                return;
            }
        }

        const saveBtn = document.getElementById('inv-save');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
            let appUserId = inv?.app_user_id || null;

            // Step 1: Create login account if requested and not already linked
            if (createLogin && !appUserId) {
                const response = await fetch('/.netlify/functions/create-user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        first_name: firstName,
                        last_name: lastName,
                        email,
                        password,
                        role: 'investor'
                    })
                });
                const result = await response.json();
                if (!response.ok) {
                    throw new Error(result.error || 'Failed to create login account');
                }
                appUserId = result.app_user?.id;
            }

            // Step 2: Save investor record
            const record = {
                name: `${firstName} ${lastName}`,
                email,
                phone,
                investor_type: investorType,
                equity_percent: equityPct,
                app_user_id: appUserId,
                notes
            };
            if (isEdit) record.is_active = document.getElementById('inv-active').checked;

            if (isEdit) {
                const { error } = await supabase.from('investors').update(record).eq('id', inv.id);
                if (error) throw error;
                showToast('Updated.', 'success');
            } else {
                const { error } = await supabase.from('investors').insert(record);
                if (error) throw error;

                if (createLogin) {
                    // Show the temporary password prominently so admin can copy it
                    showToast(`Investor + login created! Temp password: ${password}`, 'success', 15000);
                } else {
                    showToast('Investor added.', 'success');
                }
            }

            closeModal('inv-modal');
            load();
        } catch (err) {
            showToast('Failed: ' + err.message, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    });
}

function openContribForm(investorId) {
    const bodyHTML = `
        <form id="cf-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Date *</label>
                    <input class="form-input" type="date" name="contribution_date" required value="${new Date().toISOString().split('T')[0]}">
                </div>
                <div class="form-group">
                    <label class="form-label">Amount *</label>
                    <input class="form-input" type="number" step="0.01" name="amount" required>
                </div>
                <div class="form-group">
                    <label class="form-label">Type</label>
                    <select class="form-select" name="contribution_type">
                        <option value="equity">Equity</option>
                        <option value="loan">Loan</option>
                        <option value="convertible">Convertible</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" name="notes" rows="2"></textarea>
            </div>
        </form>
    `;
    createModal('cf-modal', 'Record Investment (Bank Funding)', bodyHTML, `
        <button class="btn btn-secondary" id="cf-cancel">Cancel</button>
        <button class="btn btn-primary" id="cf-save">Save</button>
    `);
    openModal('cf-modal');

    document.getElementById('cf-cancel').addEventListener('click', () => closeModal('cf-modal'));
    document.getElementById('cf-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('cf-form'));
        const record = {
            investor_id: investorId,
            contribution_date: fd.get('contribution_date'),
            amount: parseFloat(fd.get('amount')),
            contribution_type: fd.get('contribution_type'),
            notes: fd.get('notes').trim() || null
        };
        const { error } = await supabase.from('investor_contributions').insert(record);
        if (error) { showToast('Failed: ' + error.message, 'error'); return; }
        showToast('Contribution recorded.', 'success');
        closeModal('cf-modal');
        load();
    });
}

function openDistribForm(investorId) {
    const bodyHTML = `
        <form id="df-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Date *</label>
                    <input class="form-input" type="date" name="distribution_date" required value="${new Date().toISOString().split('T')[0]}">
                </div>
                <div class="form-group">
                    <label class="form-label">Amount *</label>
                    <input class="form-input" type="number" step="0.01" name="amount" required>
                </div>
                <div class="form-group">
                    <label class="form-label">Type</label>
                    <select class="form-select" name="distribution_type">
                        <option value="profit_distribution">Profit Distribution</option>
                        <option value="return_of_capital">Return of Capital</option>
                        <option value="loan_repayment">Loan Repayment</option>
                        <option value="interest">Interest</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" name="notes" rows="2"></textarea>
            </div>
        </form>
    `;
    createModal('df-modal', 'Record Distribution', bodyHTML, `
        <button class="btn btn-secondary" id="df-cancel">Cancel</button>
        <button class="btn btn-primary" id="df-save">Save</button>
    `);
    openModal('df-modal');

    document.getElementById('df-cancel').addEventListener('click', () => closeModal('df-modal'));
    document.getElementById('df-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('df-form'));
        const record = {
            investor_id: investorId,
            distribution_date: fd.get('distribution_date'),
            amount: parseFloat(fd.get('amount')),
            distribution_type: fd.get('distribution_type'),
            notes: fd.get('notes').trim() || null
        };
        const { error } = await supabase.from('investor_distributions').insert(record);
        if (error) { showToast('Failed: ' + error.message, 'error'); return; }
        showToast('Distribution recorded.', 'success');
        closeModal('df-modal');
        load();
    });
}

function openHistoryModal(inv) {
    const contribs = (inv.investor_contributions || []).sort((a, b) => b.contribution_date.localeCompare(a.contribution_date));
    const total = contribs.reduce((s, c) => s + parseFloat(c.amount), 0);

    const bodyHTML = `
        <div>
            <h4 class="mb-1">Investment History (${contribs.length})</h4>
            <div class="card">
                ${contribs.length === 0 ? '<p class="text-sm text-muted">No investments recorded yet.</p>' : contribs.map(c => `
                    <div class="flex-between mb-1" style="padding:8px;border-bottom:1px solid var(--color-border);">
                        <div>
                            <div><strong>${formatDate(c.contribution_date)}</strong></div>
                            <div class="text-xs text-muted">${c.contribution_type}${c.notes ? ' · ' + c.notes : ''}</div>
                        </div>
                        <strong class="text-success" style="font-size:1.1rem;">${fmtMoney(c.amount)}</strong>
                    </div>
                `).join('')}
                ${contribs.length > 0 ? `
                    <div class="flex-between mt-1" style="padding:8px;border-top:2px solid var(--color-border);">
                        <strong>Total Invested</strong>
                        <strong class="text-success" style="font-size:1.2rem;">${fmtMoney(total)}</strong>
                    </div>
                ` : ''}
            </div>
        </div>
    `;

    createModal('hist-modal', `${inv.name} — History`, bodyHTML, `<button class="btn btn-secondary" id="hist-close">Close</button>`, 'modal-lg');
    openModal('hist-modal');
    document.getElementById('hist-close').addEventListener('click', () => closeModal('hist-modal'));
}

init();
