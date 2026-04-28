// Investor snapshot — preview, send, or list snapshots
//
// Modes (POST body):
//   { action: 'preview', period: 'weekly'|'monthly' }
//     -> Returns rendered HTML and metrics WITHOUT sending.
//
//   { action: 'send', period: 'weekly'|'monthly' }
//     -> Sends emails to all recipient_emails configured in
//        investor_snapshot_settings. Requires Microsoft Graph
//        env vars. Returns send report.
//
//   { action: 'send_test', period: 'weekly'|'monthly', test_email: '...' }
//     -> Sends to the specified test email instead of all recipients.
//
//   { action: 'history' }
//     -> Returns last 50 snapshot records.

const { collectMetrics, renderEmailHTML } = require('./_lib/snapshot-builder');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Microsoft Graph (Outlook / Microsoft 365) credentials.
// Send mail using the existing Outlook integration the user already has.
//
// Accepted Netlify env var names (use either set):
//   AZURE_TENANT_ID    or  MS_TENANT_ID
//   AZURE_CLIENT_ID    or  MS_CLIENT_ID
//   AZURE_CLIENT_SECRET or MS_CLIENT_SECRET
//   OUTLOOK_FROM_EMAIL or MS_SENDER_EMAIL
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || process.env.MS_TENANT_ID;
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || process.env.MS_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || process.env.MS_CLIENT_SECRET;
const OUTLOOK_FROM_EMAIL = process.env.OUTLOOK_FROM_EMAIL || process.env.MS_SENDER_EMAIL;
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

    try {
        const body = JSON.parse(event.body || '{}');
        const action = body.action || 'preview';

        if (action === 'status') {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    email_configured: EMAIL_CONFIGURED,
                    provider: 'microsoft_graph',
                    from_email: EMAIL_CONFIGURED ? OUTLOOK_FROM_EMAIL : null
                })
            };
        }

        if (action === 'history') {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/investor_snapshots?select=id,period_type,period_start,period_end,investor_email,subject,sent_at,send_status,created_at&order=created_at.desc&limit=50`,
                { headers: supaHeaders }
            );
            const data = await res.json();
            return { statusCode: 200, body: JSON.stringify({ ok: true, snapshots: data || [] }) };
        }

        const period = body.period === 'monthly' ? 'monthly' : 'weekly';

        // Settings (includes recipient_emails)
        const settingsRes = await fetch(`${SUPABASE_URL}/rest/v1/investor_snapshot_settings?id=eq.1&select=*`, { headers: supaHeaders });
        const settings = (await settingsRes.json())[0] || {};

        // Always collect metrics
        const metrics = await collectMetrics(period);

        if (action === 'preview') {
            const html = renderEmailHTML(metrics, settings);
            const subject = `${metrics.periodLabel} — ${formatDate(metrics.periodStart)} to ${formatDate(metrics.periodEnd)}`;

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    mode: 'preview',
                    metrics,
                    html,
                    subject,
                    recipients: parseRecipients(settings.recipient_emails)
                })
            };
        }

        if (action === 'send_test') {
            if (!EMAIL_CONFIGURED) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        ok: false,
                        error: 'Outlook sending not configured. Add MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SENDER_EMAIL (or AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / OUTLOOK_FROM_EMAIL) to Netlify env vars.'
                    })
                };
            }
            const testEmail = body.test_email;
            if (!testEmail) {
                return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'test_email required' }) };
            }

            const html = renderEmailHTML(metrics, settings);
            const subject = `[TEST] ${metrics.periodLabel} — ${formatDate(metrics.periodStart)} to ${formatDate(metrics.periodEnd)}`;

            const result = await sendEmail(testEmail, subject, html, settings);
            await logSnapshot({
                period_type: period,
                period_start: metrics.periodStart,
                period_end: metrics.periodEnd,
                investor_id: null,
                investor_email: testEmail,
                subject,
                body_html: html,
                metrics,
                send_status: result.ok ? 'sent' : 'failed',
                send_error: result.error,
                provider_message_id: result.message_id,
                sent_at: result.ok ? new Date().toISOString() : null
            });

            return {
                statusCode: result.ok ? 200 : 500,
                body: JSON.stringify(result)
            };
        }

        if (action === 'send') {
            if (!EMAIL_CONFIGURED) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        ok: false,
                        error: 'Outlook sending not configured. Add MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SENDER_EMAIL (or AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / OUTLOOK_FROM_EMAIL) to Netlify env vars.'
                    })
                };
            }

            // Read recipient list from settings (one or more emails, separated by
            // newline / comma / semicolon).
            const recipients = parseRecipients(settings.recipient_emails);
            if (recipients.length === 0) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        ok: false,
                        error: 'No snapshot recipients configured. Add email addresses on the Capital page.'
                    })
                };
            }

            const html = renderEmailHTML(metrics, settings);
            const subject = `${metrics.periodLabel} — ${formatDate(metrics.periodStart)} to ${formatDate(metrics.periodEnd)}`;

            const results = [];
            for (const email of recipients) {
                const sendResult = await sendEmail(email, subject, html, settings);
                await logSnapshot({
                    period_type: period,
                    period_start: metrics.periodStart,
                    period_end: metrics.periodEnd,
                    investor_id: null,
                    investor_email: email,
                    subject,
                    body_html: html,
                    metrics,
                    send_status: sendResult.ok ? 'sent' : 'failed',
                    send_error: sendResult.error,
                    provider_message_id: sendResult.message_id,
                    sent_at: sendResult.ok ? new Date().toISOString() : null
                });

                results.push({
                    email,
                    status: sendResult.ok ? 'sent' : 'failed',
                    error: sendResult.error
                });
            }

            return {
                statusCode: 200,
                body: JSON.stringify({
                    ok: true,
                    sent: results.filter(r => r.status === 'sent').length,
                    failed: results.filter(r => r.status === 'failed').length,
                    results
                })
            };
        }

        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
    }
};

function parseRecipients(raw) {
    if (!raw) return [];
    return [...new Set(
        String(raw)
            .split(/[\n,;]+/)
            .map(e => e.trim())
            .filter(Boolean)
    )];
}

// Cache the Microsoft Graph access token between invocations within a warm
// Lambda. Tokens last ~1hr; we refresh ~5 min before expiry.
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

async function getMicrosoftGraphToken() {
    const now = Date.now();
    if (cachedAccessToken && now < cachedAccessTokenExpiresAt - 5 * 60 * 1000) {
        return cachedAccessToken;
    }

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
    if (!res.ok) {
        throw new Error(`Token request failed: ${data.error_description || data.error || JSON.stringify(data)}`);
    }
    cachedAccessToken = data.access_token;
    cachedAccessTokenExpiresAt = now + (data.expires_in * 1000);
    return cachedAccessToken;
}

async function sendEmail(to, subject, html, settings) {
    if (!EMAIL_CONFIGURED) {
        return { ok: false, error: 'Microsoft Graph credentials not configured' };
    }

    const fromEmail = settings.sender_email || OUTLOOK_FROM_EMAIL;
    const fromName = settings.sender_name || 'Archways ABA';

    try {
        const token = await getMicrosoftGraphToken();

        // Send via Graph: POST /users/{from-email}/sendMail
        // Note: 'from' is determined by the URL ({from-email}); we don't
        // include it in the body. The app must have Mail.Send permission
        // for this mailbox.
        const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`;

        const message = {
            message: {
                subject,
                body: {
                    contentType: 'HTML',
                    content: html
                },
                toRecipients: [
                    { emailAddress: { address: to } }
                ],
                from: {
                    emailAddress: {
                        address: fromEmail,
                        name: fromName
                    }
                }
            },
            saveToSentItems: true
        };

        const res = await fetch(sendUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(message)
        });

        if (res.status === 202) {
            // Graph returns 202 Accepted with no body on success
            return { ok: true, message_id: res.headers.get('request-id') || null };
        }

        const errBody = await res.text();
        let parsed = errBody;
        try { parsed = JSON.parse(errBody); } catch {}
        return {
            ok: false,
            error: typeof parsed === 'object'
                ? (parsed.error?.message || JSON.stringify(parsed))
                : errBody
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// Expose status check so the admin UI can show whether sending is configured
exports.isConfigured = () => EMAIL_CONFIGURED;

async function logSnapshot(record) {
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/investor_snapshots`, {
            method: 'POST',
            headers: { ...supaHeaders, 'Prefer': 'return=minimal' },
            body: JSON.stringify(record)
        });
    } catch (err) {
        console.error('Failed to log snapshot:', err);
    }
}

function formatDate(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
    });
}
