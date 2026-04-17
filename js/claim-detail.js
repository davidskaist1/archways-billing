// ============================================
// Shared Claim Detail Modal
// Full claim view with activity log, quick actions,
// denial info, appeal tracking
// ============================================

import { supabase } from './supabase-client.js';
import { showToast, createModal, openModal, closeModal, formatCurrency, formatDate, statusBadge, confirmDialog } from './ui.js';
import {
    logActivity, renderActivityLog,
    openCallModal, openNoteModal, openFollowUpModal
} from './claim-workflow.js';

async function openClaimDetailModal(claimId, onRefresh) {
    // Fetch full claim data
    const { data: claim, error } = await supabase
        .from('claims')
        .select(`
            *,
            clients(id, first_name, last_name, date_of_birth, insurance_member_id, authorization_number),
            insurance_payers(id, name),
            staff:staff!claims_rendering_provider_id_fkey(first_name, last_name)
        `)
        .eq('id', claimId)
        .single();

    if (error || !claim) {
        showToast('Failed to load claim: ' + (error?.message || 'not found'), 'error');
        return;
    }

    // Fetch denials for this claim
    const { data: denials } = await supabase
        .from('claim_denials')
        .select('*, denial_codes(description)')
        .eq('claim_id', claimId)
        .order('denial_date', { ascending: false });

    // Fetch appeals
    const { data: appeals } = await supabase
        .from('claim_appeals')
        .select('*')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false });

    // Fetch open follow-ups
    const { data: followups } = await supabase
        .from('claim_followups')
        .select('*, assigned:app_users!claim_followups_assigned_to_fkey(first_name, last_name)')
        .eq('claim_id', claimId)
        .is('completed_at', null)
        .order('due_date');

    const clientName = claim.clients ? `${claim.clients.first_name} ${claim.clients.last_name}` : '(Unknown)';
    const payerName = claim.insurance_payers?.name || '(Unknown)';
    const providerName = claim.staff ? `${claim.staff.first_name} ${claim.staff.last_name}` : '';
    const age = Math.floor((new Date() - new Date(claim.service_date)) / (1000 * 60 * 60 * 24));

    const bodyHTML = `
        <div class="grid-2 gap-lg" style="grid-template-columns: 1fr 1fr;">
            <!-- Left: Claim details -->
            <div>
                <h4 class="mb-2">Claim Details</h4>
                <div class="card mb-2">
                    <div class="flex-between mb-1">
                        <strong>${clientName}</strong>
                        ${statusBadge(claim.status)}
                    </div>
                    <div class="text-sm text-muted">${claim.clients?.insurance_member_id ? 'Member: ' + claim.clients.insurance_member_id : ''}</div>
                    <hr style="border:none;border-top:1px solid var(--color-border);margin:10px 0;">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.85rem;">
                        <div><strong>Payer:</strong><br>${payerName}</div>
                        <div><strong>Claim #:</strong><br><span class="font-mono">${claim.cr_claim_id || '—'}</span></div>
                        <div><strong>Service Date:</strong><br>${formatDate(claim.service_date)}</div>
                        <div><strong>Age:</strong><br>${age} days</div>
                        <div><strong>CPT Code:</strong><br><span class="font-mono">${claim.cpt_code}${claim.modifier ? ' ' + claim.modifier : ''}</span></div>
                        <div><strong>Units:</strong><br>${claim.units}</div>
                        <div><strong>Provider:</strong><br>${providerName || '—'}</div>
                        <div><strong>Authorization:</strong><br>${claim.clients?.authorization_number || '—'}</div>
                    </div>
                    <hr style="border:none;border-top:1px solid var(--color-border);margin:10px 0;">
                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center;">
                        <div>
                            <div class="text-xs text-muted">Billed</div>
                            <div style="font-size:1.1rem;font-weight:700;">${formatCurrency(claim.billed_amount)}</div>
                        </div>
                        <div>
                            <div class="text-xs text-muted">Expected</div>
                            <div style="font-size:1.1rem;font-weight:700;">${claim.expected_amount ? formatCurrency(claim.expected_amount) : '—'}</div>
                        </div>
                        <div>
                            <div class="text-xs text-muted">Paid</div>
                            <div style="font-size:1.1rem;font-weight:700;color:${parseFloat(claim.paid_amount) > 0 ? 'var(--color-success)' : 'var(--color-text-muted)'};">${formatCurrency(claim.paid_amount)}</div>
                        </div>
                    </div>
                </div>

                <!-- Quick actions -->
                <h4 class="mb-1">Quick Actions</h4>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">
                    <button class="btn btn-secondary" id="act-call">📞 Log Call</button>
                    <button class="btn btn-secondary" id="act-note">📝 Add Note</button>
                    <button class="btn btn-secondary" id="act-followup">📅 Follow-up</button>
                    <button class="btn btn-secondary" id="act-resubmit">🔄 Mark Resubmitted</button>
                    <button class="btn btn-secondary" id="act-deny">❌ Log Denial</button>
                    <button class="btn btn-secondary" id="act-writeoff">🗑️ Write Off</button>
                </div>

                <!-- Open follow-ups -->
                ${followups && followups.length > 0 ? `
                    <h4 class="mb-1">Open Follow-ups</h4>
                    <div class="card mb-2">
                        ${followups.map(fu => `
                            <div class="flex-between mb-1">
                                <div>
                                    <strong>${formatDate(fu.due_date)}</strong> ${fu.priority === 'high' ? '🔥' : ''}
                                    <div class="text-sm text-muted">${fu.reason || 'No reason specified'}</div>
                                    <div class="text-xs text-muted">Assigned: ${fu.assigned ? fu.assigned.first_name + ' ' + fu.assigned.last_name : 'Unassigned'}</div>
                                </div>
                                <button class="btn btn-sm btn-success" data-complete-fu="${fu.id}">Complete</button>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}

                <!-- Denials -->
                ${denials && denials.length > 0 ? `
                    <h4 class="mb-1">Denials</h4>
                    <div class="card mb-2">
                        ${denials.map(d => `
                            <div class="mb-1">
                                <div class="flex-between">
                                    <strong>${formatDate(d.denial_date)}</strong>
                                    <span class="denial-category">${d.denial_category.replace('_', ' ')}</span>
                                </div>
                                ${d.denial_code ? `<div class="text-xs font-mono">${d.denial_code}${d.denial_codes?.description ? ': ' + d.denial_codes.description : ''}</div>` : ''}
                                <div class="text-sm">${d.denial_reason || ''}</div>
                                <div class="text-xs text-muted">Status: ${d.status} ${d.appeal_deadline ? '· Appeal deadline: ' + formatDate(d.appeal_deadline) : ''}</div>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}

                <!-- Appeals -->
                ${appeals && appeals.length > 0 ? `
                    <h4 class="mb-1">Appeals</h4>
                    <div class="card mb-2">
                        ${appeals.map(a => `
                            <div class="mb-1">
                                <div class="flex-between">
                                    <strong>${a.appeal_level} appeal</strong>
                                    ${statusBadge(a.status)}
                                </div>
                                <div class="text-xs text-muted">
                                    ${a.submitted_date ? 'Submitted ' + formatDate(a.submitted_date) : 'Draft'}
                                    ${a.deadline ? ' · Deadline ' + formatDate(a.deadline) : ''}
                                    ${a.reference_number ? ' · Ref #' + a.reference_number : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
            </div>

            <!-- Right: Activity log -->
            <div>
                <h4 class="mb-2">Activity Timeline</h4>
                <div id="activity-log"></div>
            </div>
        </div>
    `;

    const footerHTML = `
        <button class="btn btn-secondary" id="detail-close">Close</button>
    `;

    createModal('claim-detail-modal', 'Claim Details', bodyHTML, footerHTML, 'modal-xl');
    openModal('claim-detail-modal');

    // Render activity log
    await renderActivityLog('activity-log', claimId);

    const refresh = async () => {
        // Re-open modal with fresh data
        closeModal('claim-detail-modal');
        setTimeout(() => {
            openClaimDetailModal(claimId, onRefresh);
            if (onRefresh) onRefresh();
        }, 200);
    };

    // Bind actions
    document.getElementById('detail-close').addEventListener('click', () => {
        closeModal('claim-detail-modal');
        if (onRefresh) onRefresh();
    });

    document.getElementById('act-call').addEventListener('click', () => openCallModal(claim, refresh));
    document.getElementById('act-note').addEventListener('click', () => openNoteModal(claim, refresh));
    document.getElementById('act-followup').addEventListener('click', () => openFollowUpModal(claim, refresh));
    document.getElementById('act-resubmit').addEventListener('click', () => markResubmitted(claim, refresh));
    document.getElementById('act-deny').addEventListener('click', () => openDenialModal(claim, refresh));
    document.getElementById('act-writeoff').addEventListener('click', () => openWriteOffModal(claim, refresh));

    // Complete follow-up buttons
    document.querySelectorAll('[data-complete-fu]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const { error } = await supabase.from('claim_followups').update({
                completed_at: new Date().toISOString()
            }).eq('id', btn.dataset.completeFu);
            if (error) {
                showToast('Failed to complete: ' + error.message, 'error');
                return;
            }
            showToast('Follow-up completed.', 'success');
            refresh();
        });
    });
}

async function markResubmitted(claim, onSuccess) {
    const note = prompt('Add a note about this resubmission (optional):');
    if (note === null) return;

    await logActivity(claim.id, 'resubmitted', `Claim resubmitted${note ? ': ' + note : ''}`);

    // Reset status to submitted if it was denied
    if (claim.status === 'denied') {
        await supabase.from('claims').update({
            status: 'submitted',
            date_submitted: new Date().toISOString().split('T')[0]
        }).eq('id', claim.id);
    }

    showToast('Marked as resubmitted.', 'success');
    if (onSuccess) onSuccess();
}

async function openDenialModal(claim, onSuccess) {
    // Load denial codes
    const { data: codes } = await supabase.from('denial_codes').select('*').order('code');

    const codeOptions = (codes || []).map(c =>
        `<option value="${c.code}" data-category="${c.category}">${c.code} — ${c.description.substring(0, 60)}</option>`
    ).join('');

    const bodyHTML = `
        <form id="denial-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Denial Date *</label>
                    <input class="form-input" type="date" name="denial_date" required value="${new Date().toISOString().split('T')[0]}">
                </div>
                <div class="form-group">
                    <label class="form-label">Denied Amount</label>
                    <input class="form-input" type="number" step="0.01" name="denied_amount" value="${claim.billed_amount}">
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">CARC/RARC Code</label>
                <select class="form-select" name="denial_code" id="denial-code-select">
                    <option value="">— Select code (optional) —</option>
                    ${codeOptions}
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Category *</label>
                <select class="form-select" name="denial_category" id="denial-category" required>
                    <option value="">— Select category —</option>
                    <option value="prior_auth">Prior Authorization</option>
                    <option value="medical_necessity">Medical Necessity</option>
                    <option value="timely_filing">Timely Filing</option>
                    <option value="coding">Coding Error</option>
                    <option value="patient_info">Patient Information</option>
                    <option value="duplicate">Duplicate Claim</option>
                    <option value="contractual">Contractual Adjustment</option>
                    <option value="non_covered">Non-Covered</option>
                    <option value="eligibility">Eligibility</option>
                    <option value="coordination">Coordination of Benefits</option>
                    <option value="bundling">Bundling</option>
                    <option value="other">Other</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Denial Reason / Notes</label>
                <textarea class="form-textarea" name="denial_reason" rows="3" placeholder="Detail from the EOB/ERA..."></textarea>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Action Plan *</label>
                    <select class="form-select" name="action_plan" required>
                        <option value="">— Select action —</option>
                        <option value="appeal">Appeal</option>
                        <option value="correct_resubmit">Correct & Resubmit</option>
                        <option value="write_off">Write Off</option>
                        <option value="patient_responsibility">Transfer to Patient</option>
                        <option value="pending_review">Pending Internal Review</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Appeal Deadline</label>
                    <input class="form-input" type="date" name="appeal_deadline">
                    <span class="text-xs text-muted">Usually 90-180 days from denial</span>
                </div>
            </div>
        </form>
    `;

    createModal('log-denial-modal', 'Log Denial', bodyHTML, `
        <button class="btn btn-secondary" id="deny-cancel">Cancel</button>
        <button class="btn btn-primary" id="deny-save">Save Denial</button>
    `);
    openModal('log-denial-modal');

    // Auto-select category when code is chosen
    document.getElementById('denial-code-select').addEventListener('change', (e) => {
        const opt = e.target.selectedOptions[0];
        if (opt && opt.dataset.category) {
            document.getElementById('denial-category').value = opt.dataset.category;
        }
    });

    document.getElementById('deny-cancel').addEventListener('click', () => closeModal('log-denial-modal'));
    document.getElementById('deny-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('denial-form'));

        const record = {
            claim_id: claim.id,
            denial_date: fd.get('denial_date'),
            denial_code: fd.get('denial_code') || null,
            denial_category: fd.get('denial_category'),
            denial_reason: fd.get('denial_reason').trim() || null,
            denied_amount: parseFloat(fd.get('denied_amount')) || null,
            action_plan: fd.get('action_plan'),
            appeal_deadline: fd.get('appeal_deadline') || null,
            status: 'open'
        };

        if (!record.denial_category || !record.action_plan) {
            showToast('Category and action plan are required.', 'error');
            return;
        }

        const { error } = await supabase.from('claim_denials').insert(record);
        if (error) {
            showToast('Failed to log denial: ' + error.message, 'error');
            return;
        }

        // Update claim status to denied
        await supabase.from('claims').update({
            status: 'denied',
            denial_reason: record.denial_reason
        }).eq('id', claim.id);

        await logActivity(claim.id, 'denial_logged', `Denial logged: ${record.denial_category.replace('_', ' ')}${record.denial_reason ? ' — ' + record.denial_reason : ''}`);

        closeModal('log-denial-modal');
        showToast('Denial logged.', 'success');
        if (onSuccess) onSuccess();
    });
}

async function openWriteOffModal(claim, onSuccess) {
    const outstanding = parseFloat(claim.billed_amount) - parseFloat(claim.paid_amount || 0);

    const bodyHTML = `
        <form id="wo-form">
            <div class="card mb-2" style="background:var(--color-warning-light);">
                <p class="text-sm">Writing off this claim for <strong>${formatCurrency(outstanding)}</strong>.</p>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Amount *</label>
                    <input class="form-input" type="number" step="0.01" name="amount" value="${outstanding}" required>
                </div>
                <div class="form-group">
                    <label class="form-label">Category *</label>
                    <select class="form-select" name="reason_category" required>
                        <option value="">— Select —</option>
                        <option value="timely_filing">Timely Filing</option>
                        <option value="contractual">Contractual Adjustment</option>
                        <option value="small_balance">Small Balance</option>
                        <option value="uncollectable">Uncollectable</option>
                        <option value="goodwill">Goodwill</option>
                        <option value="bad_debt">Bad Debt</option>
                        <option value="other">Other</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Reason / Notes</label>
                <textarea class="form-textarea" name="reason" rows="3" placeholder="Why are we writing off this claim?"></textarea>
            </div>
        </form>
    `;

    createModal('wo-modal', 'Write Off Claim', bodyHTML, `
        <button class="btn btn-secondary" id="wo-cancel">Cancel</button>
        <button class="btn btn-danger" id="wo-save">Confirm Write-Off</button>
    `);
    openModal('wo-modal');

    document.getElementById('wo-cancel').addEventListener('click', () => closeModal('wo-modal'));
    document.getElementById('wo-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('wo-form'));

        const { getCurrentStaff } = await import('./auth.js');
        const user = getCurrentStaff();

        const record = {
            claim_id: claim.id,
            amount: parseFloat(fd.get('amount')),
            reason_category: fd.get('reason_category'),
            reason: fd.get('reason').trim() || null,
            created_by: user.id
        };

        const { error } = await supabase.from('write_offs').insert(record);
        if (error) {
            showToast('Failed to write off: ' + error.message, 'error');
            return;
        }

        // Update claim status to void
        await supabase.from('claims').update({
            status: 'void',
            adjustment_amount: parseFloat(claim.adjustment_amount || 0) + record.amount
        }).eq('id', claim.id);

        await logActivity(claim.id, 'write_off', `Written off ${formatCurrency(record.amount)} — ${record.reason_category}${record.reason ? ': ' + record.reason : ''}`);

        closeModal('wo-modal');
        showToast('Claim written off.', 'success');
        if (onSuccess) onSuccess();
    });
}

export {
    openClaimDetailModal,
    openDenialModal,
    openWriteOffModal,
    markResubmitted
};
