// ============================================
// Shared Claim Workflow Utilities
// Activity logging, follow-ups, quick actions
// Used by work-queue, billing, denials pages
// ============================================

import { supabase } from './supabase-client.js';
import { getCurrentStaff } from './auth.js';
import { showToast, createModal, openModal, closeModal, formatCurrency, formatDate } from './ui.js';

// ----- Activity log helpers -----

async function logActivity(claimId, actionType, description, metadata = null, followUpDate = null) {
    const user = getCurrentStaff();
    if (!user) return null;

    const { data, error } = await supabase.from('claim_activities').insert({
        claim_id: claimId,
        user_id: user.id,
        action_type: actionType,
        description,
        metadata,
        follow_up_date: followUpDate
    }).select().single();

    if (error) {
        console.error('Failed to log activity:', error);
        return null;
    }

    return data;
}

async function getClaimActivities(claimId, limit = 50) {
    const { data, error } = await supabase
        .from('claim_activities')
        .select(`
            *,
            app_users(first_name, last_name)
        `)
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) return [];
    return data || [];
}

// ----- Follow-ups -----

async function scheduleFollowUp(claimId, dueDate, reason = null, priority = 'normal', assignedTo = null) {
    const user = getCurrentStaff();
    if (!user) return null;

    const { data, error } = await supabase.from('claim_followups').insert({
        claim_id: claimId,
        assigned_to: assignedTo || user.id,
        due_date: dueDate,
        reason,
        priority,
        created_by: user.id
    }).select().single();

    if (error) {
        showToast('Failed to schedule follow-up: ' + error.message, 'error');
        return null;
    }

    await logActivity(claimId, 'followup_scheduled', `Follow-up scheduled for ${formatDate(dueDate)}${reason ? ': ' + reason : ''}`, null, dueDate);
    return data;
}

async function completeFollowUp(followUpId, note = null) {
    const user = getCurrentStaff();
    const { error } = await supabase.from('claim_followups').update({
        completed_at: new Date().toISOString(),
        completed_by: user.id,
        completion_note: note
    }).eq('id', followUpId);

    if (error) {
        showToast('Failed to complete follow-up: ' + error.message, 'error');
        return false;
    }
    return true;
}

async function getMyFollowUps(userId = null, dueBy = null) {
    const user = userId || getCurrentStaff()?.id;
    if (!user) return [];

    let query = supabase
        .from('claim_followups')
        .select(`
            *,
            claims(
                id, cr_claim_id, service_date, cpt_code, units, billed_amount,
                paid_amount, status, client_id, payer_id,
                clients(first_name, last_name),
                insurance_payers(name)
            )
        `)
        .is('completed_at', null)
        .eq('assigned_to', user)
        .order('due_date');

    if (dueBy) query = query.lte('due_date', dueBy);

    const { data, error } = await query;
    if (error) return [];
    return data || [];
}

// ----- Quick action modals -----

function openCallModal(claim, onSuccess) {
    const bodyHTML = `
        <form id="call-form">
            <p class="text-sm text-muted mb-2">Document your call with the payer for this claim.</p>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Who did you speak with?</label>
                    <input class="form-input" name="contact_name" placeholder="Rep name or ID">
                </div>
                <div class="form-group">
                    <label class="form-label">Reference #</label>
                    <input class="form-input" name="reference_number" placeholder="Call reference number">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">What did they say? *</label>
                <textarea class="form-textarea" name="notes" rows="4" required placeholder="Claim pending review, will be processed in 7-10 days..."></textarea>
            </div>
            <div class="form-group">
                <label class="form-label">Follow up on</label>
                <input class="form-input" type="date" name="follow_up_date" value="${inXDays(7)}">
                <span class="text-xs text-muted">Leave blank if no follow-up needed</span>
            </div>
        </form>
    `;
    createModal('call-modal', 'Log Call to Payer', bodyHTML, `
        <button class="btn btn-secondary" id="call-cancel">Cancel</button>
        <button class="btn btn-primary" id="call-save">Save</button>
    `);
    openModal('call-modal');

    document.getElementById('call-cancel').addEventListener('click', () => closeModal('call-modal'));
    document.getElementById('call-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('call-form'));
        const contactName = fd.get('contact_name').trim();
        const refNum = fd.get('reference_number').trim();
        const notes = fd.get('notes').trim();
        const followUp = fd.get('follow_up_date');

        if (!notes) {
            showToast('Notes are required.', 'error');
            return;
        }

        let description = `Called payer`;
        if (contactName) description += ` (spoke with ${contactName})`;
        if (refNum) description += ` [ref #${refNum}]`;
        description += `: ${notes}`;

        await logActivity(claim.id, 'called', description, {
            contact_name: contactName,
            reference_number: refNum
        }, followUp || null);

        if (followUp) {
            await scheduleFollowUp(claim.id, followUp, 'Follow up after payer call');
        }

        closeModal('call-modal');
        showToast('Call logged.', 'success');
        if (onSuccess) onSuccess();
    });
}

function openNoteModal(claim, onSuccess) {
    const bodyHTML = `
        <form id="note-form">
            <div class="form-group">
                <label class="form-label">Note *</label>
                <textarea class="form-textarea" name="note" rows="4" required placeholder="Add a note to the claim history..."></textarea>
            </div>
        </form>
    `;
    createModal('note-modal', 'Add Note', bodyHTML, `
        <button class="btn btn-secondary" id="note-cancel">Cancel</button>
        <button class="btn btn-primary" id="note-save">Save</button>
    `);
    openModal('note-modal');

    document.getElementById('note-cancel').addEventListener('click', () => closeModal('note-modal'));
    document.getElementById('note-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('note-form'));
        const note = fd.get('note').trim();

        if (!note) {
            showToast('Note is required.', 'error');
            return;
        }

        await logActivity(claim.id, 'note', note);
        closeModal('note-modal');
        showToast('Note added.', 'success');
        if (onSuccess) onSuccess();
    });
}

function openFollowUpModal(claim, onSuccess) {
    const bodyHTML = `
        <form id="fu-form">
            <div class="form-group">
                <label class="form-label">Due Date *</label>
                <input class="form-input" type="date" name="due_date" required value="${inXDays(7)}">
            </div>
            <div class="form-group">
                <label class="form-label">Priority</label>
                <select class="form-select" name="priority">
                    <option value="low">Low</option>
                    <option value="normal" selected>Normal</option>
                    <option value="high">High</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Reason</label>
                <input class="form-input" name="reason" placeholder="Why follow up? e.g., 'Check on appeal status'">
            </div>
            <div class="flex gap-1 mb-1">
                <button type="button" class="btn btn-secondary btn-sm" data-days="3">+3 days</button>
                <button type="button" class="btn btn-secondary btn-sm" data-days="7">+1 week</button>
                <button type="button" class="btn btn-secondary btn-sm" data-days="14">+2 weeks</button>
                <button type="button" class="btn btn-secondary btn-sm" data-days="30">+30 days</button>
            </div>
        </form>
    `;
    createModal('fu-modal', 'Schedule Follow-Up', bodyHTML, `
        <button class="btn btn-secondary" id="fu-cancel">Cancel</button>
        <button class="btn btn-primary" id="fu-save">Schedule</button>
    `);
    openModal('fu-modal');

    // Quick date buttons
    document.querySelectorAll('[data-days]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelector('[name="due_date"]').value = inXDays(parseInt(btn.dataset.days));
        });
    });

    document.getElementById('fu-cancel').addEventListener('click', () => closeModal('fu-modal'));
    document.getElementById('fu-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('fu-form'));
        const due = fd.get('due_date');
        const priority = fd.get('priority');
        const reason = fd.get('reason').trim();

        if (!due) {
            showToast('Due date is required.', 'error');
            return;
        }

        await scheduleFollowUp(claim.id, due, reason || null, priority);
        closeModal('fu-modal');
        showToast(`Follow-up scheduled for ${formatDate(due)}`, 'success');
        if (onSuccess) onSuccess();
    });
}

// ----- Render activity log into a container -----

async function renderActivityLog(containerEl, claimId) {
    const container = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
    const activities = await getClaimActivities(claimId);

    if (activities.length === 0) {
        container.innerHTML = '<p class="text-sm text-muted">No activity yet. Add a note or log a call to start tracking.</p>';
        return;
    }

    const icons = {
        note: '📝', called: '📞', emailed: '✉️', resubmitted: '🔄',
        appealed: '⚖️', denial_logged: '❌', status_changed: '🔀',
        followup_scheduled: '📅', write_off: '🗑️',
        transferred_to_patient: '👤', payment_posted: '💰',
        eligibility_checked: '✅'
    };

    let html = '<div class="activity-timeline">';
    for (const a of activities) {
        const name = a.app_users ? `${a.app_users.first_name} ${a.app_users.last_name}` : 'System';
        const when = new Date(a.created_at);
        const ago = timeAgo(when);
        const icon = icons[a.action_type] || '•';

        html += `<div class="activity-item">
            <div class="activity-icon">${icon}</div>
            <div class="activity-body">
                <div class="activity-header">
                    <strong>${name}</strong>
                    <span class="text-xs text-muted">${ago} · ${when.toLocaleString()}</span>
                </div>
                <div class="activity-description">${escapeHtml(a.description)}</div>
                ${a.follow_up_date ? `<div class="text-xs text-muted">→ Follow-up scheduled for ${formatDate(a.follow_up_date)}</div>` : ''}
            </div>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
}

// ----- Helpers -----

function inXDays(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}

function timeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export {
    logActivity,
    getClaimActivities,
    scheduleFollowUp,
    completeFollowUp,
    getMyFollowUps,
    openCallModal,
    openNoteModal,
    openFollowUpModal,
    renderActivityLog,
    inXDays,
    timeAgo,
    escapeHtml
};
