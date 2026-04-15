// Webhook endpoint: receive client data from the CRM when a client is onboarded
// Called by the CRM when a client moves to "active" stage
// Secured with BILLING_API_KEY shared secret

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
            date_of_birth,
            insurance_payer_name,
            insurance_member_id,
            authorization_number,
            authorized_units_per_week,
            cr_client_id
        } = body;

        if (!first_name || !last_name) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'first_name and last_name are required' })
            };
        }

        const supabaseHeaders = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        // Resolve or create insurance payer
        let payerId = null;
        if (insurance_payer_name) {
            const payerRes = await fetch(
                `${SUPABASE_URL}/rest/v1/insurance_payers?name=eq.${encodeURIComponent(insurance_payer_name)}&select=id`,
                { headers: supabaseHeaders }
            );
            const existing = await payerRes.json();

            if (existing.length > 0) {
                payerId = existing[0].id;
            } else {
                // Auto-create payer
                const createRes = await fetch(`${SUPABASE_URL}/rest/v1/insurance_payers`, {
                    method: 'POST',
                    headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                    body: JSON.stringify({
                        name: insurance_payer_name,
                        notes: 'Auto-created from CRM sync'
                    })
                });
                const created = await createRes.json();
                payerId = created[0]?.id || null;
            }
        }

        // Check if client already exists (by cr_client_id or by name + DOB)
        let existingClient = null;

        if (cr_client_id) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?cr_client_id=eq.${encodeURIComponent(cr_client_id)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (found.length > 0) existingClient = found[0];
        }

        if (!existingClient && date_of_birth) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?first_name=eq.${encodeURIComponent(first_name)}&last_name=eq.${encodeURIComponent(last_name)}&date_of_birth=eq.${date_of_birth}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (found.length > 0) existingClient = found[0];
        }

        const record = {
            first_name,
            last_name,
            date_of_birth: date_of_birth || null,
            insurance_payer_id: payerId,
            insurance_member_id: insurance_member_id || null,
            authorization_number: authorization_number || null,
            authorized_units_per_week: authorized_units_per_week ? parseInt(authorized_units_per_week) : null,
            cr_client_id: cr_client_id || null,
            is_active: true
        };

        let result;

        if (existingClient) {
            // Update existing
            const updateRes = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?id=eq.${existingClient.id}`,
                {
                    method: 'PATCH',
                    headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                    body: JSON.stringify(record)
                }
            );
            result = await updateRes.json();
            return {
                statusCode: 200,
                body: JSON.stringify({
                    success: true,
                    action: 'updated',
                    client_id: existingClient.id,
                    data: result[0]
                })
            };
        } else {
            // Insert new
            const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/clients`, {
                method: 'POST',
                headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                body: JSON.stringify(record)
            });
            result = await insertRes.json();

            if (!insertRes.ok) {
                return {
                    statusCode: insertRes.status,
                    body: JSON.stringify({ error: 'Failed to insert client', details: result })
                };
            }

            return {
                statusCode: 201,
                body: JSON.stringify({
                    success: true,
                    action: 'created',
                    client_id: result[0].id,
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
