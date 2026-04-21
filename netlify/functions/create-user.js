// Server-side function: create a Supabase auth user and matching app_users record
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY env vars
// Called from the User Management page (admin only)

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
        const { first_name, last_name, email, password, role } = JSON.parse(event.body);

        if (!first_name || !last_name || !email || !password || !role) {
            return { statusCode: 400, body: JSON.stringify({ error: 'All fields are required: first_name, last_name, email, password, role' }) };
        }

        if (!['admin', 'billing', 'payroll', 'investor'].includes(role)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Role must be admin, billing, payroll, or investor' }) };
        }

        // Create auth user via Supabase Admin API
        const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
            method: 'POST',
            headers: supabaseHeaders,
            body: JSON.stringify({
                email,
                password,
                email_confirm: true
            })
        });

        const createData = await createRes.json();

        if (!createRes.ok) {
            return {
                statusCode: createRes.status,
                body: JSON.stringify({ error: createData.msg || createData.message || 'Failed to create auth user' })
            };
        }

        const authUserId = createData.id;

        // Create app_users record
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
            // Auth user was created but app_user failed — clean up auth user
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
                app_user: appUser[0]
            })
        };

    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};
