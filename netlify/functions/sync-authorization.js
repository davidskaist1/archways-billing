// Webhook endpoint: receive authorization data from the CRM
// Secured with BILLING_API_KEY shared secret
// Upserts by crm_auth_id

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

    const apiKey = event.headers['x-api-key'] || event.headers['X-Api-Key'];
    if (apiKey !== BILLING_API_KEY) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const {
            crm_auth_id,
            cr_client_id,
            client_name,
            insurance_payer_name,
            auth_number,
            start_date,
            end_date,
            approved_units,
            approved_hours_per_week,
            cpt_codes,
            status,
            notes
        } = body;

        if (!auth_number || !start_date || !end_date) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'auth_number, start_date, end_date are required' })
            };
        }

        const supabaseHeaders = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        // Resolve client
        let clientId = null;
        if (cr_client_id) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?cr_client_id=eq.${encodeURIComponent(cr_client_id)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (found.length > 0) clientId = found[0].id;
        }
        if (!clientId && client_name) {
            const parts = client_name.split(/[,\s]+/).filter(Boolean);
            // Try "Last, First" first
            if (parts.length >= 2) {
                const [first, last] = client_name.includes(',')
                    ? [parts[1], parts[0]]
                    : [parts[0], parts.slice(1).join(' ')];
                const res = await fetch(
                    `${SUPABASE_URL}/rest/v1/clients?first_name=ilike.${encodeURIComponent(first)}&last_name=ilike.${encodeURIComponent(last)}&select=id&limit=1`,
                    { headers: supabaseHeaders }
                );
                const found = await res.json();
                if (found.length > 0) clientId = found[0].id;
            }
        }

        // Resolve payer
        let payerId = null;
        if (insurance_payer_name) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/insurance_payers?name=eq.${encodeURIComponent(insurance_payer_name)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (found.length > 0) {
                payerId = found[0].id;
            } else {
                const createRes = await fetch(`${SUPABASE_URL}/rest/v1/insurance_payers`, {
                    method: 'POST',
                    headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                    body: JSON.stringify({ name: insurance_payer_name, notes: 'Auto-created from CRM auth sync' })
                });
                const created = await createRes.json();
                payerId = created[0]?.id || null;
            }
        }

        const record = {
            crm_auth_id: crm_auth_id || null,
            client_id: clientId,
            payer_id: payerId,
            auth_number,
            start_date,
            end_date,
            approved_units: approved_units ? parseInt(approved_units) : null,
            approved_hours_per_week: approved_hours_per_week ? parseFloat(approved_hours_per_week) : null,
            cpt_codes: Array.isArray(cpt_codes) ? cpt_codes : (cpt_codes ? [cpt_codes] : []),
            status: status || 'active',
            notes: notes || null,
            last_synced_at: new Date().toISOString()
        };

        // Upsert by crm_auth_id if provided, else by client+auth_number
        let existing = null;
        if (crm_auth_id) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/authorizations?crm_auth_id=eq.${encodeURIComponent(crm_auth_id)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (found.length > 0) existing = found[0];
        }
        if (!existing && clientId) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/authorizations?client_id=eq.${clientId}&auth_number=eq.${encodeURIComponent(auth_number)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (found.length > 0) existing = found[0];
        }

        if (existing) {
            const updateRes = await fetch(
                `${SUPABASE_URL}/rest/v1/authorizations?id=eq.${existing.id}`,
                {
                    method: 'PATCH',
                    headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                    body: JSON.stringify(record)
                }
            );
            const result = await updateRes.json();
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, action: 'updated', authorization_id: existing.id, data: result[0] })
            };
        } else {
            const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/authorizations`, {
                method: 'POST',
                headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                body: JSON.stringify(record)
            });
            const result = await insertRes.json();

            if (!insertRes.ok) {
                return {
                    statusCode: insertRes.status,
                    body: JSON.stringify({ error: 'Failed to insert auth', details: result })
                };
            }

            return {
                statusCode: 201,
                body: JSON.stringify({ success: true, action: 'created', authorization_id: result[0].id, data: result[0] })
            };
        }
    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};
