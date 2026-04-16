// Server-side function: reset a user's password (admin only)
// Returns the new temporary password so admin can share it

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
        const { auth_user_id, new_password } = JSON.parse(event.body);

        if (!auth_user_id || !new_password) {
            return { statusCode: 400, body: JSON.stringify({ error: 'auth_user_id and new_password are required' }) };
        }

        if (new_password.length < 8) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
        }

        const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${auth_user_id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            },
            body: JSON.stringify({ password: new_password })
        });

        const data = await res.json();

        if (!res.ok) {
            return {
                statusCode: res.status,
                body: JSON.stringify({ error: data.msg || data.message || 'Failed to reset password' })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };
    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};
