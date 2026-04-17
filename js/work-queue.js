import { requireAuth, getCurrentStaff } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { showToast, formatCurrency, formatDate } from './ui.js';
import {
    getMyFollowUps, completeFollowUp,
    openCallModal, openNoteModal, openFollowUpModal,
    logActivity, inXDays, timeAgo
} from './claim-workflow.js';
import { openClaimDetailModal } from './claim-detail.js';

let currentQueue = 'today';
let allData = {};
let payers = [];

async function init() {
    const auth = await requireAuth();
    if (!auth) return;
    renderNav();

    const user = getCurrentStaff();
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('greeting').textContent = `${greeting}, ${user.first_name}`;
    document.getElementById('period-label').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Load payers
    const { data: payerData } = await supabase.from('insurance_payers').select('id, name').eq('is_active', true).order('name');
    payers = payerData || [];
    for (const p of payers) {
        document.getElementById('filter-payer').innerHTML += `<option value="${p.id}">${p.name}</option>`;
    }

    // Tab switching
    document.querySelectorAll('.queue-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.queue-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentQueue = tab.dataset.queue;
            renderQueue();
        });
    });

    // Filter/sort
    document.getElementById('filter-payer').addEventListener('change', renderQueue);
    document.getElementById('sort-by').addEventListener('change', renderQueue);
    document.getElementById('refresh-btn').addEventListener('click', loadAll);

    await loadAll();
}

async function loadAll() {
    const today = new Date().toISOString().split('T')[0];
    const weekOut = inXDays(7);
    const fortyFiveAgo = new Date();
    fortyFiveAgo.setDate(fortyFiveAgo.getDate() - 45);
    const fortyFiveAgoStr = fortyFiveAgo.toISOString().split('T')[0];

    // My follow-ups due today, overdue, upcoming
    const myFollowUps = await getMyFollowUps();

    const today_ = myFollowUps.filter(fu => fu.due_date === today);
    const overdue = myFollowUps.filter(fu => fu.due_date < today);
    const upcoming = myFollowUps.filter(fu => fu.due_date > today && fu.due_date <= weekOut);

    // Open denials
    const { data: denials } = await supabase
        .from('claim_denials')
        .select(`
            *,
            claims(
                id, cr_claim_id, service_date, cpt_code, units, billed_amount, paid_amount, status,
                client_id, payer_id,
                clients(first_name, last_name),
                insurance_payers(name)
            )
        `)
        .in('status', ['open', 'in_progress'])
        .order('denial_date', { ascending: false });

    // Stale claims: 45+ days, submitted, no payment
    const { data: stale } = await supabase
        .from('claims')
        .select(`
            *,
            clients(first_name, last_name),
            insurance_payers(name)
        `)
        .eq('status', 'submitted')
        .eq('paid_amount', 0)
        .lt('service_date', fortyFiveAgoStr)
        .order('service_date');

    // Underpaid: paid but less than 95% of expected
    const { data: underpaidRaw } = await supabase
        .from('claims')
        .select(`
            *,
            clients(first_name, last_name),
            insurance_payers(name)
        `)
        .in('status', ['partial', 'paid'])
        .gt('paid_amount', 0);

    const underpaid = (underpaidRaw || []).filter(c => {
        const expected = parseFloat(c.expected_amount || c.billed_amount);
        const paid = parseFloat(c.paid_amount);
        return expected > 0 && paid < expected * 0.95;
    });

    allData = {
        today: today_,
        overdue,
        upcoming,
        denials: denials || [],
        stale: stale || [],
        underpaid
    };

    // Update counts
    document.getElementById('count-today').textContent = today_.length;
    document.getElementById('count-overdue').textContent = overdue.length;
    document.getElementById('count-upcoming').textContent = upcoming.length;
    document.getElementById('count-denials').textContent = (denials || []).length;
    document.getElementById('count-stale').textContent = (stale || []).length;
    document.getElementById('count-underpaid').textContent = underpaid.length;

    renderQueue();
}

function renderQueue() {
    const listEl = document.getElementById('queue-list');
    const data = allData[currentQueue] || [];
    const payerFilter = document.getElementById('filter-payer').value;
    const sortBy = document.getElementById('sort-by').value;

    // Apply payer filter
    let filtered = data.filter(item => {
        const claim = item.claims || item;
        if (payerFilter && claim.payer_id !== payerFilter) return false;
        return true;
    });

    // Sort
    filtered.sort((a, b) => {
        const ca = a.claims || a;
        const cb = b.claims || b;
        switch (sortBy) {
            case 'amount_desc':
                return parseFloat(cb.billed_amount || 0) - parseFloat(ca.billed_amount || 0);
            case 'age':
                return new Date(ca.service_date) - new Date(cb.service_date);
            case 'priority':
                const pri = { high: 3, normal: 2, low: 1 };
                return (pri[b.priority] || 2) - (pri[a.priority] || 2);
            default:
                if (a.due_date && b.due_date) return new Date(a.due_date) - new Date(b.due_date);
                return new Date(ca.service_date) - new Date(cb.service_date);
        }
    });

    if (filtered.length === 0) {
        listEl.innerHTML = `<div class="empty-state"><h3>All clear!</h3><p>Nothing in this queue right now.</p></div>`;
        return;
    }

    let html = '';
    for (const item of filtered) {
        html += renderQueueItem(item);
    }
    listEl.innerHTML = html;

    // Bind handlers
    listEl.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleAction(btn.dataset.action, btn.dataset.itemId);
        });
    });

    listEl.querySelectorAll('.queue-item').forEach(card => {
        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-action]')) return;
            const itemId = card.dataset.itemId;
            openClaim(itemId);
        });
    });
}

function renderQueueItem(item) {
    // Item could be a follow-up (with .claims nested), a claim, or a denial
    let claim, extraInfo = '', itemId, priority = 'normal';

    if (item.claims) {
        // Follow-up or denial
        claim = item.claims;
        itemId = claim.id;
        if (item.due_date) {
            // Follow-up
            const dueInfo = formatDate(item.due_date);
            extraInfo = `<div class="queue-item-reason">📅 ${dueInfo}${item.reason ? ' — ' + item.reason : ''}</div>`;
            priority = item.priority || 'normal';
        } else if (item.denial_category) {
            // Denial
            extraInfo = `<div class="queue-item-reason">❌ ${item.denial_category.replace('_', ' ')}: ${item.denial_reason || 'Denial pending review'}</div>`;
            priority = 'high';
        }
    } else {
        claim = item;
        itemId = claim.id;
        const age = Math.floor((new Date() - new Date(claim.service_date)) / (1000 * 60 * 60 * 24));

        if (currentQueue === 'stale') {
            extraInfo = `<div class="queue-item-reason">⏰ ${age} days old, no payment received</div>`;
            priority = age > 90 ? 'high' : 'normal';
        } else if (currentQueue === 'underpaid') {
            const expected = parseFloat(claim.expected_amount || claim.billed_amount);
            const paid = parseFloat(claim.paid_amount);
            const shortfall = expected - paid;
            extraInfo = `<div class="queue-item-reason">💸 Underpaid by ${formatCurrency(shortfall)} (expected ${formatCurrency(expected)}, got ${formatCurrency(paid)})</div>`;
            priority = shortfall > 100 ? 'high' : 'normal';
        }
    }

    const clientName = claim.clients ? `${claim.clients.last_name}, ${claim.clients.first_name}` : '(Unknown)';
    const payerName = claim.insurance_payers?.name || '(Unknown)';

    return `
        <div class="queue-item priority-${priority}" data-item-id="${itemId}">
            <div class="queue-item-header">
                <div>
                    <div class="queue-item-title">${clientName}</div>
                    <div class="queue-item-meta">
                        <span>${payerName}</span>
                        <span>·</span>
                        <span>${formatDate(claim.service_date)}</span>
                        <span>·</span>
                        <span class="font-mono">${claim.cpt_code}</span>
                        <span>·</span>
                        <span>${claim.units} units</span>
                    </div>
                </div>
                <div class="text-right">
                    <div style="font-size:1.1rem;font-weight:700;">${formatCurrency(claim.billed_amount)}</div>
                    ${claim.paid_amount > 0 ? `<div class="text-xs text-success">${formatCurrency(claim.paid_amount)} paid</div>` : ''}
                </div>
            </div>
            ${extraInfo}
            <div class="queue-item-actions">
                <button class="btn btn-sm btn-secondary" data-action="call" data-item-id="${itemId}">📞 Log Call</button>
                <button class="btn btn-sm btn-secondary" data-action="note" data-item-id="${itemId}">📝 Note</button>
                <button class="btn btn-sm btn-secondary" data-action="followup" data-item-id="${itemId}">📅 Follow-up</button>
                ${item.id && item.due_date ? `<button class="btn btn-sm btn-success" data-action="complete" data-item-id="${item.id}">✓ Done</button>` : ''}
                <button class="btn btn-sm btn-primary" data-action="open" data-item-id="${itemId}">Open</button>
            </div>
        </div>
    `;
}

async function handleAction(action, itemId) {
    // Find the claim
    let claim = null;
    for (const queue of Object.values(allData)) {
        for (const item of queue) {
            const c = item.claims || item;
            if (c.id === itemId) {
                claim = c;
                break;
            }
        }
        if (claim) break;
    }

    if (action === 'complete') {
        // Complete the follow-up
        const ok = await completeFollowUp(itemId);
        if (ok) {
            showToast('Follow-up completed.', 'success');
            await loadAll();
        }
        return;
    }

    if (!claim) return;

    const refresh = () => loadAll();

    if (action === 'call') openCallModal(claim, refresh);
    else if (action === 'note') openNoteModal(claim, refresh);
    else if (action === 'followup') openFollowUpModal(claim, refresh);
    else if (action === 'open') openClaim(claim.id);
}

async function openClaim(claimId) {
    await openClaimDetailModal(claimId, loadAll);
}

init();
