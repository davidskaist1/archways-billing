// Webhook endpoint: receive staff data from the CRM when HR completes onboarding
// Called by the CRM when staff advances to "staffed" stage
// Secured with BILLING_API_KEY shared secret

// Map CRM roles to billing app roles
function mapRole(crmRole) {
    if (!crmRole) return 'billing';
    const normalized = String(crmRole).toLowerCase().trim();

    // Direct service providers go to payroll (they get paid hourly)
    if (normalized === 'rbt' || normalized === 'bcba' || normalized === 'bcaba') {
        return 'payroll';
    }

    // Office staff default to billing (adjust per person later if needed)
    if (normalized === 'office_staff' || normalized === 'office') {
        return 'billing';
    }

    // Accept already-mapped roles as-is
    if (['admin', 'billing', 'payroll'].includes(normalized)) {
        return normalized;
    }

    return 'billing';
}

function mapCredential(cred) {
    if (!cred) return null;
    const normalized = String(cred).toUpperCase().trim();
    if (['RBT', 'BCBA', 'BCABA'].includes(normalized)) {
        return normalized === 'BCABA' ? 'BCaBA' : normalized;
    }
    return 'Other';
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const BILLING_API_KEY = process.env.BILLING_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !BILLING_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration missing' }) };
    }

    // Auth check
    const apiKey = event.headers['x-api-key'] || event.headers['X-Api-Key'];
    if (apiKey !== BILLING_API_KEY) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const {
            first_name,
            last_name,
            email,
            role,
            credential,
            npi,
            hourly_rate
        } = body;

        if (!first_name || !last_name || !email) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'first_name, last_name, and email are required' })
            };
        }

        const supabaseHeaders = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        // Check if staff already exists by email
        const checkRes = await fetch(
            `${SUPABASE_URL}/rest/v1/staff?email=eq.${encodeURIComponent(email)}&select=id`,
            { headers: supabaseHeaders }
        );
        const existing = await checkRes.json();

        const record = {
            first_name,
            last_name,
            email,
            role: mapRole(role),
            credential: mapCredential(credential),
            npi: npi || null,
            hourly_rate: hourly_rate ? parseFloat(hourly_rate) : null,
            is_active: true
        };

        if (existing.length > 0) {
            // Update existing — but preserve existing role/rate if already set
            // Only update fields that have new values
            const updateRec = { ...record };
            const updateRes = await fetch(
                `${SUPABASE_URL}/rest/v1/staff?id=eq.${existing[0].id}`,
                {
                    method: 'PATCH',
                    headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                    body: JSON.stringify(updateRec)
                }
            );
            const result = await updateRes.json();
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    action: 'updated',
                    staff_id: existing[0].id,
                    data: result[0]
                })
            };
        } else {
            // Insert new
            const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/staff`, {
                method: 'POST',
                headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                body: JSON.stringify(record)
            });
            const result = await insertRes.json();

            if (!insertRes.ok) {
                return {
                    statusCode: insertRes.status,
                    body: JSON.stringify({ error: 'Failed to insert staff', details: result })
                };
            }

            return {
                statusCode: 201,
                body: JSON.stringify({
                    success: true,
                    action: 'created',
                    staff_id: result[0].id,
                    data: result[0]
                })
            };
        }
    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};
