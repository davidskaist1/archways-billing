// Weekly admin checklist email
// Scheduled: Fridays at 9 AM Central Time (14:00 UTC)
// Also POSTable for manual test triggering.

const { schedule } = require('@netlify/functions');
const { buildChecklist, renderChecklistEmail } = require('./_lib/admin-checklist-builder');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Microsoft Graph credentials (same as investor-snapshot)
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || process.env.MS_TENANT_ID;
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || process.env.MS_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
const OUTLOOK_FROM_EMAIL = process.env.OUTLOOK_FROM_EMAIL || process.env.MS_SENDER_EMAIL;
const ADMIN_CHECKLIST_TO = process.env.ADMIN_CHECKLIST_TO; // who to send to (comma-separated for multiple)
const SITE_URL = process.env.SITE_URL || 'https://finance.archwaysaba.com';
const EMAIL_CONFIGURED = !!(AZURE_TENANT_ID && AZURE_CLIENT_ID && AZURE_CLIENT_SECRET && OUTLOOK_FROM_EMAIL);

const supaHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
};

const handler = async (event) => {
    const isScheduled = event.body?.includes('scheduled') || !event.httpMethod;
    const isManualTest = event.httpMethod === 'POST' && !isScheduled;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server config missing' }) };
    }

    // Determine recipients
    let recipients = [];
    if (isManualTest && event.body) {
        try {
            const body = JSON.parse(event.body);
            if (body.test_email) recipients = [body.test_email];
        } catch {}
    }
    if (recipients.length === 0) {
        if (ADMIN_CHECKLIST_TO) {
            recipients = ADMIN_CHECKLIST_TO.split(',').map(s => s.trim()).filter(Boolean);
        } else {
            // Default: send to all admin users
            const adminRes = await fetch(
                `${SUPABASE_URL}/rest/v1/app_users?role=eq.admin&is_active=eq.true&select=email`,
                { headers: supaHeaders }
            );
            const admins = await adminRes.json();
            recipients = (admins || []).map(a => a.email).filter(Boolean);
        }
    }

    if (recipients.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No recipients' }) };
    }

    // Get sender name from settings
    const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/investor_snapshot_settings?id=eq.1&select=sender_name,sender_email`, { headers: supaHeaders });
    const settings = (await settingsRes.json())[0] || {};

    // Build the checklist
    const checklist = await buildChecklist();
    const html = renderChecklistEmail(checklist, { ...settings, site_url: SITE_URL });
    const subject = `Weekly Checklist — ${checklist.items.length} item${checklist.items.length === 1 ? '' : 's'} to review`;

    if (!EMAIL_CONFIGURED) {
        return {
            statusCode: 200,
            body: JSON.stringify({
                ok: true,
                preview_only: true,
                recipients,
                subject,
                items: checklist.items,
                message: 'Email not configured — preview only. Add MS_TENANT_ID etc. to send.'
            })
        };
    }

    const results = [];
    const token = await getMicrosoftGraphToken();
    for (const to of recipients) {
        try {
            const res = await sendEmail(token, to, subject, html, settings);
            results.push({ to, ...res });
        } catch (err) {
            results.push({ to, ok: false, error: err.message });
        }
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            ok: true,
            sent: results.filter(r => r.ok).length,
            failed: results.filter(r => !r.ok).length,
            items: checklist.items.length,
            results
        })
    };
};

async function getMicrosoftGraphToken() {
    const tokenUrl = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`;
    const params = new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
    });
    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Token: ' + (data.error_description || data.error));
    return data.access_token;
}

async function sendEmail(token, to, subject, html, settings) {
    const fromEmail = settings.sender_email || OUTLOOK_FROM_EMAIL;
    const fromName = settings.sender_name || 'Archways ABA';
    const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`;
    const message = {
        message: {
            subject,
            body: { contentType: 'HTML', content: html },
            toRecipients: [{ emailAddress: { address: to } }],
            from: { emailAddress: { address: fromEmail, name: fromName } }
        },
        saveToSentItems: true
    };
    const res = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
    });
    if (res.status === 202) return { ok: true };
    const errText = await res.text();
    return { ok: false, error: errText };
}

// Schedule: every Friday at 14:00 UTC (9 AM Central in CDT, 8 AM Central in CST)
// User can adjust by editing the cron expression below.
exports.handler = schedule('0 14 * * 5', handler);
