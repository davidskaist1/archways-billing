import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { showToast, createModal, openModal, closeModal, formatDate, confirmDialog } from './ui.js';
import { fmtMoney } from './investor-helpers.js';

let contribs = [];
let settings = {};

async function init() {
    const auth = await requireAuth(['admin']);
    if (!auth) return;
    renderNav();

    document.getElementById('add-contrib-btn').addEventListener('click', () => openContribForm());
    document.getElementById('save-recipients-btn').addEventListener('click', saveRecipients);

    await loadAll();
}

async function loadAll() {
    const [contribRes, settingsRes] = await Promise.all([
        supabase
            .from('investor_contributions')
            .select('*')
            .order('contribution_date', { ascending: false }),
        supabase
            .from('investor_snapshot_settings')
            .select('*')
            .eq('id', 1)
            .maybeSingle()
    ]);

    contribs = contribRes.data || [];
    settings = settingsRes.data || {};

    renderKPIs();
    renderContribs();
    renderRecipients();
}

function renderKPIs() {
    const total = contribs.reduce((s, c) => s + parseFloat(c.amount), 0);
    const thirtyAgo = new Date();
    thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    const recent = contribs.filter(c => new Date(c.contribution_date) >= thirtyAgo);
    const recentTotal = recent.reduce((s, c) => s + parseFloat(c.amount), 0);

    document.getElementById('kpi-total').textContent = fmtMoney(total);
    document.getElementById('kpi-recent').textContent = fmtMoney(recentTotal);
    document.getElementById('kpi-recent-sub').textContent = `${recent.length} contribution${recent.length !== 1 ? 's' : ''}`;

    const recipients = (settings.recipient_emails || '')
        .split(/[\n,;]+/)
        .map(e => e.trim())
        .filter(Boolean);
    document.getElementById('kpi-recipients').textContent = recipients.length;
}

function renderContribs() {
    const list = document.getElementById('contribs-list');
    if (contribs.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>No contributions yet. Click "+ Record Contribution" to add one.</p></div>';
        return;
    }

    let html = '<table class="data-table"><thead><tr><th>Date</th><th>Type</th><th>Notes</th><th class="text-right">Amount</th><th></th></tr></thead><tbody>';
    for (const c of contribs) {
        html += `<tr>
            <td>${formatDate(c.contribution_date)}</td>
            <td><span class="badge badge-secondary">${c.contribution_type || 'equity'}</span></td>
            <td>${c.notes || '—'}</td>
            <td class="text-right font-bold text-success">${fmtMoney(c.amount)}</td>
            <td class="text-right">
                <button class="btn btn-ghost btn-sm edit-contrib" data-id="${c.id}">Edit</button>
                <button class="btn btn-ghost btn-sm text-danger del-contrib" data-id="${c.id}">×</button>
            </td>
        </tr>`;
    }
    // Total row
    const total = contribs.reduce((s, c) => s + parseFloat(c.amount), 0);
    html += `<tr style="border-top:2px solid var(--color-text);">
        <td colspan="3" class="font-bold">Total</td>
        <td class="text-right font-bold text-success" style="font-size:1.1rem;">${fmtMoney(total)}</td>
        <td></td>
    </tr>`;
    html += '</tbody></table>';
    list.innerHTML = html;

    list.querySelectorAll('.edit-contrib').forEach(btn => {
        btn.addEventListener('click', () => {
            const c = contribs.find(x => x.id === btn.dataset.id);
            if (c) openContribForm(c);
        });
    });
    list.querySelectorAll('.del-contrib').forEach(btn => {
        btn.addEventListener('click', async () => {
            const ok = await confirmDialog('Delete this contribution? This cannot be undone.');
            if (!ok) return;
            const { error } = await supabase.from('investor_contributions').delete().eq('id', btn.dataset.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Deleted.', 'success');
            loadAll();
        });
    });
}

function renderRecipients() {
    document.getElementById('recipients-input').value = settings.recipient_emails || '';
}

async function saveRecipients() {
    const raw = document.getElementById('recipients-input').value;
    // Normalize: split on newlines/commas/semicolons, trim, dedupe, validate
    const emails = [...new Set(
        raw.split(/[\n,;]+/).map(e => e.trim()).filter(Boolean)
    )];
    const invalid = emails.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (invalid.length > 0) {
        showToast('Invalid email(s): ' + invalid.join(', '), 'error');
        return;
    }

    const btn = document.getElementById('save-recipients-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const { error } = await supabase
        .from('investor_snapshot_settings')
        .update({ recipient_emails: emails.join('\n') })
        .eq('id', 1);

    if (error) {
        showToast('Failed: ' + error.message, 'error');
    } else {
        const status = document.getElementById('recipients-status');
        status.textContent = `✓ Saved — ${emails.length} recipient${emails.length !== 1 ? 's' : ''}`;
        status.className = 'text-xs text-success mt-1';
        showToast('Recipients saved.', 'success');
        await loadAll();
    }

    btn.disabled = false;
    btn.textContent = 'Save Recipients';
}

function openContribForm(c = null) {
    const isEdit = !!c;
    const bodyHTML = `
        <form id="contrib-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Date *</label>
                    <input class="form-input" type="date" name="contribution_date" required value="${c?.contribution_date || new Date().toISOString().split('T')[0]}">
                </div>
                <div class="form-group">
                    <label class="form-label">Amount *</label>
                    <input class="form-input" type="number" step="0.01" name="amount" required value="${c?.amount || ''}">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Type</label>
                <select class="form-select" name="contribution_type">
                    <option value="equity" ${c?.contribution_type === 'equity' ? 'selected' : ''}>Equity</option>
                    <option value="loan" ${c?.contribution_type === 'loan' ? 'selected' : ''}>Loan</option>
                    <option value="convertible" ${c?.contribution_type === 'convertible' ? 'selected' : ''}>Convertible</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" name="notes" rows="2" placeholder="Wire reference, source bank, etc.">${c?.notes || ''}</textarea>
            </div>
        </form>
    `;

    createModal('contrib-modal', isEdit ? 'Edit Contribution' : 'Record Contribution', bodyHTML, `
        <button class="btn btn-secondary" id="contrib-cancel">Cancel</button>
        <button class="btn btn-primary" id="contrib-save">Save</button>
    `);
    openModal('contrib-modal');

    document.getElementById('contrib-cancel').addEventListener('click', () => closeModal('contrib-modal'));
    document.getElementById('contrib-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('contrib-form'));
        const record = {
            contribution_date: fd.get('contribution_date'),
            amount: parseFloat(fd.get('amount')),
            contribution_type: fd.get('contribution_type'),
            notes: fd.get('notes').trim() || null
        };

        if (!record.amount || record.amount <= 0) {
            showToast('Amount required.', 'error');
            return;
        }

        if (isEdit) {
            const { error } = await supabase.from('investor_contributions').update(record).eq('id', c.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Updated.', 'success');
        } else {
            const { error } = await supabase.from('investor_contributions').insert(record);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Recorded.', 'success');
        }
        closeModal('contrib-modal');
        loadAll();
    });
}

init();
