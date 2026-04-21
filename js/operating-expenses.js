import { requireAuth, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, formatDate, confirmDialog } from './ui.js';
import { exportToExcel, fmtMoney } from './investor-helpers.js';

const CATEGORIES = [
    'rent', 'utilities', 'software', 'marketing', 'insurance', 'legal',
    'accounting', 'office_supplies', 'travel', 'professional_services',
    'taxes', 'dues_subscriptions', 'other'
];

let table;
let allExpenses = [];

async function init() {
    const auth = await requireAuth(['admin']);
    if (!auth) return;
    renderNav();

    const catSelect = document.getElementById('filter-category');
    for (const c of CATEGORIES) {
        catSelect.innerHTML += `<option value="${c}">${c.replace(/_/g, ' ')}</option>`;
    }

    // Default date range: last 90 days
    const now = new Date();
    const ago = new Date(now); ago.setDate(ago.getDate() - 90);
    document.getElementById('filter-from').value = ago.toISOString().split('T')[0];
    document.getElementById('filter-to').value = now.toISOString().split('T')[0];

    table = new DataTable('expenses-table', {
        columns: [
            { key: 'expense_date', label: 'Date', type: 'date', render: v => formatDate(v) },
            { key: 'category', label: 'Category', render: v => `<span class="badge badge-secondary">${v.replace(/_/g, ' ')}</span>` },
            { key: 'description', label: 'Description' },
            { key: 'vendor', label: 'Vendor', render: v => v || '—' },
            { key: 'amount', label: 'Amount', type: 'number', align: 'text-right', render: v => fmtMoney(v) },
            { key: 'is_recurring', label: 'Recurring', align: 'text-center', render: v => v ? '🔄' : '' },
            { key: 'recurrence_frequency', label: 'Frequency', render: v => v || '—' }
        ],
        defaultSort: 'expense_date',
        defaultSortDir: 'desc',
        onRowClick: (r) => openForm(r),
        emptyMessage: 'No expenses. Click "+ Add Expense" to start.'
    });

    ['filter-from', 'filter-to', 'filter-category', 'filter-recurring'].forEach(id => {
        document.getElementById(id).addEventListener('change', render);
    });

    document.getElementById('add-btn').addEventListener('click', () => openForm());
    document.getElementById('export-btn').addEventListener('click', exportData);

    await load();
}

async function load() {
    const { data, error } = await supabase.from('operating_expenses').select('*').order('expense_date', { ascending: false });
    if (error) { showToast('Failed: ' + error.message, 'error'); return; }
    allExpenses = data || [];
    updateKPIs();
    render();
}

function updateKPIs() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);

    const thisMonth = allExpenses.filter(e => new Date(e.expense_date) >= monthStart).reduce((s, e) => s + parseFloat(e.amount), 0);
    const ytd = allExpenses.filter(e => new Date(e.expense_date) >= yearStart).reduce((s, e) => s + parseFloat(e.amount), 0);
    const lifetime = allExpenses.reduce((s, e) => s + parseFloat(e.amount), 0);

    // Monthly recurring (sum of latest recurring expenses, normalized to monthly)
    const recurringMap = new Map();
    for (const e of allExpenses) {
        if (!e.is_recurring) continue;
        const key = `${e.category}|${e.description}|${e.vendor || ''}`;
        if (!recurringMap.has(key) || new Date(e.expense_date) > new Date(recurringMap.get(key).expense_date)) {
            recurringMap.set(key, e);
        }
    }
    let recurring = 0;
    for (const e of recurringMap.values()) {
        const amt = parseFloat(e.amount);
        if (e.recurrence_frequency === 'monthly') recurring += amt;
        else if (e.recurrence_frequency === 'quarterly') recurring += amt / 3;
        else if (e.recurrence_frequency === 'annually') recurring += amt / 12;
    }

    document.getElementById('kpi-month').textContent = fmtMoney(thisMonth);
    document.getElementById('kpi-ytd').textContent = fmtMoney(ytd);
    document.getElementById('kpi-recurring').textContent = fmtMoney(recurring);
    document.getElementById('kpi-lifetime').textContent = fmtMoney(lifetime);
}

function render() {
    const from = document.getElementById('filter-from').value;
    const to = document.getElementById('filter-to').value;
    const cat = document.getElementById('filter-category').value;
    const rec = document.getElementById('filter-recurring').value;

    let filtered = [...allExpenses];
    if (from) filtered = filtered.filter(e => e.expense_date >= from);
    if (to) filtered = filtered.filter(e => e.expense_date <= to);
    if (cat) filtered = filtered.filter(e => e.category === cat);
    if (rec) filtered = filtered.filter(e => String(e.is_recurring) === rec);

    table.setData(filtered);
}

function openForm(exp = null) {
    const isEdit = !!exp;
    const catOpts = CATEGORIES.map(c =>
        `<option value="${c}" ${exp?.category === c ? 'selected' : ''}>${c.replace(/_/g, ' ')}</option>`
    ).join('');

    const bodyHTML = `
        <form id="exp-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Date *</label>
                    <input class="form-input" type="date" name="expense_date" required value="${exp?.expense_date || new Date().toISOString().split('T')[0]}">
                </div>
                <div class="form-group">
                    <label class="form-label">Category *</label>
                    <select class="form-select" name="category" required>
                        <option value="">— Select —</option>
                        ${catOpts}
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Amount *</label>
                    <input class="form-input" type="number" step="0.01" name="amount" required value="${exp?.amount || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Description *</label>
                    <input class="form-input" name="description" required value="${exp?.description || ''}" placeholder="e.g. Monthly office rent">
                </div>
                <div class="form-group">
                    <label class="form-label">Vendor</label>
                    <input class="form-input" name="vendor" value="${exp?.vendor || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <div class="form-check">
                        <input type="checkbox" name="is_recurring" id="exp-recurring" ${exp?.is_recurring ? 'checked' : ''}>
                        <label for="exp-recurring">Recurring expense</label>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Frequency (if recurring)</label>
                    <select class="form-select" name="recurrence_frequency">
                        <option value="">—</option>
                        <option value="monthly" ${exp?.recurrence_frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
                        <option value="quarterly" ${exp?.recurrence_frequency === 'quarterly' ? 'selected' : ''}>Quarterly</option>
                        <option value="annually" ${exp?.recurrence_frequency === 'annually' ? 'selected' : ''}>Annually</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" name="notes" rows="2">${exp?.notes || ''}</textarea>
            </div>
        </form>
    `;

    createModal('exp-modal', isEdit ? 'Edit Expense' : 'Add Expense', bodyHTML, `
        ${isEdit ? '<button class="btn btn-danger" id="exp-delete">Delete</button>' : ''}
        <button class="btn btn-secondary" id="exp-cancel">Cancel</button>
        <button class="btn btn-primary" id="exp-save">Save</button>
    `);
    openModal('exp-modal');

    document.getElementById('exp-cancel').addEventListener('click', () => closeModal('exp-modal'));

    if (isEdit) {
        document.getElementById('exp-delete').addEventListener('click', async () => {
            const ok = await confirmDialog('Delete this expense?');
            if (!ok) return;
            const { error } = await supabase.from('operating_expenses').delete().eq('id', exp.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Deleted.', 'success');
            closeModal('exp-modal');
            load();
        });
    }

    document.getElementById('exp-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('exp-form'));
        const user = getCurrentStaff();
        const record = {
            expense_date: fd.get('expense_date'),
            category: fd.get('category'),
            description: fd.get('description').trim(),
            amount: parseFloat(fd.get('amount')),
            vendor: fd.get('vendor').trim() || null,
            is_recurring: document.getElementById('exp-recurring').checked,
            recurrence_frequency: fd.get('recurrence_frequency') || null,
            notes: fd.get('notes').trim() || null,
            created_by: user.id
        };

        if (!record.description || !record.category || !record.amount) {
            showToast('Date, category, amount, and description are required.', 'error');
            return;
        }

        if (isEdit) {
            delete record.created_by;
            const { error } = await supabase.from('operating_expenses').update(record).eq('id', exp.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Updated.', 'success');
        } else {
            const { error } = await supabase.from('operating_expenses').insert(record);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Added.', 'success');
        }

        closeModal('exp-modal');
        load();
    });
}

function exportData() {
    exportToExcel(`operating_expenses_${new Date().toISOString().split('T')[0]}.xlsx`, [{
        name: 'Expenses',
        data: allExpenses.map(e => ({
            Date: e.expense_date,
            Category: e.category,
            Description: e.description,
            Vendor: e.vendor || '',
            Amount: parseFloat(e.amount),
            Recurring: e.is_recurring ? 'Yes' : 'No',
            Frequency: e.recurrence_frequency || '',
            Notes: e.notes || ''
        }))
    }]);
}

init();
