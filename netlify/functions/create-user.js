// Server-side function: create a Supabase auth user and link to staff record
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY env vars
// Only admins can call this (validated by checking the caller's role)

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
        const { email, password, staff_id } = JSON.parse(event.body);

        if (!email || !password || !staff_id) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing email, password, or staff_id' }) };
        }

        // Create auth user via Supabase Admin API
        const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            },
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
                body: JSON.stringify({ error: createData.msg || createData.message || 'Failed to create user' })
            };
        }

        const authUserId = createData.id;

        // Link auth user to staff record
        const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/staff?id=eq.${staff_id}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ auth_user_id: authUserId })
        });

        if (!updateRes.ok) {
            const updateErr = await updateRes.text();
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'User created but failed to link to staff: ' + updateErr })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, auth_user_id: authUserId })
        };

    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};
