import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { showToast, createModal, openModal, closeModal, formatDate } from './ui.js';

let lastPreviewHtml = null;
let lastPreviewMeta = null;
let investors = [];
let settings = {};

async function init() {
    const auth = await requireAuth(['admin']);
    if (!auth) return;
    renderNav();

    // Load investors
    const { data: invData } = await supabase
        .from('investors')
        .select('id, name, email')
        .eq('is_active', true)
        .order('name');
    investors = invData || [];

    const sel = document.getElementById('investor-select');
    for (const i of investors) {
        sel.innerHTML += `<option value="${i.id}">${i.name}${i.email ? ' (' + i.email + ')' : ''}</option>`;
    }

    // Load settings
    const { data: settingsRow } = await supabase
        .from('investor_snapshot_settings')
        .select('*')
        .eq('id', 1)
        .maybeSingle();
    settings = settingsRow || {};

    setupTabs();
    setupHandlers();
    await checkProviderStatus();
    await generatePreview();
    setupChecklistHandlers();
}

function setupChecklistHandlers() {
    document.getElementById('checklist-preview-btn').addEventListener('click', previewChecklist);
    document.getElementById('checklist-test-send-btn').addEventListener('click', sendChecklistTest);
}

async function previewChecklist() {
    const result = document.getElementById('checklist-result');
    result.innerHTML = '<div class="text-muted">Loading…</div>';
    try {
        const res = await fetch('/.netlify/functions/admin-weekly-checklist-manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'preview' })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);

        // Open the preview in a new window
        const w = window.open('', '_blank');
        w.document.write(data.html);
        w.document.close();
        result.innerHTML = `<div class="text-success">Preview opened in new tab. ${data.items} checklist items.</div>`;
    } catch (err) {
        result.innerHTML = '<div class="text-danger">Failed: ' + err.message + '</div>';
    }
}

async function sendChecklistTest() {
    const email = document.getElementById('checklist-test-email').value.trim();
    if (!email) {
        showToast('Enter your email first.', 'error');
        return;
    }
    const btn = document.getElementById('checklist-test-send-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const result = document.getElementById('checklist-result');

    try {
        const res = await fetch('/.netlify/functions/admin-weekly-checklist-manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ test_email: email })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        result.innerHTML = `<div class="text-success">Sent ${data.sent} of ${data.sent + data.failed}. ${data.items} checklist items.</div>`;
        showToast('Checklist sent to ' + email, 'success');
    } catch (err) {
        result.innerHTML = '<div class="text-danger">Failed: ' + err.message + '</div>';
        showToast('Failed: ' + err.message, 'error');
    }
    btn.disabled = false;
    btn.textContent = '📧 Send Test to This Email';
}

function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
            if (btn.dataset.tab === 'history') loadHistory();
        });
    });
}

function setupHandlers() {
    document.getElementById('period-select').addEventListener('change', generatePreview);
    document.getElementById('investor-select').addEventListener('change', generatePreview);
    document.getElementById('preview-btn').addEventListener('click', generatePreview);
    document.getElementById('send-test-btn').addEventListener('click', sendTest);
    document.getElementById('send-all-btn').addEventListener('click', sendToAll);
    document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
}

async function checkProviderStatus() {
    const div = document.getElementById('provider-status');
    div.innerHTML = '<span class="text-muted">Checking…</span>';

    try {
        const res = await fetch('/.netlify/functions/investor-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'status' })
        });
        const result = await res.json();

        if (result.email_configured) {
            div.innerHTML = `
                <div style="background:var(--color-success-light);padding:10px;border-radius:6px;">
                    <strong>✓ Outlook sending configured</strong>
                    <p style="margin:6px 0 0;font-size:0.78rem;">Emails will be sent from <code>${result.from_email}</code> via Microsoft Graph.</p>
                </div>
            `;
            // Enable send buttons
            document.getElementById('send-test-btn').disabled = false;
            document.getElementById('send-all-btn').disabled = false;
        } else {
            div.innerHTML = `
                <div style="background:var(--color-warning-light);padding:10px;border-radius:6px;">
                    <strong>📧 Outlook sending not yet configured.</strong>
                    <p style="margin:6px 0 0;font-size:0.78rem;">Preview works now. To send via your Outlook integration, copy these env vars from your CRM site to this site's Netlify env vars: <code>MS_TENANT_ID</code>, <code>MS_CLIENT_ID</code>, <code>MS_CLIENT_SECRET</code>, <code>MS_SENDER_EMAIL</code>.</p>
                </div>
            `;
            document.getElementById('send-test-btn').disabled = true;
            document.getElementById('send-all-btn').disabled = true;
        }
    } catch (err) {
        div.innerHTML = '<span class="text-danger">Failed: ' + err.message + '</span>';
    }
}

async function generatePreview() {
    const period = document.getElementById('period-select').value;
    const investorId = document.getElementById('investor-select').value || null;

    const previewBtn = document.getElementById('preview-btn');
    previewBtn.disabled = true;
    previewBtn.textContent = 'Generating…';

    try {
        const res = await fetch('/.netlify/functions/investor-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'preview',
                period,
                investor_id: investorId
            })
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'Preview failed');

        lastPreviewHtml = result.html;
        lastPreviewMeta = { period, investor: result.investor, subject: result.subject };

        // Render iframe
        const iframe = document.getElementById('preview-frame');
        const blob = new Blob([result.html], { type: 'text/html' });
        iframe.src = URL.createObjectURL(blob);

        // Meta
        document.getElementById('preview-meta').textContent =
            `${result.subject} → ${result.investor.name}`;
    } catch (err) {
        showToast('Preview failed: ' + err.message, 'error');
    }

    previewBtn.disabled = false;
    previewBtn.textContent = 'Generate Preview';
}

async function sendTest() {
    const email = document.getElementById('test-email').value.trim();
    if (!email) {
        showToast('Enter your email first.', 'error');
        return;
    }
    const period = document.getElementById('period-select').value;

    const btn = document.getElementById('send-test-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
        const res = await fetch('/.netlify/functions/investor-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'send_test', period, test_email: email })
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'Send failed');
        showToast(`Test sent to ${email}.`, 'success', 6000);
    } catch (err) {
        showToast('Failed: ' + err.message, 'error', 8000);
    }

    btn.disabled = false;
    btn.textContent = '📧 Send Test to Me';
}

async function sendToAll() {
    const period = document.getElementById('period-select').value;

    const targets = investors.filter(i => i.email);
    if (targets.length === 0) {
        showToast('No investors with email addresses on file.', 'error');
        return;
    }

    const ok = confirm(
        `This will send a ${period} snapshot to ${targets.length} investor${targets.length > 1 ? 's' : ''}:\n\n` +
        targets.map(i => `• ${i.name} (${i.email})`).join('\n') +
        '\n\nProceed?'
    );
    if (!ok) return;

    const btn = document.getElementById('send-all-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
        const res = await fetch('/.netlify/functions/investor-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'send', period })
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error || 'Send failed');

        const status = document.getElementById('send-status');
        status.innerHTML = `<strong>Sent ${result.sent}</strong> · Failed ${result.failed} · Skipped ${result.skipped}`;

        showToast(`Sent ${result.sent} of ${targets.length} snapshots.`, 'success', 6000);
        loadHistory();
    } catch (err) {
        showToast('Failed: ' + err.message, 'error', 8000);
    }

    btn.disabled = false;
    btn.textContent = '🚀 Send to All Investors';
}

async function loadHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '<div class="text-center text-muted" style="padding:20px;">Loading…</div>';

    try {
        const res = await fetch('/.netlify/functions/investor-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'history' })
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error);

        const snaps = result.snapshots || [];
        if (snaps.length === 0) {
            list.innerHTML = '<div class="empty-state"><p>No snapshots yet. Generate a preview to start.</p></div>';
            return;
        }

        let html = '<div class="card"><table class="data-table"><thead><tr><th>Generated</th><th>Period</th><th>Recipient</th><th>Status</th><th>Sent At</th></tr></thead><tbody>';
        for (const s of snaps) {
            const statusClass = s.send_status === 'sent' ? 'badge-sent' : s.send_status === 'failed' ? 'badge-failed' : 'badge-preview';
            html += `<tr>
                <td>${new Date(s.created_at).toLocaleString()}</td>
                <td>${s.period_type} (${formatDate(s.period_start)} – ${formatDate(s.period_end)})</td>
                <td>${s.investor_email || '—'}</td>
                <td><span class="send-status-badge ${statusClass}">${s.send_status}</span></td>
                <td>${s.sent_at ? new Date(s.sent_at).toLocaleString() : '—'}</td>
            </tr>`;
        }
        html += '</tbody></table></div>';
        list.innerHTML = html;
    } catch (err) {
        list.innerHTML = '<div class="text-danger">Failed: ' + err.message + '</div>';
    }
}

function openSettingsModal() {
    const bodyHTML = `
        <form id="settings-form">
            <div class="form-row">
                <div class="form-group">
                    <label class="form-label">Sender Name</label>
                    <input class="form-input" name="sender_name" value="${settings.sender_name || 'Archways ABA'}">
                </div>
                <div class="form-group">
                    <label class="form-label">Sender Email</label>
                    <input class="form-input" type="email" name="sender_email" value="${settings.sender_email || ''}" placeholder="reports@finance.archwaysaba.com">
                    <span class="text-xs text-muted">Must be verified in Resend</span>
                </div>
            </div>
            <div class="form-group">
                <label class="form-label">Custom Intro Message</label>
                <textarea class="form-textarea" name="custom_intro" rows="2" placeholder="Optional — replaces the auto-generated intro">${settings.custom_intro || ''}</textarea>
            </div>
            <div class="form-group">
                <label class="form-label">Sign-off</label>
                <textarea class="form-textarea" name="custom_signoff" rows="2" placeholder="Best,\nDavid Skaist">${settings.custom_signoff || ''}</textarea>
                <span class="text-xs text-muted">HTML supported. Default: "Best, David Skaist"</span>
            </div>

            <hr style="border:none;border-top:1px solid var(--color-border);margin:16px 0;">

            <p class="text-sm mb-2"><strong>Scheduled Sends</strong> — when enabled, snapshots auto-send on a schedule. Build out the portal first, then come back and turn these on.</p>

            <div class="form-group">
                <div class="form-check">
                    <input type="checkbox" name="weekly_enabled" id="set-weekly" ${settings.weekly_enabled ? 'checked' : ''}>
                    <label for="set-weekly">Send weekly snapshot</label>
                </div>
                <div class="form-row mt-1">
                    <div class="form-group">
                        <label class="form-label">Day of week</label>
                        <select class="form-select" name="weekly_day">
                            <option value="0" ${settings.weekly_day === 0 ? 'selected' : ''}>Sunday</option>
                            <option value="1" ${(settings.weekly_day === 1 || !settings.weekly_day) ? 'selected' : ''}>Monday</option>
                            <option value="2" ${settings.weekly_day === 2 ? 'selected' : ''}>Tuesday</option>
                            <option value="3" ${settings.weekly_day === 3 ? 'selected' : ''}>Wednesday</option>
                            <option value="4" ${settings.weekly_day === 4 ? 'selected' : ''}>Thursday</option>
                            <option value="5" ${settings.weekly_day === 5 ? 'selected' : ''}>Friday</option>
                            <option value="6" ${settings.weekly_day === 6 ? 'selected' : ''}>Saturday</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Hour (UTC)</label>
                        <input class="form-input" type="number" min="0" max="23" name="weekly_hour" value="${settings.weekly_hour ?? 9}">
                    </div>
                </div>
            </div>

            <div class="form-group">
                <div class="form-check">
                    <input type="checkbox" name="monthly_enabled" id="set-monthly" ${settings.monthly_enabled ? 'checked' : ''}>
                    <label for="set-monthly">Send monthly snapshot</label>
                </div>
                <div class="form-row mt-1">
                    <div class="form-group">
                        <label class="form-label">Day of month</label>
                        <input class="form-input" type="number" min="1" max="28" name="monthly_day" value="${settings.monthly_day ?? 1}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Hour (UTC)</label>
                        <input class="form-input" type="number" min="0" max="23" name="monthly_hour" value="${settings.monthly_hour ?? 9}">
                    </div>
                </div>
            </div>
        </form>
    `;

    createModal('settings-modal', 'Snapshot Settings', bodyHTML, `
        <button class="btn btn-secondary" id="set-cancel">Cancel</button>
        <button class="btn btn-primary" id="set-save">Save</button>
    `, 'modal-lg');
    openModal('settings-modal');

    document.getElementById('set-cancel').addEventListener('click', () => closeModal('settings-modal'));
    document.getElementById('set-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('settings-form'));
        const update = {
            sender_name: (fd.get('sender_name') || 'Archways ABA').trim(),
            sender_email: (fd.get('sender_email') || '').trim() || null,
            custom_intro: (fd.get('custom_intro') || '').trim() || null,
            custom_signoff: (fd.get('custom_signoff') || '').trim() || null,
            weekly_enabled: document.getElementById('set-weekly').checked,
            weekly_day: parseInt(fd.get('weekly_day')) || 1,
            weekly_hour: parseInt(fd.get('weekly_hour')) || 9,
            monthly_enabled: document.getElementById('set-monthly').checked,
            monthly_day: parseInt(fd.get('monthly_day')) || 1,
            monthly_hour: parseInt(fd.get('monthly_hour')) || 9
        };
        const { error } = await supabase
            .from('investor_snapshot_settings')
            .update(update)
            .eq('id', 1);
        if (error) { showToast('Failed: ' + error.message, 'error'); return; }
        settings = { ...settings, ...update };
        showToast('Settings saved.', 'success');
        closeModal('settings-modal');
        await generatePreview();
    });
}

init();
