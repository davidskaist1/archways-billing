import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { DataTable, showToast, createModal, openModal, closeModal, formatCurrency, formatDate, statusBadge, confirmDialog } from './ui.js';

let table;
let allBalances = [];
let clients = [];

async function init() {
    const auth = await requireAuth(['admin', 'billing']);
    if (!auth) return;
    renderNav();

    const { data: cd } = await supabase.from('clients').select('id, first_name, last_name').eq('is_active', true).order('last_name');
    clients = cd || [];

    table = new DataTable('balances-table', {
        columns: [
            { key: 'charge_date', label: 'Date', type: 'date', render: v => formatDate(v) },
            { key: 'client_name', label: 'Client' },
            { key: 'balance_type', label: 'Type', render: v => v.replace('_', ' ') },
            { key: 'amount', label: 'Amount', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'paid_amount', label: 'Paid', type: 'number', align: 'text-right', render: v => formatCurrency(v) },
            { key: 'outstanding', label: 'Outstanding', type: 'number', align: 'text-right', render: v => `<strong>${formatCurrency(v)}</strong>` },
            { key: 'days_old', label: 'Age', align: 'text-center', render: v => {
                const cls = v > 90 ? 'text-danger font-bold' : v > 60 ? 'text-warning' : '';
                return `<span class="${cls}">${v}d</span>`;
            }},
            { key: 'status', label: 'Status', render: v => statusBadge(v) },
            { key: 'actions', label: '', render: (_, r) => `
                <button class="btn btn-ghost btn-sm record-pay" data-id="${r.id}" title="Record payment">💰</button>
                <button class="btn btn-ghost btn-sm edit-bal" data-id="${r.id}" title="Edit">✏️</button>
            `}
        ],
        defaultSort: 'charge_date',
        defaultSortDir: 'desc',
        emptyMessage: 'No patient balances.'
    });

    ['filter-client', 'filter-status', 'filter-type'].forEach(id => {
        document.getElementById(id).addEventListener('input', render);
        document.getElementById(id).addEventListener('change', render);
    });
    document.getElementById('add-balance-btn').addEventListener('click', () => openForm());

    await load();
}

async function load() {
    const { data, error } = await supabase
        .from('patient_balances')
        .select('*, clients(first_name, last_name)')
        .order('charge_date', { ascending: false });

    if (error) { showToast('Failed: ' + error.message, 'error'); return; }

    const now = new Date();
    allBalances = (data || []).map(b => ({
        ...b,
        client_name: b.clients ? `${b.clients.last_name}, ${b.clients.first_name}` : '(Unknown)',
        outstanding: parseFloat(b.amount) - parseFloat(b.paid_amount || 0),
        days_old: Math.floor((now - new Date(b.charge_date)) / (1000 * 60 * 60 * 24))
    }));

    updateKPIs();
    render();
}

function updateKPIs() {
    const outstanding = allBalances.filter(b => ['outstanding', 'partial'].includes(b.status));
    const totalOutstanding = outstanding.reduce((s, b) => s + b.outstanding, 0);
    const aged30 = outstanding.filter(b => b.days_old > 30).reduce((s, b) => s + b.outstanding, 0);
    const aged90 = outstanding.filter(b => b.days_old > 90).reduce((s, b) => s + b.outstanding, 0);

    // Collected this month
    const monthStart = new Date();
    monthStart.setDate(1);
    const collected = allBalances
        .filter(b => new Date(b.updated_at || b.created_at) >= monthStart && b.paid_amount > 0)
        .reduce((s, b) => s + parseFloat(b.paid_amount), 0);

    document.getElementById('kpi-outstanding').textContent = formatCurrency(totalOutstanding);
    document.getElementById('kpi-outstanding-count').textContent = `${outstanding.length} open balances`;
    document.getElementById('kpi-aged-30').textContent = formatCurrency(aged30);
    document.getElementById('kpi-aged-90').textContent = formatCurrency(aged90);
    document.getElementById('kpi-collected').textContent = formatCurrency(collected);
}

function render() {
    const cf = document.getElementById('filter-client').value.toLowerCase();
    const sf = document.getElementById('filter-status').value;
    const tf = document.getElementById('filter-type').value;

    let filtered = [...allBalances];
    if (cf) filtered = filtered.filter(b => b.client_name.toLowerCase().includes(cf));
    if (sf) filtered = filtered.filter(b => b.status === sf);
    if (tf) filtered = filtered.filter(b => b.balance_type === tf);

    table.setData(filtered);

    // Bind actions
    setTimeout(() => {
        document.querySelectorAll('.record-pay').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const b = allBalances.find(x => x.id === btn.dataset.id);
                if (b) openPaymentForm(b);
            });
        });
        document.querySelectorAll('.edit-bal').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const b = allBalances.find(x => x.id === btn.dataset.id);
                if (b) openForm(b);
            });
        });
    }, 50);
}

function openForm(balance = null) {
    const isEdit = !!balance;
    const clientOpts = clients.map(c =>
        `<option value="${c.id}" ${balance?.client_id === c.id ? 'selected' : ''}>${c.last_name}, ${c.first_name}</option>`
    ).join('');

    const bodyHTML = `
        <form id="bal-form">
            <div class="form-group">
                <label class="form-label">Client *</label>
                <select class="form-select" name="client_id" required>
                    <option value="">— Select —</option>
                    ${clientOpts}
                </select>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Amount *</label>
                    <input class="form-input" type="number" step="0.01" name="amount" required value="${balance?.amount || ''}">
                </div>
                <div class="form-group">
                    <label class="form-label">Type *</label>
                    <select class="form-select" name="balance_type" required>
                        <option value="copay" ${balance?.balance_type === 'copay' ? 'selected' : ''}>Copay</option>
                        <option value="deductible" ${balance?.balance_type === 'deductible' ? 'selected' : ''}>Deductible</option>
                        <option value="coinsurance" ${balance?.balance_type === 'coinsurance' ? 'selected' : ''}>Coinsurance</option>
                        <option value="non_covered" ${balance?.balance_type === 'non_covered' ? 'selected' : ''}>Non-Covered</option>
                        <option value="after_write_off" ${balance?.balance_type === 'after_write_off' ? 'selected' : ''}>After Write-Off</option>
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Charge Date *</label>
                    <input class="form-input" type="date" name="charge_date" required value="${balance?.charge_date || new Date().toISOString().split('T')[0]}">
                </div>
                <div class="form-group">
                    <label class="form-label">Due Date</label>
                    <input class="form-input" type="date" name="due_date" value="${balance?.due_date || ''}">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" name="notes" rows="2">${balance?.notes || ''}</textarea>
            </div>
        </form>
    `;

    createModal('bal-modal', isEdit ? 'Edit Balance' : 'Add Patient Balance', bodyHTML, `
        ${isEdit ? '<button class="btn btn-danger" id="bal-del">Delete</button>' : ''}
        <button class="btn btn-secondary" id="bal-cancel">Cancel</button>
        <button class="btn btn-primary" id="bal-save">Save</button>
    `);
    openModal('bal-modal');

    document.getElementById('bal-cancel').addEventListener('click', () => closeModal('bal-modal'));
    if (isEdit) {
        document.getElementById('bal-del').addEventListener('click', async () => {
            const ok = await confirmDialog('Delete this balance?');
            if (!ok) return;
            const { error } = await supabase.from('patient_balances').delete().eq('id', balance.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Deleted.', 'success');
            closeModal('bal-modal');
            load();
        });
    }
    document.getElementById('bal-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('bal-form'));
        const record = {
            client_id: fd.get('client_id'),
            amount: parseFloat(fd.get('amount')),
            balance_type: fd.get('balance_type'),
            charge_date: fd.get('charge_date'),
            due_date: fd.get('due_date') || null,
            notes: fd.get('notes').trim() || null
        };

        if (!record.client_id || !record.amount) {
            showToast('Client and amount are required.', 'error');
            return;
        }

        if (isEdit) {
            const { error } = await supabase.from('patient_balances').update(record).eq('id', balance.id);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Updated.', 'success');
        } else {
            const { error } = await supabase.from('patient_balances').insert(record);
            if (error) { showToast('Failed: ' + error.message, 'error'); return; }
            showToast('Created.', 'success');
        }
        closeModal('bal-modal');
        load();
    });
}

function openPaymentForm(balance) {
    const outstanding = balance.outstanding;

    const bodyHTML = `
        <form id="pay-form">
            <p class="text-sm mb-2">Recording payment for <strong>${balance.client_name}</strong></p>
            <p class="text-sm text-muted mb-2">Outstanding: ${formatCurrency(outstanding)}</p>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Payment Amount *</label>
                    <input class="form-input" type="number" step="0.01" name="payment" required value="${outstanding}">
                </div>
                <div class="form-group">
                    <label class="form-label">Payment Date</label>
                    <input class="form-input" type="date" name="payment_date" value="${new Date().toISOString().split('T')[0]}">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Note</label>
                <input class="form-input" name="note" placeholder="e.g. Check #1234, card on file, etc.">
            </div>
        </form>
    `;

    createModal('pay-modal', 'Record Patient Payment', bodyHTML, `
        <button class="btn btn-secondary" id="pay-cancel">Cancel</button>
        <button class="btn btn-primary" id="pay-save">Record Payment</button>
    `);
    openModal('pay-modal');

    document.getElementById('pay-cancel').addEventListener('click', () => closeModal('pay-modal'));
    document.getElementById('pay-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('pay-form'));
        const paymentAmt = parseFloat(fd.get('payment'));
        if (!paymentAmt || paymentAmt <= 0) {
            showToast('Valid payment amount required.', 'error');
            return;
        }

        const newPaid = parseFloat(balance.paid_amount || 0) + paymentAmt;
        const newStatus = newPaid >= parseFloat(balance.amount) ? 'paid' : 'partial';
        const newNotes = balance.notes
            ? `${balance.notes}\n[${fd.get('payment_date')}] Payment ${formatCurrency(paymentAmt)} — ${fd.get('note') || 'no note'}`
            : `[${fd.get('payment_date')}] Payment ${formatCurrency(paymentAmt)} — ${fd.get('note') || 'no note'}`;

        const { error } = await supabase.from('patient_balances').update({
            paid_amount: newPaid,
            status: newStatus,
            notes: newNotes
        }).eq('id', balance.id);

        if (error) { showToast('Failed: ' + error.message, 'error'); return; }
        showToast(`Recorded ${formatCurrency(paymentAmt)}. Status: ${newStatus}`, 'success');
        closeModal('pay-modal');
        load();
    });
}

init();
