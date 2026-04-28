// ============================================
// Investor Snapshot Builder
// Pulls metrics from Supabase and renders an email-safe HTML snapshot
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supaHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
};

function fmtMoney(v) {
    const n = parseFloat(v) || 0;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtMoneyDecimal(v) {
    const n = parseFloat(v) || 0;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(v) {
    return (parseInt(v) || 0).toLocaleString('en-US');
}

function fmtPct(v, decimals = 1) {
    return (parseFloat(v) || 0).toFixed(decimals) + '%';
}

function fmtDateRange(start, end) {
    const s = new Date(start + 'T00:00:00');
    const e = new Date(end + 'T00:00:00');
    const opts = { month: 'short', day: 'numeric', year: 'numeric' };
    return s.toLocaleDateString('en-US', opts) + ' – ' + e.toLocaleDateString('en-US', opts);
}

function pctChange(curr, prev) {
    const c = parseFloat(curr) || 0;
    const p = parseFloat(prev) || 0;
    if (p === 0) return c === 0 ? 0 : null;
    return ((c - p) / Math.abs(p)) * 100;
}

function trendLabel(curr, prev) {
    const change = pctChange(curr, prev);
    if (change === null) return { arrow: '', text: '—', color: '#666' };
    if (change > 0) return { arrow: '↑', text: '+' + change.toFixed(1) + '%', color: '#059669' };
    if (change < 0) return { arrow: '↓', text: change.toFixed(1) + '%', color: '#dc2626' };
    return { arrow: '→', text: 'flat', color: '#666' };
}

// ============================================
// METRICS COLLECTION
// ============================================

async function collectMetrics(periodType) {
    const now = new Date();
    let periodStart, periodEnd, prevStart, prevEnd, periodLabel;

    if (periodType === 'weekly') {
        // Last 7 days
        periodEnd = new Date(now);
        periodEnd.setDate(periodEnd.getDate() - 1); // yesterday
        periodStart = new Date(periodEnd);
        periodStart.setDate(periodStart.getDate() - 6); // 7 days total
        prevEnd = new Date(periodStart);
        prevEnd.setDate(prevEnd.getDate() - 1);
        prevStart = new Date(prevEnd);
        prevStart.setDate(prevStart.getDate() - 6);
        periodLabel = 'Weekly Snapshot';
    } else {
        // Last calendar month
        periodEnd = new Date(now.getFullYear(), now.getMonth(), 0); // last day of prev month
        periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        prevEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0);
        prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        periodLabel = 'Monthly Snapshot';
    }

    const periodStartStr = periodStart.toISOString().split('T')[0];
    const periodEndStr = periodEnd.toISOString().split('T')[0];
    const prevStartStr = prevStart.toISOString().split('T')[0];
    const prevEndStr = prevEnd.toISOString().split('T')[0];

    // ----- Capital raised (with period-level breakdown) -----
    const { capitalRaised, periodCapital, periodContribs } = await fetchInvestorData(periodStartStr, periodEndStr);

    // ----- Period revenue + activity -----
    const period = await fetchPeriodMetrics(periodStartStr, periodEndStr);
    const prev = await fetchPeriodMetrics(prevStartStr, prevEndStr);

    // ----- Lifetime / YTD -----
    const yearStart = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
    const ytd = await fetchPeriodMetrics(yearStart, periodEndStr);

    // ----- Outstanding AR -----
    const ar = await fetchOutstandingAR();

    // ----- Active counts -----
    const counts = await fetchActiveCounts();

    return {
        periodType,
        periodLabel,
        periodStart: periodStartStr,
        periodEnd: periodEndStr,
        prev,
        period,
        ytd,
        capital: {
            raised: capitalRaised,
            period_raised: periodCapital,
            period_contribs: periodContribs
        },
        ar,
        counts,
        generatedAt: now.toISOString()
    };
}

async function fetchInvestorData(periodStart, periodEnd) {
    const contribsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/investor_contributions?select=amount,contribution_date,contribution_type,notes&order=contribution_date.desc`,
        { headers: supaHeaders }
    );
    const contribs = await contribsRes.json();

    const capitalRaised = (contribs || []).reduce((s, c) => s + parseFloat(c.amount), 0);

    // Contributions in this specific period
    const periodContribs = periodStart && periodEnd
        ? (contribs || []).filter(c =>
            c.contribution_date >= periodStart && c.contribution_date <= periodEnd
          )
        : [];
    const periodCapital = periodContribs.reduce((s, c) => s + parseFloat(c.amount), 0);

    return { capitalRaised, periodCapital, periodContribs };
}

async function fetchPeriodMetrics(startDate, endDate) {
    // Claims billed in period
    const claimsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/claims?service_date=gte.${startDate}&service_date=lte.${endDate}&select=id,billed_amount,paid_amount,units,cpt_code,client_id`,
        { headers: supaHeaders }
    );
    const claims = await claimsRes.json();

    const billed = (claims || []).reduce((s, c) => s + parseFloat(c.billed_amount || 0), 0);
    const collected = (claims || []).reduce((s, c) => s + parseFloat(c.paid_amount || 0), 0);
    const distinctClients = new Set((claims || []).map(c => c.client_id)).size;
    const claimCount = (claims || []).length;
    const hours97153 = (claims || [])
        .filter(c => c.cpt_code === '97153')
        .reduce((s, c) => s + parseFloat(c.units || 0) / 4, 0);
    const hoursAll = (claims || [])
        .reduce((s, c) => s + parseFloat(c.units || 0) / 4, 0);

    // Operating expenses in period
    const opexRes = await fetch(
        `${SUPABASE_URL}/rest/v1/operating_expenses?expense_date=gte.${startDate}&expense_date=lte.${endDate}&select=amount`,
        { headers: supaHeaders }
    );
    const opex = (await opexRes.json() || []).reduce((s, e) => s + parseFloat(e.amount), 0);

    // Payroll periods that ended in this window
    const payrollRes = await fetch(
        `${SUPABASE_URL}/rest/v1/payroll_periods?period_end=gte.${startDate}&period_end=lte.${endDate}&status=in.(approved,exported)&select=gross_pay,total_hours`,
        { headers: supaHeaders }
    );
    const payrollData = await payrollRes.json() || [];
    const payroll = payrollData.reduce((s, p) => s + parseFloat(p.gross_pay), 0);
    const payrollHours = payrollData.reduce((s, p) => s + parseFloat(p.total_hours), 0);

    const totalCosts = opex + payroll;
    const netProfit = collected - totalCosts;
    const margin = collected > 0 ? (netProfit / collected) * 100 : 0;

    return {
        billed, collected, distinctClients, claimCount,
        hours97153, hoursAll, opex, payroll, payrollHours,
        totalCosts, netProfit, margin
    };
}

async function fetchOutstandingAR() {
    const res = await fetch(
        `${SUPABASE_URL}/rest/v1/claims?status=in.(submitted,partial,appealed)&select=billed_amount,paid_amount`,
        { headers: supaHeaders }
    );
    const claims = await res.json() || [];
    return claims.reduce((s, c) =>
        s + (parseFloat(c.billed_amount) - parseFloat(c.paid_amount || 0)), 0
    );
}

async function fetchActiveCounts() {
    const [clientsRes, staffRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/clients?is_active=eq.true&select=id`, { headers: { ...supaHeaders, 'Prefer': 'count=exact' } }),
        fetch(`${SUPABASE_URL}/rest/v1/staff?is_active=eq.true&select=id`, { headers: { ...supaHeaders, 'Prefer': 'count=exact' } })
    ]);
    const clientsData = await clientsRes.json();
    const staffData = await staffRes.json();
    return {
        clients: Array.isArray(clientsData) ? clientsData.length : 0,
        staff: Array.isArray(staffData) ? staffData.length : 0
    };
}

// ============================================
// EMAIL HTML RENDERING
// ============================================

function renderEmailHTML(metrics, settings = {}) {
    const periodRange = fmtDateRange(metrics.periodStart, metrics.periodEnd);

    const revTrend = trendLabel(metrics.period.collected, metrics.prev.collected);
    const billedTrend = trendLabel(metrics.period.billed, metrics.prev.billed);
    const clientsTrend = trendLabel(metrics.period.distinctClients, metrics.prev.distinctClients);
    const hoursTrend = trendLabel(metrics.period.hours97153, metrics.prev.hours97153);

    const intro = settings.custom_intro || generateAutoIntro(metrics);
    const signoff = settings.custom_signoff || 'Best,<br>David Skaist';
    const senderName = settings.sender_name || 'Archways ABA';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${metrics.periodLabel}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;-webkit-font-smoothing:antialiased;">

<div style="display:none;max-height:0;overflow:hidden;color:transparent;">
${metrics.periodLabel}: ${fmtMoney(metrics.period.collected)} collected · ${fmtInt(metrics.period.distinctClients)} clients · ${metrics.period.hours97153.toFixed(0)} hours of direct therapy.
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f3f4f6;padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1B3A6B 0%,#2c5d9f 100%);padding:32px 32px 28px;color:#ffffff;text-align:center;">
            <div style="font-size:14px;letter-spacing:0.05em;text-transform:uppercase;opacity:0.9;font-weight:600;">${senderName}</div>
            <h1 style="margin:8px 0 4px;font-size:24px;font-weight:700;color:#ffffff;">${metrics.periodLabel}</h1>
            <div style="font-size:13px;opacity:0.9;">${periodRange}</div>
          </td>
        </tr>

        <!-- Intro -->
        <tr>
          <td style="padding:28px 32px 8px;">
            <p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">${intro}</p>
          </td>
        </tr>

        <!-- Headline KPIs (2x2 grid) -->
        <tr>
          <td style="padding:8px 32px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                ${kpiTile('Revenue Collected', fmtMoney(metrics.period.collected), `${revTrend.arrow} ${revTrend.text} vs. previous`, revTrend.color, '#ecfdf5')}
                ${kpiTile('Clients Billed', fmtInt(metrics.period.distinctClients), `${clientsTrend.arrow} ${clientsTrend.text} vs. previous`, clientsTrend.color, '#eff6ff')}
              </tr>
              <tr><td colspan="2" style="height:12px;"></td></tr>
              <tr>
                ${kpiTile('Direct Therapy Hours (97153)', metrics.period.hours97153.toFixed(0), `${hoursTrend.arrow} ${hoursTrend.text} vs. previous`, hoursTrend.color, '#fffbeb')}
                ${kpiTile('Total Billed', fmtMoney(metrics.period.billed), `${billedTrend.arrow} ${billedTrend.text} vs. previous`, billedTrend.color, '#fef2f2')}
              </tr>
            </table>
          </td>
        </tr>

        <!-- Section: Period P&L -->
        <tr>
          <td style="padding:24px 32px 0;">
            <h2 style="margin:0 0 12px;font-size:16px;font-weight:700;color:#111827;border-bottom:2px solid #1B3A6B;padding-bottom:6px;">${metrics.periodType === 'weekly' ? 'This Week' : 'This Month'} P&L</h2>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">
              ${plRow('Revenue Collected', fmtMoney(metrics.period.collected), '#059669')}
              ${plRow('Payroll', '(' + fmtMoney(metrics.period.payroll) + ')', '#374151')}
              ${plRow('Operating Expenses', '(' + fmtMoney(metrics.period.opex) + ')', '#374151')}
              ${plRow('Net Profit', fmtMoney(metrics.period.netProfit), metrics.period.netProfit >= 0 ? '#059669' : '#dc2626', true)}
              ${plRow('Margin', fmtPct(metrics.period.margin), metrics.period.margin >= 20 ? '#059669' : metrics.period.margin >= 0 ? '#d97706' : '#dc2626')}
            </table>
          </td>
        </tr>

        <!-- Section: YTD -->
        <tr>
          <td style="padding:24px 32px 0;">
            <h2 style="margin:0 0 12px;font-size:16px;font-weight:700;color:#111827;border-bottom:2px solid #1B3A6B;padding-bottom:6px;">Year to Date</h2>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">
              ${plRow('YTD Revenue Collected', fmtMoney(metrics.ytd.collected))}
              ${plRow('YTD Net Profit', fmtMoney(metrics.ytd.netProfit), metrics.ytd.netProfit >= 0 ? '#059669' : '#dc2626', true)}
              ${plRow('Outstanding A/R', fmtMoney(metrics.ar), '#d97706')}
              ${plRow('Active Clients', fmtInt(metrics.counts.clients))}
              ${plRow('Active Staff', fmtInt(metrics.counts.staff))}
            </table>
          </td>
        </tr>

        <!-- Section: Capital Position -->
        <tr>
          <td style="padding:24px 32px 0;">
            <h2 style="margin:0 0 12px;font-size:16px;font-weight:700;color:#111827;border-bottom:2px solid #C9A843;padding-bottom:6px;">Capital Position</h2>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;">
              ${plRow('Total Capital Raised', fmtMoney(metrics.capital.raised), '#1B3A6B', true)}
              ${metrics.capital.period_raised > 0 ? plRow(`Capital Raised ${metrics.periodType === 'weekly' ? 'This Week' : 'This Month'}`, fmtMoney(metrics.capital.period_raised), '#059669', true) : ''}
            </table>
            ${metrics.capital.period_contribs && metrics.capital.period_contribs.length > 0 ? `
              <div style="margin-top:12px;background:#fffbeb;border-left:4px solid #C9A843;padding:12px 14px;border-radius:6px;">
                <div style="font-size:12px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">Recent Funding Activity</div>
                ${metrics.capital.period_contribs.map(c => `
                  <div style="font-size:13px;color:#374151;padding:4px 0;">
                    <strong>${fmtMoneyDecimal(c.amount)}</strong>
                    <span style="color:#6b7280;"> · ${new Date(c.contribution_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${c.contribution_type}</span>
                    ${c.notes ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${c.notes}</div>` : ''}
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </td>
        </tr>

        <!-- Footer message -->
        <tr>
          <td style="padding:28px 32px 8px;">
            <p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">${signoff}</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:24px 32px;border-top:1px solid #e5e7eb;background-color:#f9fafb;font-size:12px;color:#6b7280;text-align:center;">
            <div style="margin-bottom:6px;font-weight:600;color:#1B3A6B;">${senderName}</div>
            <div>This report was generated on ${new Date(metrics.generatedAt).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}</div>
            <div style="margin-top:6px;">Confidential — for investor use only.</div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>

</body>
</html>`;
}

function kpiTile(label, value, sub, subColor, bgColor) {
    return `<td width="50%" style="padding:0 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${bgColor};border-radius:8px;">
            <tr><td style="padding:14px 16px;">
                <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;">${label}</div>
                <div style="font-size:24px;font-weight:700;margin-top:4px;color:#111827;">${value}</div>
                <div style="font-size:11px;margin-top:4px;color:${subColor};font-weight:600;">${sub}</div>
            </td></tr>
        </table>
    </td>`;
}

function plRow(label, value, color = '#111827', bold = false) {
    const fw = bold ? '700' : '400';
    return `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #f3f4f6;font-weight:${fw};color:#374151;">${label}</td>
        <td style="padding:6px 0;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:${fw};color:${color};font-variant-numeric:tabular-nums;">${value}</td>
    </tr>`;
}

function generateAutoIntro(m) {
    const period = m.periodType === 'weekly' ? 'this week' : 'this month';
    const revChange = pctChange(m.period.collected, m.prev.collected);
    const profitable = m.period.netProfit > 0;

    let line = `Here's your ${m.periodType} snapshot for ${fmtDateRange(m.periodStart, m.periodEnd)}.`;

    if (m.period.collected > 0 || m.period.distinctClients > 0) {
        if (revChange !== null) {
            if (revChange > 5) line += ` Revenue is up ${revChange.toFixed(0)}% versus the prior ${m.periodType.replace('ly', '')} — strong momentum.`;
            else if (revChange < -5) line += ` Revenue dipped ${Math.abs(revChange).toFixed(0)}% compared to last ${m.periodType.replace('ly', '')}.`;
            else line += ` Numbers are tracking close to the prior ${m.periodType.replace('ly', '')}.`;
        }
        if (profitable) line += ' Net profit is positive for the period.';
    } else {
        line += ' Pre-revenue period — most metrics are still at zero. The system is ready and tracking will pick up once billing begins.';
    }

    return line;
}

module.exports = {
    collectMetrics,
    renderEmailHTML
};
