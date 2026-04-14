// ============================================
// Shared UI Utilities
// Modals, Toasts, Tables, Pagination, Confirm
// ============================================

// --- Toast Notifications ---
let toastContainer = null;

function ensureToastContainer() {
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }
    return toastContainer;
}

function showToast(message, type = 'info', duration = 4000) {
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span>${message}</span>
        <button class="toast-close" aria-label="Close">&times;</button>
    `;
    container.appendChild(toast);

    toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
    setTimeout(() => toast.remove(), duration);
}

// --- Modal ---
function openModal(id) {
    const overlay = document.getElementById(id);
    if (overlay) overlay.classList.add('open');
}

function closeModal(id) {
    const overlay = document.getElementById(id);
    if (overlay) overlay.classList.remove('open');
}

function createModal(id, title, bodyHTML, footerHTML = '', sizeClass = '') {
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = id;
    overlay.innerHTML = `
        <div class="modal ${sizeClass}">
            <div class="modal-header">
                <h3>${title}</h3>
                <button class="modal-close" aria-label="Close">&times;</button>
            </div>
            <div class="modal-body">${bodyHTML}</div>
            ${footerHTML ? `<div class="modal-footer">${footerHTML}</div>` : ''}
        </div>
    `;

    document.body.appendChild(overlay);

    // Close on X button
    overlay.querySelector('.modal-close').addEventListener('click', () => closeModal(id));

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(id);
    });

    // Close on Escape
    const escHandler = (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('open')) {
            closeModal(id);
        }
    };
    document.addEventListener('keydown', escHandler);

    return overlay;
}

// --- Confirm Dialog ---
function confirmDialog(message, title = 'Confirm') {
    return new Promise((resolve) => {
        const id = 'confirm-dialog-' + Date.now();
        const modal = createModal(
            id,
            title,
            `<p>${message}</p>`,
            `<button class="btn btn-secondary" data-action="cancel">Cancel</button>
             <button class="btn btn-danger" data-action="confirm">Confirm</button>`
        );

        modal.querySelector('[data-action="cancel"]').addEventListener('click', () => {
            closeModal(id);
            setTimeout(() => modal.remove(), 200);
            resolve(false);
        });

        modal.querySelector('[data-action="confirm"]').addEventListener('click', () => {
            closeModal(id);
            setTimeout(() => modal.remove(), 200);
            resolve(true);
        });

        openModal(id);
    });
}

// --- Data Table Renderer ---
class DataTable {
    constructor(containerEl, options = {}) {
        this.container = typeof containerEl === 'string'
            ? document.getElementById(containerEl)
            : containerEl;
        this.columns = options.columns || [];
        this.data = [];
        this.sortCol = options.defaultSort || null;
        this.sortDir = options.defaultSortDir || 'asc';
        this.page = 1;
        this.pageSize = options.pageSize || 25;
        this.onRowClick = options.onRowClick || null;
        this.emptyMessage = options.emptyMessage || 'No data to display.';
        this.selectable = options.selectable || false;
        this.selectedIds = new Set();
    }

    setData(data) {
        this.data = data;
        this.page = 1;
        this.selectedIds.clear();
        this.render();
    }

    getSelected() {
        return this.data.filter(row => this.selectedIds.has(row.id));
    }

    getSortedData() {
        if (!this.sortCol) return [...this.data];
        const col = this.columns.find(c => c.key === this.sortCol);
        return [...this.data].sort((a, b) => {
            let va = a[this.sortCol];
            let vb = b[this.sortCol];
            if (va == null) va = '';
            if (vb == null) vb = '';
            if (col && col.type === 'number') {
                va = parseFloat(va) || 0;
                vb = parseFloat(vb) || 0;
            } else if (col && col.type === 'date') {
                va = new Date(va).getTime() || 0;
                vb = new Date(vb).getTime() || 0;
            } else {
                va = String(va).toLowerCase();
                vb = String(vb).toLowerCase();
            }
            if (va < vb) return this.sortDir === 'asc' ? -1 : 1;
            if (va > vb) return this.sortDir === 'asc' ? 1 : -1;
            return 0;
        });
    }

    getPagedData() {
        const sorted = this.getSortedData();
        const start = (this.page - 1) * this.pageSize;
        return sorted.slice(start, start + this.pageSize);
    }

    getTotalPages() {
        return Math.max(1, Math.ceil(this.data.length / this.pageSize));
    }

    render() {
        const paged = this.getPagedData();
        const totalPages = this.getTotalPages();

        let html = '<div class="table-container"><table class="data-table"><thead><tr>';

        if (this.selectable) {
            const allChecked = paged.length > 0 && paged.every(r => this.selectedIds.has(r.id));
            html += `<th style="width:36px"><input type="checkbox" class="select-all" ${allChecked ? 'checked' : ''}></th>`;
        }

        for (const col of this.columns) {
            const isSorted = this.sortCol === col.key;
            const arrow = isSorted ? (this.sortDir === 'asc' ? '&#9650;' : '&#9660;') : '&#9650;';
            html += `<th class="${isSorted ? 'sorted' : ''} ${col.align || ''}" data-sort="${col.key}">
                ${col.label}<span class="sort-icon">${arrow}</span>
            </th>`;
        }
        html += '</tr></thead><tbody>';

        if (paged.length === 0) {
            html += `<tr><td colspan="${this.columns.length + (this.selectable ? 1 : 0)}">
                <div class="empty-state"><h3>${this.emptyMessage}</h3></div>
            </td></tr>`;
        }

        for (const row of paged) {
            const clickable = this.onRowClick ? 'style="cursor:pointer"' : '';
            html += `<tr data-id="${row.id}" ${clickable}>`;

            if (this.selectable) {
                html += `<td><input type="checkbox" class="row-select" data-id="${row.id}" ${this.selectedIds.has(row.id) ? 'checked' : ''}></td>`;
            }

            for (const col of this.columns) {
                const val = row[col.key];
                const rendered = col.render ? col.render(val, row) : (val ?? '');
                const align = col.align === 'text-right' ? 'text-right' : col.align === 'text-center' ? 'text-center' : '';
                html += `<td class="${align} ${col.className || ''}">${rendered}</td>`;
            }
            html += '</tr>';
        }

        html += '</tbody></table>';

        // Pagination
        if (this.data.length > this.pageSize) {
            const start = (this.page - 1) * this.pageSize + 1;
            const end = Math.min(this.page * this.pageSize, this.data.length);
            html += `<div class="pagination">
                <span>Showing ${start}–${end} of ${this.data.length}</span>
                <div class="pagination-buttons">
                    <button class="pagination-btn" data-page="prev" ${this.page <= 1 ? 'disabled' : ''}>&laquo; Prev</button>`;

            for (let p = 1; p <= totalPages && p <= 7; p++) {
                html += `<button class="pagination-btn ${p === this.page ? 'active' : ''}" data-page="${p}">${p}</button>`;
            }
            if (totalPages > 7) {
                html += `<span>...</span><button class="pagination-btn ${totalPages === this.page ? 'active' : ''}" data-page="${totalPages}">${totalPages}</button>`;
            }

            html += `<button class="pagination-btn" data-page="next" ${this.page >= totalPages ? 'disabled' : ''}>Next &raquo;</button>
                </div></div>`;
        }

        html += '</div>';
        this.container.innerHTML = html;

        // Event listeners
        this.container.querySelectorAll('th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.dataset.sort;
                if (this.sortCol === key) {
                    this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortCol = key;
                    this.sortDir = 'asc';
                }
                this.render();
            });
        });

        this.container.querySelectorAll('.pagination-btn[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const val = btn.dataset.page;
                if (val === 'prev') this.page--;
                else if (val === 'next') this.page++;
                else this.page = parseInt(val);
                this.render();
            });
        });

        if (this.onRowClick) {
            this.container.querySelectorAll('tbody tr[data-id]').forEach(tr => {
                tr.addEventListener('click', (e) => {
                    if (e.target.type === 'checkbox') return;
                    const id = tr.dataset.id;
                    const row = this.data.find(r => String(r.id) === id);
                    if (row) this.onRowClick(row);
                });
            });
        }

        if (this.selectable) {
            this.container.querySelector('.select-all')?.addEventListener('change', (e) => {
                const checked = e.target.checked;
                paged.forEach(r => {
                    if (checked) this.selectedIds.add(r.id);
                    else this.selectedIds.delete(r.id);
                });
                this.render();
            });

            this.container.querySelectorAll('.row-select').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const id = cb.dataset.id;
                    if (e.target.checked) this.selectedIds.add(id);
                    else this.selectedIds.delete(id);
                    this.render();
                });
            });
        }
    }
}

// --- Format helpers ---
function formatCurrency(val) {
    const num = parseFloat(val);
    if (isNaN(num)) return '$0.00';
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(val) {
    if (!val) return '';
    const d = new Date(val + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusBadge(status) {
    const map = {
        submitted: 'badge-info',
        paid: 'badge-success',
        partial: 'badge-warning',
        denied: 'badge-danger',
        appealed: 'badge-warning',
        void: 'badge-secondary',
        draft: 'badge-secondary',
        approved: 'badge-success',
        exported: 'badge-info',
        active: 'badge-success',
        inactive: 'badge-secondary'
    };
    const cls = map[status] || 'badge-secondary';
    return `<span class="badge ${cls}">${status}</span>`;
}

export {
    showToast,
    openModal,
    closeModal,
    createModal,
    confirmDialog,
    DataTable,
    formatCurrency,
    formatDate,
    statusBadge
};
