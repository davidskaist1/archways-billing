import { requireAuth } from './auth.js';
import { renderNav } from './nav.js';
import { supabase } from './supabase-client.js';
import { showToast, createModal, openModal, closeModal, confirmDialog } from './ui.js';

let templates = [];

async function init() {
    const auth = await requireAuth(['admin', 'billing']);
    if (!auth) return;
    renderNav();

    document.getElementById('add-template-btn').addEventListener('click', () => openModalForm());

    await load();
}

async function load() {
    const { data, error } = await supabase
        .from('appeal_templates')
        .select('*')
        .order('name');

    if (error) { showToast('Failed to load: ' + error.message, 'error'); return; }
    templates = data || [];
    render();
}

function render() {
    const list = document.getElementById('templates-list');

    if (templates.length === 0) {
        list.innerHTML = `<div class="empty-state">
            <h3>No templates yet</h3>
            <p>Click "+ New Template" to create your first appeal letter template.</p>
        </div>`;
        return;
    }

    let html = '<div class="grid-2 gap-lg">';
    for (const t of templates) {
        html += `<div class="card">
            <div class="flex-between mb-1">
                <div>
                    <strong>${t.name}</strong>
                    ${t.denial_category ? `<div class="text-xs text-muted">${t.denial_category.replace('_', ' ')}</div>` : ''}
                </div>
                <div style="display:flex;gap:4px;">
                    <button class="btn btn-ghost btn-sm edit-tpl" data-id="${t.id}">Edit</button>
                    <button class="btn btn-ghost btn-sm text-danger del-tpl" data-id="${t.id}">Delete</button>
                </div>
            </div>
            ${t.subject ? `<div class="text-sm mb-1"><strong>Subject:</strong> ${escapeHtml(t.subject)}</div>` : ''}
            <div style="white-space:pre-wrap;font-family:var(--font-mono);font-size:0.75rem;background:var(--color-bg);padding:8px;border-radius:4px;max-height:200px;overflow-y:auto;">${escapeHtml(t.content.substring(0, 500))}${t.content.length > 500 ? '...' : ''}</div>
        </div>`;
    }
    html += '</div>';
    list.innerHTML = html;

    list.querySelectorAll('.edit-tpl').forEach(btn => {
        btn.addEventListener('click', () => {
            const tpl = templates.find(t => t.id === btn.dataset.id);
            openModalForm(tpl);
        });
    });
    list.querySelectorAll('.del-tpl').forEach(btn => {
        btn.addEventListener('click', async () => {
            const ok = await confirmDialog('Delete this template? This cannot be undone.');
            if (!ok) return;
            const { error } = await supabase.from('appeal_templates').delete().eq('id', btn.dataset.id);
            if (error) { showToast('Failed to delete: ' + error.message, 'error'); return; }
            showToast('Template deleted.', 'success');
            load();
        });
    });
}

function openModalForm(tpl = null) {
    const isEdit = !!tpl;
    const bodyHTML = `
        <form id="tpl-form">
            <div class="form-group">
                <label class="form-label">Template Name *</label>
                <input class="form-input" name="name" required value="${tpl?.name || ''}" placeholder="e.g. Prior Auth Appeal - UHC">
            </div>
            <div class="form-group">
                <label class="form-label">Denial Category</label>
                <select class="form-select" name="denial_category">
                    <option value="">Any / Generic</option>
                    <option value="prior_auth" ${tpl?.denial_category === 'prior_auth' ? 'selected' : ''}>Prior Authorization</option>
                    <option value="medical_necessity" ${tpl?.denial_category === 'medical_necessity' ? 'selected' : ''}>Medical Necessity</option>
                    <option value="timely_filing" ${tpl?.denial_category === 'timely_filing' ? 'selected' : ''}>Timely Filing</option>
                    <option value="coding" ${tpl?.denial_category === 'coding' ? 'selected' : ''}>Coding</option>
                    <option value="eligibility" ${tpl?.denial_category === 'eligibility' ? 'selected' : ''}>Eligibility</option>
                    <option value="non_covered" ${tpl?.denial_category === 'non_covered' ? 'selected' : ''}>Non-Covered</option>
                    <option value="bundling" ${tpl?.denial_category === 'bundling' ? 'selected' : ''}>Bundling</option>
                    <option value="other" ${tpl?.denial_category === 'other' ? 'selected' : ''}>Other</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Subject Line</label>
                <input class="form-input" name="subject" value="${tpl?.subject || ''}" placeholder="Appeal for {{patient_name}}">
            </div>
            <div class="form-group">
                <label class="form-label">Letter Content *</label>
                <textarea class="form-textarea" name="content" rows="16" required style="font-family:var(--font-mono);font-size:0.85rem;">${tpl?.content || ''}</textarea>
            </div>
            ${isEdit ? `
                <div class="form-check">
                    <input type="checkbox" name="is_active" id="tpl-active" ${tpl.is_active ? 'checked' : ''}>
                    <label for="tpl-active">Active</label>
                </div>
            ` : ''}
        </form>
    `;

    createModal('tpl-modal', isEdit ? 'Edit Template' : 'New Template', bodyHTML, `
        <button class="btn btn-secondary" id="tpl-cancel">Cancel</button>
        <button class="btn btn-primary" id="tpl-save">Save</button>
    `, 'modal-lg');
    openModal('tpl-modal');

    document.getElementById('tpl-cancel').addEventListener('click', () => closeModal('tpl-modal'));
    document.getElementById('tpl-save').addEventListener('click', async () => {
        const fd = new FormData(document.getElementById('tpl-form'));
        const record = {
            name: fd.get('name').trim(),
            denial_category: fd.get('denial_category') || null,
            subject: fd.get('subject').trim() || null,
            content: fd.get('content').trim()
        };

        if (!record.name || !record.content) {
            showToast('Name and content are required.', 'error');
            return;
        }

        if (isEdit) {
            record.is_active = document.getElementById('tpl-active').checked;
            const { error } = await supabase.from('appeal_templates').update(record).eq('id', tpl.id);
            if (error) { showToast('Failed to update: ' + error.message, 'error'); return; }
            showToast('Template updated.', 'success');
        } else {
            const { error } = await supabase.from('appeal_templates').insert(record);
            if (error) { showToast('Failed to create: ' + error.message, 'error'); return; }
            showToast('Template created.', 'success');
        }

        closeModal('tpl-modal');
        load();
    });
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

init();
