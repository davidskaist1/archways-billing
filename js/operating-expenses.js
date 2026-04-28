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
    document.getElementById('import-btn').addEventListener('click', openImportModal);

    await load();
}

// ============================================
// AI-POWERED SPREADSHEET IMPORT
// ============================================

function openImportModal() {
    const bodyHTML = `
        <div id="import-step-1">
            <p class="text-sm text-muted mb-2">
                Drag in any spreadsheet of expenses (CSV, XLSX, XLS) — bank statement, credit card export, Ramp report, QuickBooks export, anything.
                <strong>Claude</strong> will read it, figure out the columns, categorize each line, and show you a preview to confirm before saving.
            </p>
            <div class="dropzone" id="exp-dropzone">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <p><strong>Drop your file here</strong> or click to browse</p>
                <p class="dropzone-hint">CSV, XLSX, XLS · Up to 200 rows per file</p>
                <input type="file" id="exp-file-input" accept=".csv,.xlsx,.xls" style="display:none">
            </div>
        </div>
        <div id="import-step-2" style="display:none;"></div>
        <div id="import-step-3" style="display:none;"></div>
    `;

    createModal('exp-import-modal', '📥 Import Expenses (AI-Powered)', bodyHTML, `
        <button class="btn btn-secondary" id="exp-import-cancel">Cancel</button>
    `, 'modal-xl');
    openModal('exp-import-modal');

    document.getElementById('exp-import-cancel').addEventListener('click', () => closeModal('exp-import-modal'));

    const dropzone = document.getElementById('exp-dropzone');
    const fileInput = document.getElementById('exp-file-input');

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleImportFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) handleImportFile(fileInput.files[0]);
    });
}

async function handleImportFile(file) {
    const step1 = document.getElementById('import-step-1');
    const step2 = document.getElementById('import-step-2');
    step1.style.display = 'none';
    step2.style.display = 'block';
    step2.innerHTML = `
        <div class="text-center" style="padding:40px 20px;">
            <div class="spinner" style="margin:0 auto 12px;"></div>
            <h3>Reading file…</h3>
            <p class="text-sm text-muted">${file.name} (${(file.size / 1024).toFixed(1)} KB)</p>
        </div>
    `;

    try {
        // Parse with SheetJS
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (json.length === 0) {
            throw new Error('File appears to be empty.');
        }
        if (json.length > 200) {
            showToast(`File has ${json.length} rows — only the first 200 will be processed. Re-import the rest in batches.`, 'warning', 8000);
        }

        const headers = Object.keys(json[0]);

        step2.innerHTML = `
            <div class="text-center" style="padding:40px 20px;">
                <div class="spinner" style="margin:0 auto 12px;"></div>
                <h3>Claude is analyzing ${Math.min(json.length, 200)} rows…</h3>
                <p class="text-sm text-muted">Categorizing and structuring expenses. This usually takes 5–15 seconds.</p>
            </div>
        `;

        // Send to AI
        const aiRes = await fetch('/.netlify/functions/parse-expenses-ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: json, headers })
        });

        const result = await aiRes.json();
        if (!result.ok) throw new Error(result.error || 'AI parsing failed');

        if (!result.expenses || result.expenses.length === 0) {
            throw new Error('No expenses extracted from this file. Check the format and try again.');
        }

        showImportPreview(result, file.name, json);

    } catch (err) {
        step2.innerHTML = `
            <div class="card" style="background:var(--color-danger-light);border-color:var(--color-danger);">
                <h3 class="text-danger">Import failed</h3>
                <p class="text-sm">${err.message}</p>
                <button class="btn btn-secondary mt-1" id="back-to-step1">← Try another file</button>
            </div>
        `;
        document.getElementById('back-to-step1').addEventListener('click', () => {
            step1.style.display = 'block';
            step2.style.display = 'none';
        });
    }
}

function showImportPreview(result, filename, rawRows) {
    const step2 = document.getElementById('import-step-2');
    const expenses = result.expenses;

    // Track which rows are selected (default: all that are not "low" confidence)
    const selected = new Set(expenses.map((_, i) => i));

    let html = `
        <div class="flex-between mb-2">
            <h3 style="margin:0;">Preview — ${expenses.length} expenses extracted</h3>
            <div class="text-sm text-muted">
                ${result.row_count_processed} of ${result.row_count_total} rows analyzed${result.skipped_rows.length > 0 ? ' · ' + result.skipped_rows.length + ' skipped' : ''}
            </div>
        </div>

        <p class="text-sm text-muted mb-2">Review and edit. Uncheck any rows you don't want to import. Click any field to adjust.</p>

        <div class="table-container" style="max-height:50vh;overflow-y:auto;">
            <table class="data-table">
                <thead>
                    <tr>
                        <th style="width:30px;"><input type="checkbox" id="exp-select-all" checked></th>
                        <th>Conf</th>
                        <th>Date</th>
                        <th>Category</th>
                        <th>Description</th>
                        <th>Vendor</th>
                        <th class="text-right">Amount</th>
                        <th class="text-center">Recurring</th>
                    </tr>
                </thead>
                <tbody id="exp-preview-tbody"></tbody>
            </table>
        </div>

        <div class="flex-between mt-2">
            <button class="btn btn-secondary" id="exp-back">← Try another file</button>
            <button class="btn btn-success" id="exp-confirm-import">
                Import <span id="exp-import-count">${expenses.length}</span> Expenses
            </button>
        </div>
    `;
    step2.innerHTML = html;

    const tbody = document.getElementById('exp-preview-tbody');

    function renderPreviewRows() {
        tbody.innerHTML = '';
        expenses.forEach((e, i) => {
            const tr = document.createElement('tr');
            tr.style.opacity = selected.has(i) ? '1' : '0.4';
            const confColor = e.confidence === 'high' ? 'badge-success' : e.confidence === 'medium' ? 'badge-warning' : 'badge-danger';

            tr.innerHTML = `
                <td><input type="checkbox" class="exp-row-check" data-idx="${i}" ${selected.has(i) ? 'checked' : ''}></td>
                <td><span class="badge ${confColor} text-xs">${e.confidence || '?'}</span></td>
                <td><input class="form-input" type="date" value="${e.expense_date || ''}" data-idx="${i}" data-field="expense_date" style="width:140px;font-size:0.8rem;padding:4px 6px;"></td>
                <td>
                    <select class="form-select" data-idx="${i}" data-field="category" style="font-size:0.8rem;padding:4px 6px;">
                        ${CATEGORIES.map(c => `<option value="${c}" ${e.category === c ? 'selected' : ''}>${c.replace(/_/g, ' ')}</option>`).join('')}
                    </select>
                </td>
                <td><input class="form-input" type="text" value="${escapeAttr(e.description || '')}" data-idx="${i}" data-field="description" style="font-size:0.8rem;padding:4px 6px;"></td>
                <td><input class="form-input" type="text" value="${escapeAttr(e.vendor || '')}" data-idx="${i}" data-field="vendor" style="font-size:0.8rem;padding:4px 6px;"></td>
                <td class="text-right"><input class="form-input" type="number" step="0.01" value="${e.amount || 0}" data-idx="${i}" data-field="amount" style="font-size:0.8rem;padding:4px 6px;text-align:right;width:100px;"></td>
                <td class="text-center"><input type="checkbox" data-idx="${i}" data-field="is_recurring" ${e.is_recurring ? 'checked' : ''}></td>
            `;
            tbody.appendChild(tr);
        });

        // Bind row inputs
        tbody.querySelectorAll('input[type=text], input[type=number], input[type=date], select').forEach(el => {
            el.addEventListener('input', (ev) => {
                const idx = parseInt(ev.target.dataset.idx);
                const field = ev.target.dataset.field;
                if (field === 'amount') {
                    expenses[idx][field] = parseFloat(ev.target.value) || 0;
                } else {
                    expenses[idx][field] = ev.target.value;
                }
            });
        });
        tbody.querySelectorAll('input[type=checkbox][data-field=is_recurring]').forEach(el => {
            el.addEventListener('change', (ev) => {
                const idx = parseInt(ev.target.dataset.idx);
                expenses[idx].is_recurring = ev.target.checked;
            });
        });
        tbody.querySelectorAll('input[type=checkbox].exp-row-check').forEach(el => {
            el.addEventListener('change', (ev) => {
                const idx = parseInt(ev.target.dataset.idx);
                if (ev.target.checked) selected.add(idx); else selected.delete(idx);
                ev.target.closest('tr').style.opacity = ev.target.checked ? '1' : '0.4';
                document.getElementById('exp-import-count').textContent = selected.size;
            });
        });
    }

    renderPreviewRows();

    document.getElementById('exp-select-all').addEventListener('change', (ev) => {
        if (ev.target.checked) {
            expenses.forEach((_, i) => selected.add(i));
        } else {
            selected.clear();
        }
        renderPreviewRows();
        document.getElementById('exp-import-count').textContent = selected.size;
    });

    document.getElementById('exp-back').addEventListener('click', () => {
        document.getElementById('import-step-1').style.display = 'block';
        step2.style.display = 'none';
        step2.innerHTML = '';
    });

    document.getElementById('exp-confirm-import').addEventListener('click', async () => {
        await confirmImport(expenses, selected);
    });
}

async function confirmImport(expenses, selectedSet) {
    const btn = document.getElementById('exp-confirm-import');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const user = getCurrentStaff();
    const toInsert = [...selectedSet].map(idx => {
        const e = expenses[idx];
        return {
            expense_date: e.expense_date,
            category: e.category,
            description: e.description,
            amount: parseFloat(e.amount) || 0,
            vendor: (e.vendor || '').trim() || null,
            is_recurring: !!e.is_recurring,
            recurrence_frequency: e.recurrence_frequency || null,
            notes: e.notes || null,
            created_by: user.id
        };
    }).filter(e => e.expense_date && e.category && e.description && e.amount);

    if (toInsert.length === 0) {
        showToast('No valid expenses to import.', 'error');
        btn.disabled = false;
        btn.textContent = 'Import';
        return;
    }

    try {
        const { error } = await supabase.from('operating_expenses').insert(toInsert);
        if (error) throw error;
        showToast(`Imported ${toInsert.length} expenses.`, 'success', 6000);
        closeModal('exp-import-modal');
        load();
    } catch (err) {
        showToast('Insert failed: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Import';
    }
}

function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
