import { signOut, getCurrentStaff, hasRole } from './auth.js';

const NAV_ITEMS = [
    {
        section: 'Investor Portal',
        items: [
            { label: 'Dashboard', href: 'investor-dashboard.html', icon: 'trending-up', roles: ['admin', 'investor'] },
            { label: 'Pro Forma', href: 'pro-forma.html', icon: 'calculator', roles: ['admin', 'investor'] },
            { label: 'Operating Expenses', href: 'operating-expenses.html', icon: 'credit-card', roles: ['admin'] },
            { label: 'Investors', href: 'investors.html', icon: 'users', roles: ['admin'] },
            { label: 'Investor Snapshots', href: 'investor-snapshots.html', icon: 'mail', roles: ['admin'] }
        ]
    },
    {
        section: 'Overview',
        items: [
            { label: 'Dashboard', href: 'dashboard.html', icon: 'home', roles: ['admin', 'billing', 'payroll'] },
            { label: 'My Work Queue', href: 'work-queue.html', icon: 'inbox', roles: ['admin', 'billing'] }
        ]
    },
    {
        section: 'Billing',
        items: [
            { label: 'Billing', href: 'billing.html', icon: 'dollar', roles: ['admin', 'billing'] },
            { label: 'Benefits Verification', href: 'benefits.html', icon: 'phone', roles: ['admin', 'billing'] },
            { label: 'Denials', href: 'denials.html', icon: 'alert', roles: ['admin', 'billing'] },
            { label: 'Clearinghouse', href: 'clearinghouse.html', icon: 'refresh', roles: ['admin', 'billing'] },
            { label: 'Contracts', href: 'contracts.html', icon: 'file-text', roles: ['admin', 'billing'] },
            { label: 'Authorizations', href: 'authorizations.html', icon: 'key', roles: ['admin', 'billing'] }
        ]
    },
    {
        section: 'Payroll',
        items: [
            { label: 'Payroll', href: 'payroll.html', icon: 'clock', roles: ['admin', 'payroll'] },
            { label: 'Staff', href: 'staff.html', icon: 'users', roles: ['admin', 'payroll'] }
        ]
    },
    {
        section: 'Management',
        items: [
            { label: 'Clients', href: 'clients.html', icon: 'user', roles: ['admin', 'billing', 'payroll'] },
            { label: 'Patient Balances', href: 'balances.html', icon: 'credit-card', roles: ['admin', 'billing'] },
            { label: 'Reports', href: 'reports.html', icon: 'bar-chart', roles: ['admin', 'billing', 'payroll'] },
            { label: 'Appeal Templates', href: 'templates.html', icon: 'mail', roles: ['admin', 'billing'] },
            { label: 'Users', href: 'users.html', icon: 'shield', roles: ['admin'] }
        ]
    }
];

const ICONS = {
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    dollar: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'bar-chart': '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    'refresh': '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    'shield': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    'inbox': '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    'alert': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    'key': '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    'credit-card': '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    'mail': '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    'search': '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    'phone': '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    'trending-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    'calculator': '<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="10" y2="10"/><line x1="12" y1="10" x2="14" y2="10"/><line x1="16" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="10" y2="14"/><line x1="12" y1="14" x2="14" y2="14"/><line x1="16" y1="14" x2="16" y2="18"/><line x1="8" y1="18" x2="10" y2="18"/><line x1="12" y1="18" x2="14" y2="18"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
};

function svgIcon(name) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

function renderNav() {
    const staff = getCurrentStaff();
    if (!staff) return;

    const currentPage = window.location.pathname.split('/').pop() || 'dashboard.html';

    // Build sidebar
    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    sidebar.id = 'sidebar';

    let navHTML = `
        <div class="sidebar-brand">
            <div class="brand-icon">A</div>
            <h2>Archways</h2>
        </div>
        <div style="padding: 8px 12px;">
            <div class="global-search">
                <input type="text" id="global-search-input" placeholder="Search claims, clients, checks..." autocomplete="off">
                <div class="search-results hidden" id="search-results"></div>
            </div>
        </div>
        <nav class="sidebar-nav">
    `;

    for (const section of NAV_ITEMS) {
        const visibleItems = section.items.filter(item =>
            !item.roles || item.roles.includes(staff.role)
        );
        if (visibleItems.length === 0) continue;

        navHTML += `<div class="nav-section"><div class="nav-section-label">${section.section}</div>`;
        for (const item of visibleItems) {
            const isActive = currentPage === item.href;
            navHTML += `<a href="${item.href}" class="nav-link${isActive ? ' active' : ''}">${svgIcon(item.icon)}<span>${item.label}</span></a>`;
        }
        navHTML += '</div>';
    }

    navHTML += `</nav>`;
    navHTML += `
        <div class="sidebar-footer">
            <div class="sidebar-user">
                <div class="avatar">${staff.first_name[0]}${staff.last_name[0]}</div>
                <div class="user-info">
                    <div class="user-name">${staff.first_name} ${staff.last_name}</div>
                    <div class="user-role">${staff.role}</div>
                </div>
                <button class="btn-ghost btn-sm" id="sign-out-btn" title="Sign out">${svgIcon('log-out')}</button>
            </div>
        </div>
    `;

    sidebar.innerHTML = navHTML;
    document.body.prepend(sidebar);

    // Sidebar backdrop (for mobile — tap to close)
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.id = 'sidebar-backdrop';
    backdrop.addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
        backdrop.classList.remove('visible');
        document.getElementById('mobile-menu-btn').innerHTML = svgIcon('menu');
    });
    document.body.prepend(backdrop);

    // Mobile menu button
    const menuBtn = document.createElement('button');
    menuBtn.className = 'mobile-menu-btn';
    menuBtn.id = 'mobile-menu-btn';
    menuBtn.innerHTML = svgIcon('menu');
    document.body.prepend(menuBtn);

    // Events
    document.getElementById('sign-out-btn').addEventListener('click', signOut);

    menuBtn.addEventListener('click', () => {
        const sb = document.getElementById('sidebar');
        sb.classList.toggle('open');
        backdrop.classList.toggle('visible', sb.classList.contains('open'));
        menuBtn.innerHTML = sb.classList.contains('open') ? svgIcon('x') : svgIcon('menu');
    });

    // Close sidebar on link click (mobile)
    sidebar.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 1024) {
                sidebar.classList.remove('open');
                backdrop.classList.remove('visible');
                menuBtn.innerHTML = svgIcon('menu');
            }
        });
    });

    // Wire up global search
    setupGlobalSearch();
}

async function setupGlobalSearch() {
    const input = document.getElementById('global-search-input');
    const results = document.getElementById('search-results');
    if (!input) return;

    // Dynamic import to avoid circular dependencies
    const { supabase } = await import('./supabase-client.js');

    let debounceTimer;

    const runSearch = async (q) => {
        if (!q || q.length < 2) {
            results.classList.add('hidden');
            return;
        }

        results.innerHTML = '<div class="search-result-item"><span class="spinner"></span> Searching...</div>';
        results.classList.remove('hidden');

        try {
            // Search clients
            const { data: clients } = await supabase
                .from('clients')
                .select('id, first_name, last_name, insurance_member_id, date_of_birth')
                .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,insurance_member_id.ilike.%${q}%`)
                .limit(5);

            // Search claims by claim number
            const { data: claimsByNum } = await supabase
                .from('claims')
                .select('id, cr_claim_id, service_date, cpt_code, billed_amount, status, clients(first_name, last_name)')
                .ilike('cr_claim_id', `%${q}%`)
                .limit(5);

            // Search payments by check number
            const { data: payments } = await supabase
                .from('payments')
                .select('id, check_number, check_date, payment_amount, insurance_payers(name)')
                .ilike('check_number', `%${q}%`)
                .limit(5);

            let html = '';

            if (clients && clients.length > 0) {
                html += '<div class="search-result-group"><div class="search-result-label">Clients</div>';
                for (const c of clients) {
                    html += `<div class="search-result-item" data-type="client" data-id="${c.id}">
                        <strong>${c.first_name} ${c.last_name}</strong>
                        <div class="text-muted">${c.insurance_member_id || 'No member ID'} ${c.date_of_birth ? '· DOB ' + c.date_of_birth : ''}</div>
                    </div>`;
                }
                html += '</div>';
            }

            if (claimsByNum && claimsByNum.length > 0) {
                html += '<div class="search-result-group"><div class="search-result-label">Claims</div>';
                for (const c of claimsByNum) {
                    const client = c.clients ? `${c.clients.last_name}, ${c.clients.first_name}` : '';
                    html += `<div class="search-result-item" data-type="claim" data-id="${c.id}">
                        <strong>#${c.cr_claim_id}</strong> — ${client}
                        <div class="text-muted">${c.service_date} · ${c.cpt_code} · $${c.billed_amount} · ${c.status}</div>
                    </div>`;
                }
                html += '</div>';
            }

            if (payments && payments.length > 0) {
                html += '<div class="search-result-group"><div class="search-result-label">Payments</div>';
                for (const p of payments) {
                    html += `<div class="search-result-item" data-type="payment" data-id="${p.id}">
                        <strong>Check #${p.check_number}</strong>
                        <div class="text-muted">${p.check_date || ''} · $${p.payment_amount} · ${p.insurance_payers?.name || ''}</div>
                    </div>`;
                }
                html += '</div>';
            }

            if (!html) {
                html = '<div class="search-result-item text-muted">No results</div>';
            }

            results.innerHTML = html;

            // Bind click handlers
            results.querySelectorAll('[data-type]').forEach(el => {
                el.addEventListener('click', async () => {
                    const type = el.dataset.type;
                    const id = el.dataset.id;
                    input.value = '';
                    results.classList.add('hidden');
                    if (type === 'claim') {
                        const { openClaimDetailModal } = await import('./claim-detail.js');
                        openClaimDetailModal(id);
                    } else if (type === 'client') {
                        window.location.href = 'clients.html?id=' + id;
                    } else if (type === 'payment') {
                        window.location.href = 'billing.html?tab=payments&id=' + id;
                    }
                });
            });
        } catch (err) {
            results.innerHTML = '<div class="search-result-item text-danger">Search failed</div>';
        }
    };

    input.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => runSearch(e.target.value.trim()), 250);
    });

    // Close results on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.global-search')) {
            results.classList.add('hidden');
        }
    });
}

export { renderNav, svgIcon, ICONS };
