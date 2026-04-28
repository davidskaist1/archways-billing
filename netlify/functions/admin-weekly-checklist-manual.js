// Manual trigger for the admin checklist (testing / on-demand)
// POST { test_email: "..." } to send to a specific address
// POST {} to send to all admin emails (or ADMIN_CHECKLIST_TO env var)

const { buildChecklist, renderChecklistEmail } = require('./_lib/admin-checklist-builder');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || process.env.MS_TENANT_ID;
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || process.env.MS_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
const OUTLOOK_FROM_EMAIL = process.env.OUTLOOK_FROM_EMAIL || process.env.MS_SENDER_EMAIL;
const ADMIN_CHECKLIST_TO = process.env.ADMIN_CHECKLIST_TO;
const SITE_URL = process.env.SITE_URL || 'https://finance.archwaysaba.com';
const EMAIL_CONFIGURED = !!(AZURE_TENANT_ID && AZURE_CLIENT_ID && AZURE_CLIENT_SECRET && OUTLOOK_FROM_EMAIL);

const supaHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'POST only' }) };
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server config missing' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const action = body.action || 'send';

    // Build checklist
    const checklist = await buildChecklist();
    const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/investor_snapshot_settings?id=eq.1&select=sender_name,sender_email`, { headers: supaHeaders });
    const settings = (await settingsRes.json())[0] || {};
    const html = renderChecklistEmail(checklist, { ...settings, site_url: SITE_URL });
    const subject = `Weekly Checklist — ${checklist.items.length} item${checklist.items.length === 1 ? '' : 's'} to review`;

    if (action === 'preview') {
        return { statusCode: 200, body: JSON.stringify({ ok: true, html, subject, items: checklist.items.length }) };
    }

    // Determine recipients
    let recipients = [];
    if (body.test_email) {
        recipients = [body.test_email];
    } else if (ADMIN_CHECKLIST_TO) {
        recipients = ADMIN_CHECKLIST_TO.split(',').map(s => s.trim()).filter(Boolean);
    } else {
        const adminRes = await fetch(
            `${SUPABASE_URL}/rest/v1/app_users?role=eq.admin&is_active=eq.true&select=email`,
            { headers: supaHeaders }
        );
        const admins = await adminRes.json();
        recipients = (admins || []).map(a => a.email).filter(Boolean);
    }

    if (recipients.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No recipients found' }) };
    }

    if (!EMAIL_CONFIGURED) {
        return {
            statusCode: 400,
            body: JSON.stringify({
                ok: false,
                error: 'Outlook not configured. Add MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SENDER_EMAIL.'
            })
        };
    }

    const tokenRes = await fetch(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: AZURE_CLIENT_ID,
            client_secret: AZURE_CLIENT_SECRET,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials'
        }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Token: ' + (tokenData.error_description || tokenData.error) }) };
    }
    const token = tokenData.access_token;

    const fromEmail = settings.sender_email || OUTLOOK_FROM_EMAIL;
    const fromName = settings.sender_name || 'Archways ABA';
    const results = [];

    for (const to of recipients) {
        try {
            const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: {
                        subject,
                        body: { contentType: 'HTML', content: html },
                        toRecipients: [{ emailAddress: { address: to } }],
                        from: { emailAddress: { address: fromEmail, name: fromName } }
                    },
                    saveToSentItems: true
                })
            });
            if (res.status === 202) {
                results.push({ to, ok: true });
            } else {
                const errText = await res.text();
                results.push({ to, ok: false, error: errText.substring(0, 200) });
            }
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
