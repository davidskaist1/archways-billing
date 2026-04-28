// Build the weekly admin checklist email
// Pulls live data from Supabase and produces a checklist of items
// the admin should review/update to keep the system accurate.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supaHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
};

function fmtMoney(v) {
    return '$' + (parseFloat(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

async function buildChecklist() {
    const now = new Date();
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const fortyFiveDaysAgo = new Date(now); fortyFiveDaysAgo.setDate(fortyFiveDaysAgo.getDate() - 45);
    const thirtyDaysOut = new Date(now); thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

    const items = [];

    // ----- 1. Last claim imported -----
    const lastClaimRes = await fetch(
        `${SUPABASE_URL}/rest/v1/claims?select=service_date,created_at&order=created_at.desc&limit=1`,
        { headers: supaHeaders }
    );
    const lastClaim = (await lastClaimRes.json())[0];
    if (!lastClaim) {
        items.push({
            type: 'action',
            priority: 'high',
            icon: '📥',
            title: 'No claims imported yet',
            detail: 'Import your latest CR claims export so the billing data is current.',
            link: '/billing.html'
        });
    } else {
        const daysSinceImport = Math.floor((now - new Date(lastClaim.created_at)) / (1000 * 60 * 60 * 24));
        if (daysSinceImport > 7) {
            items.push({
                type: 'action',
                priority: 'high',
                icon: '📥',
                title: `Claims data is ${daysSinceImport} days old`,
                detail: `Last claim imported on ${new Date(lastClaim.created_at).toLocaleDateString()}. Pull the latest CR export to keep AR current.`,
                link: '/billing.html'
            });
        }
    }

    // ----- 2. Stale claims (45+ days, no payment) -----
    const staleRes = await fetch(
        `${SUPABASE_URL}/rest/v1/claims?status=eq.submitted&paid_amount=eq.0&service_date=lt.${fortyFiveDaysAgo.toISOString().split('T')[0]}&select=id,billed_amount`,
        { headers: supaHeaders }
    );
    const staleList = await staleRes.json();
    if (staleList.length > 0) {
        const total = staleList.reduce((s, c) => s + parseFloat(c.billed_amount), 0);
        items.push({
            type: 'action',
            priority: 'high',
            icon: '⏰',
            title: `${staleList.length} stale claims (45+ days unpaid)`,
            detail: `${fmtMoney(total)} sitting unpaid. Call the payers and document.`,
            link: '/work-queue.html'
        });
    }

    // ----- 3. Open denials -----
    const denialsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/claim_denials?status=in.(open,in_progress)&select=id,denied_amount,appeal_deadline`,
        { headers: supaHeaders }
    );
    const denials = await denialsRes.json();
    if (denials.length > 0) {
        const total = denials.reduce((s, d) => s + parseFloat(d.denied_amount || 0), 0);
        const upcomingDeadlines = denials.filter(d =>
            d.appeal_deadline && new Date(d.appeal_deadline) <= thirtyDaysOut
        ).length;
        items.push({
            type: 'action',
            priority: upcomingDeadlines > 0 ? 'high' : 'medium',
            icon: '❌',
            title: `${denials.length} open denials${upcomingDeadlines > 0 ? ` (${upcomingDeadlines} with deadlines ≤ 30 days)` : ''}`,
            detail: `${fmtMoney(total)} in denied claims. Review and appeal where appropriate.`,
            link: '/denials.html'
        });
    }

    // ----- 4. Follow-ups due/overdue -----
    const today = now.toISOString().split('T')[0];
    const followupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/claim_followups?completed_at=is.null&due_date=lte.${today}&select=id,due_date`,
        { headers: supaHeaders }
    );
    const followups = await followupRes.json();
    if (followups.length > 0) {
        const overdue = followups.filter(f => f.due_date < today).length;
        items.push({
            type: 'action',
            priority: overdue > 5 ? 'high' : 'medium',
            icon: '📅',
            title: `${followups.length} follow-ups due${overdue > 0 ? ` (${overdue} overdue)` : ''}`,
            detail: 'Work through your queue.',
            link: '/work-queue.html'
        });
    }

    // ----- 5. Pending benefits verifications -----
    const pendingBVRes = await fetch(
        `${SUPABASE_URL}/rest/v1/benefit_verifications?status=in.(pending,in_progress)&select=id,clients(first_name,last_name)`,
        { headers: supaHeaders }
    );
    const pendingBVs = await pendingBVRes.json();
    if (pendingBVs.length > 0) {
        items.push({
            type: 'action',
            priority: 'medium',
            icon: '📞',
            title: `${pendingBVs.length} benefits verifications pending`,
            detail: 'Call insurance and document benefits for these clients.',
            link: '/benefits.html'
        });
    }

    // ----- 6. Pending auth requests -----
    const pendingAuthsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/authorizations?status=in.(requested,in_review)&select=id,request_date,request_follow_up_date`,
        { headers: supaHeaders }
    );
    const pendingAuths = await pendingAuthsRes.json();
    if (pendingAuths.length > 0) {
        const dueForFollowUp = pendingAuths.filter(a =>
            a.request_follow_up_date && a.request_follow_up_date <= today
        ).length;
        items.push({
            type: 'action',
            priority: dueForFollowUp > 0 ? 'high' : 'medium',
            icon: '🔑',
            title: `${pendingAuths.length} auth requests pending${dueForFollowUp > 0 ? ` (${dueForFollowUp} due for follow-up)` : ''}`,
            detail: 'Check status with insurance.',
            link: '/authorizations.html'
        });
    }

    // ----- 7. Auths expiring soon -----
    const expiringRes = await fetch(
        `${SUPABASE_URL}/rest/v1/authorizations?status=eq.active&end_date=lte.${thirtyDaysOut.toISOString().split('T')[0]}&end_date=gte.${today}&select=id,end_date`,
        { headers: supaHeaders }
    );
    const expiring = await expiringRes.json();
    if (expiring.length > 0) {
        items.push({
            type: 'action',
            priority: 'medium',
            icon: '⏳',
            title: `${expiring.length} auths expiring within 30 days`,
            detail: 'Renew before they lapse so billing isn\'t interrupted.',
            link: '/authorizations.html'
        });
    }

    // ----- 8. Payroll periods needing approval -----
    const payrollRes = await fetch(
        `${SUPABASE_URL}/rest/v1/payroll_periods?status=eq.draft&select=id,period_end`,
        { headers: supaHeaders }
    );
    const draftPayroll = await payrollRes.json();
    if (draftPayroll.length > 0) {
        items.push({
            type: 'action',
            priority: 'high',
            icon: '👥',
            title: `${draftPayroll.length} payroll period${draftPayroll.length > 1 ? 's' : ''} awaiting approval`,
            detail: 'Approve and export so staff get paid on time.',
            link: '/payroll.html'
        });
    }

    // ----- 9. Operating expenses missing recently -----
    const recentExpensesRes = await fetch(
        `${SUPABASE_URL}/rest/v1/operating_expenses?expense_date=gte.${sevenDaysAgo.toISOString().split('T')[0]}&select=id`,
        { headers: supaHeaders }
    );
    const recentExpenses = await recentExpensesRes.json();
    if (recentExpenses.length === 0) {
        items.push({
            type: 'reminder',
            priority: 'low',
            icon: '🧾',
            title: 'No operating expenses logged this week',
            detail: 'Drag in your latest Ramp / bank export to keep the financial picture current.',
            link: '/operating-expenses.html'
        });
    }

    // ----- 10. Investor capital this week -----
    const recentContribRes = await fetch(
        `${SUPABASE_URL}/rest/v1/investor_contributions?contribution_date=gte.${sevenDaysAgo.toISOString().split('T')[0]}&select=id,amount`,
        { headers: supaHeaders }
    );
    const recentContribs = await recentContribRes.json();
    items.push({
        type: 'reminder',
        priority: 'low',
        icon: '💰',
        title: 'Confirm any new investor funding',
        detail: recentContribs.length > 0
            ? `${recentContribs.length} contribution(s) totaling ${fmtMoney(recentContribs.reduce((s, c) => s + parseFloat(c.amount), 0))} logged this week. Verify against bank deposits.`
            : 'No contributions recorded this week. If the bank received funding, log it now.',
        link: '/investors.html'
    });

    // ----- 11. Unmatched payments -----
    const unmatchedRes = await fetch(
        `${SUPABASE_URL}/rest/v1/payments?is_matched=eq.false&select=id,payment_amount`,
        { headers: supaHeaders }
    );
    const unmatched = await unmatchedRes.json();
    if (unmatched.length > 0) {
        const total = unmatched.reduce((s, p) => s + parseFloat(p.payment_amount), 0);
        items.push({
            type: 'action',
            priority: 'medium',
            icon: '💵',
            title: `${unmatched.length} unmatched payments`,
            detail: `${fmtMoney(total)} in payments not yet linked to claims. Run auto-match or match manually.`,
            link: '/billing.html'
        });
    }

    // ----- 12. Always-show: weekly cycle metrics -----
    const cycleRes = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/get_cycle_metrics`,
        {
            method: 'POST',
            headers: supaHeaders,
            body: JSON.stringify({ days_back: 7 })
        }
    );
    const cycleData = await cycleRes.json();
    const cycle = Array.isArray(cycleData) ? cycleData[0] : cycleData;

    return {
        items: items.sort((a, b) => {
            const order = { high: 0, medium: 1, low: 2 };
            return order[a.priority] - order[b.priority];
        }),
        cycle,
        generatedAt: now.toISOString()
    };
}

function renderChecklistEmail(checklist, settings = {}) {
    const { items, cycle } = checklist;
    const senderName = settings.sender_name || 'Archways ABA';
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const highCount = items.filter(i => i.priority === 'high').length;
    const summary = items.length === 0
        ? '🎉 Everything looks current — no action items this week.'
        : `<strong>${items.length}</strong> item${items.length > 1 ? 's' : ''} to review${highCount > 0 ? ` (${highCount} high priority)` : ''}.`;

    const baseUrl = settings.site_url || 'https://finance.archwaysaba.com';

    const itemsHtml = items.map(item => {
        const priorityColor = item.priority === 'high' ? '#dc2626' : item.priority === 'medium' ? '#d97706' : '#6b7280';
        const priorityBg = item.priority === 'high' ? '#fef2f2' : item.priority === 'medium' ? '#fffbeb' : '#f9fafb';
        return `<tr><td style="padding:0 0 12px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${priorityBg};border-left:4px solid ${priorityColor};border-radius:6px;">
                <tr><td style="padding:14px 16px;">
                    <div style="display:flex;align-items:flex-start;gap:12px;">
                        <span style="font-size:22px;line-height:1;">${item.icon}</span>
                        <div style="flex:1;">
                            <div style="font-size:15px;font-weight:600;color:#111827;margin-bottom:4px;">${item.title}</div>
                            <div style="font-size:13px;color:#374151;line-height:1.5;">${item.detail}</div>
                            ${item.link ? `<a href="${baseUrl}${item.link}" style="display:inline-block;margin-top:8px;font-size:12px;color:${priorityColor};font-weight:600;text-decoration:none;">Open in app →</a>` : ''}
                        </div>
                    </div>
                </td></tr>
            </table>
        </td></tr>`;
    }).join('');

    const cycleStrip = cycle ? `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;">
            <tr>
                <td style="background:#eff6ff;padding:14px;border-radius:6px;text-align:center;width:33%;">
                    <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Last 7 Days</div>
                    <div style="font-size:18px;font-weight:700;color:#1B3A6B;margin-top:4px;">${fmtMoney(cycle.total_billed)}</div>
                    <div style="font-size:11px;color:#6b7280;">billed</div>
                </td>
                <td style="width:8px;"></td>
                <td style="background:#ecfdf5;padding:14px;border-radius:6px;text-align:center;width:33%;">
                    <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Clients Billed</div>
                    <div style="font-size:18px;font-weight:700;color:#059669;margin-top:4px;">${cycle.clients_billed || 0}</div>
                    <div style="font-size:11px;color:#6b7280;">distinct</div>
                </td>
                <td style="width:8px;"></td>
                <td style="background:#fffbeb;padding:14px;border-radius:6px;text-align:center;width:33%;">
                    <div style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">97153 Hours</div>
                    <div style="font-size:18px;font-weight:700;color:#d97706;margin-top:4px;">${parseFloat(cycle.total_hours_97153 || 0).toFixed(0)}</div>
                    <div style="font-size:11px;color:#6b7280;">direct therapy</div>
                </td>
            </tr>
        </table>
    ` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Weekly Admin Checklist</title></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;-webkit-font-smoothing:antialiased;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f3f4f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);">

<tr><td style="background:linear-gradient(135deg,#1B3A6B 0%,#2c5d9f 100%);padding:28px 32px;color:#ffffff;text-align:center;">
    <div style="font-size:13px;letter-spacing:0.06em;text-transform:uppercase;opacity:0.9;font-weight:600;">${senderName}</div>
    <h1 style="margin:6px 0 4px;font-size:22px;font-weight:700;color:#ffffff;">Weekly Admin Checklist</h1>
    <div style="font-size:13px;opacity:0.9;">${today}</div>
</td></tr>

<tr><td style="padding:24px 32px 0;">
    <p style="margin:0;font-size:15px;line-height:1.55;color:#374151;">${summary}</p>
    ${cycleStrip}
</td></tr>

<tr><td style="padding:0 32px 8px;">
    ${items.length === 0
        ? '<div style="text-align:center;padding:32px 0;font-size:48px;">✓</div>'
        : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${itemsHtml}</table>`
    }
</td></tr>

<tr><td style="padding:8px 32px 24px;">
    <p style="margin:0;font-size:13px;line-height:1.55;color:#6b7280;">
        Open the <a href="${baseUrl}/dashboard.html" style="color:#1B3A6B;text-decoration:none;font-weight:600;">main dashboard</a>
        for the full picture, or hit the links above to jump straight to each item.
    </p>
</td></tr>

<tr><td style="padding:18px 32px;border-top:1px solid #e5e7eb;background-color:#f9fafb;font-size:12px;color:#6b7280;text-align:center;">
    <div style="font-weight:600;color:#1B3A6B;margin-bottom:4px;">${senderName}</div>
    <div>Auto-generated weekly snapshot — ${new Date(checklist.generatedAt).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}</div>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

module.exports = { buildChecklist, renderChecklistEmail };
