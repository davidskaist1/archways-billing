import { signOut, getCurrentStaff, hasRole } from './auth.js';

const NAV_ITEMS = [
    {
        section: 'Overview',
        items: [
            { label: 'Dashboard', href: 'dashboard.html', icon: 'home', roles: null }
        ]
    },
    {
        section: 'Billing',
        items: [
            { label: 'Billing', href: 'billing.html', icon: 'dollar', roles: ['admin', 'billing'] },
            { label: 'Clearinghouse', href: 'clearinghouse.html', icon: 'refresh', roles: ['admin', 'billing'] },
            { label: 'Contracts', href: 'contracts.html', icon: 'file-text', roles: ['admin', 'billing'] }
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
            { label: 'Clients', href: 'clients.html', icon: 'user', roles: null },
            { label: 'Reports', href: 'reports.html', icon: 'bar-chart', roles: null },
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
        menuBtn.innerHTML = sb.classList.contains('open') ? svgIcon('x') : svgIcon('menu');
    });

    // Close sidebar on link click (mobile)
    sidebar.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 1024) {
                sidebar.classList.remove('open');
            }
        });
    });
}

export { renderNav, svgIcon, ICONS };
