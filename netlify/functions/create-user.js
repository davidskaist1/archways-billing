// Create a user via Supabase invite flow
// Sends an invite email; user clicks link and sets their own password on /set-password.html
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY env vars

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration missing' }) };
    }

    const supabaseHeaders = {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    };

    try {
        const { first_name, last_name, email, role } = JSON.parse(event.body);

        if (!first_name || !last_name || !email || !role) {
            return { statusCode: 400, body: JSON.stringify({ error: 'first_name, last_name, email, and role are required' }) };
        }

        if (!['admin', 'billing', 'payroll', 'investor'].includes(role)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Role must be admin, billing, payroll, or investor' }) };
        }

        // Figure out the site origin for the redirect URL.
        // Prefer the explicit SITE_URL env var (set to the custom domain),
        // fall back to the Netlify deploy URL, then the raw request host.
        const siteUrl = process.env.SITE_URL ||
            process.env.URL ||
            (event.headers && (event.headers.origin || (event.headers.host ? `https://${event.headers.host}` : null))) ||
            'https://finance.archwaysaba.com';

        const redirectTo = `${siteUrl.replace(/\/$/, '')}/set-password.html`;

        // Step 1: Send invite email (creates the auth user + mails them)
        const inviteRes = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
            method: 'POST',
            headers: supabaseHeaders,
            body: JSON.stringify({
                email,
                data: {
                    first_name,
                    last_name,
                    role
                },
                // Where the user lands after clicking the invite link
                // (must be whitelisted in Supabase Auth > URL Configuration > Redirect URLs)
                redirect_to: redirectTo
            })
        });

        const inviteData = await inviteRes.json();

        if (!inviteRes.ok) {
            return {
                statusCode: inviteRes.status,
                body: JSON.stringify({
                    error: inviteData.msg || inviteData.message || inviteData.error_description || 'Failed to send invite'
                })
            };
        }

        const authUserId = inviteData.id || inviteData.user?.id;

        if (!authUserId) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Invite succeeded but no user ID returned' })
            };
        }

        // Step 2: Create app_users record
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/app_users`, {
            method: 'POST',
            headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
            body: JSON.stringify({
                auth_user_id: authUserId,
                first_name,
                last_name,
                email,
                role,
                is_active: true
            })
        });

        if (!insertRes.ok) {
            const insertErr = await insertRes.text();
            // Clean up the auth user since app_user record failed
            await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${authUserId}`, {
                method: 'DELETE',
                headers: supabaseHeaders
            });
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to create user record: ' + insertErr })
            };
        }

        const appUser = await insertRes.json();

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                auth_user_id: authUserId,
                app_user: appUser[0],
                invite_sent: true,
                email,
                message: `Invite email sent to ${email}. They'll set their password when they click the link.`
            })
        };

    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};
