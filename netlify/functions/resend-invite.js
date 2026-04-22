// Resend an invite email to a user who hasn't logged in yet
// Uses the magic-link/recovery flow so they can set a new password

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration missing' }) };
    }

    try {
        const { email } = JSON.parse(event.body);
        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'email is required' }) };
        }

        const siteUrl = process.env.SITE_URL ||
            process.env.URL ||
            (event.headers && (event.headers.origin || (event.headers.host ? `https://${event.headers.host}` : null))) ||
            'https://finance.archwaysaba.com';
        const redirectTo = `${siteUrl.replace(/\/$/, '')}/set-password.html`;

        const res = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            },
            body: JSON.stringify({ email, redirect_to: redirectTo })
        });

        const data = await res.json();
        if (!res.ok) {
            return {
                statusCode: res.status,
                body: JSON.stringify({ error: data.msg || data.message || 'Failed to resend invite' })
            };
        }

        return { statusCode: 200, body: JSON.stringify({ success: true, email }) };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
