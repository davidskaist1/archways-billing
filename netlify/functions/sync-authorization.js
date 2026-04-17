// Webhook endpoint: receive authorization data from the CRM
// Secured with BILLING_API_KEY shared secret
// Upserts by authorizationId
//
// Expected payload from CRM:
// {
//   "authorizationId": "uuid",
//   "clientId": "uuid",
//   "childFirstName": "Jane",
//   "childLastName": "Smith",
//   "insurance": "Horizon BCBS",
//   "authNumber": "A1234567",
//   "startDate": "2025-01-01",
//   "endDate": "2025-12-31",
//   "approvedHoursPerWeek": 10,
//   "totalApprovedHours": 520,
//   "usedHours": 0,
//   "serviceType": "initial_assessment",
//   "status": "approved",
//   "notes": "Approved via Availity",
//   "updatedAt": "2025-04-17T12:00:00Z",
//   "source": "archways-crm"
// }

// Map CRM status to our enum values
function mapStatus(crmStatus) {
    if (!crmStatus) return 'active';
    const s = String(crmStatus).toLowerCase().trim();
    if (['approved', 'active'].includes(s)) return 'active';
    if (['pending', 'in_review', 'submitted'].includes(s)) return 'pending';
    if (['denied', 'rejected'].includes(s)) return 'denied';
    if (['expired'].includes(s)) return 'expired';
    if (['cancelled', 'canceled'].includes(s)) return 'cancelled';
    return 'active';
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const BILLING_API_KEY = process.env.BILLING_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !BILLING_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server configuration missing' }) };
    }

    const apiKey = event.headers['x-api-key'] || event.headers['X-Api-Key'];
    if (apiKey !== BILLING_API_KEY) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };
    }

    try {
        const body = JSON.parse(event.body);

        // Support both camelCase (CRM) and snake_case field names
        const authorizationId = body.authorizationId || body.crm_auth_id;
        const clientId = body.clientId || body.cr_client_id;
        const childFirstName = body.childFirstName || body.first_name;
        const childLastName = body.childLastName || body.last_name;
        const insurance = body.insurance || body.insurance_payer_name;
        const authNumber = body.authNumber || body.auth_number;
        const startDate = body.startDate || body.start_date;
        const endDate = body.endDate || body.end_date;
        const approvedHoursPerWeek = body.approvedHoursPerWeek || body.approved_hours_per_week;
        const totalApprovedHours = body.totalApprovedHours || body.total_approved_hours;
        const usedHours = body.usedHours !== undefined ? body.usedHours : body.used_hours;
        const serviceType = body.serviceType || body.service_type;
        const status = body.status;
        const notes = body.notes;
        const source = body.source || 'archways-crm';

        if (!authNumber || !startDate || !endDate) {
            return {
                statusCode: 400,
                body: JSON.stringify({ ok: false, error: 'authNumber, startDate, endDate are required' })
            };
        }

        const supabaseHeaders = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        // ----- Resolve client -----
        // Priority: match by cr_client_id (stores CRM clientId), then by name + DOB
        let billingClientId = null;

        if (clientId) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?cr_client_id=eq.${encodeURIComponent(clientId)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (Array.isArray(found) && found.length > 0) billingClientId = found[0].id;
        }

        if (!billingClientId && childFirstName && childLastName) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?first_name=ilike.${encodeURIComponent(childFirstName)}&last_name=ilike.${encodeURIComponent(childLastName)}&select=id&limit=1`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (Array.isArray(found) && found.length > 0) billingClientId = found[0].id;
        }

        // If we still don't have a client, auto-create one so the auth doesn't get orphaned
        if (!billingClientId && childFirstName && childLastName) {
            const createRes = await fetch(`${SUPABASE_URL}/rest/v1/clients`, {
                method: 'POST',
                headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                body: JSON.stringify({
                    cr_client_id: clientId || null,
                    first_name: childFirstName,
                    last_name: childLastName,
                    is_active: true
                })
            });
            const created = await createRes.json();
            if (Array.isArray(created) && created.length > 0) {
                billingClientId = created[0].id;
            }
        }

        // ----- Resolve or create insurance payer -----
        let payerId = null;
        if (insurance) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/insurance_payers?name=eq.${encodeURIComponent(insurance)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (Array.isArray(found) && found.length > 0) {
                payerId = found[0].id;
            } else {
                const createRes = await fetch(`${SUPABASE_URL}/rest/v1/insurance_payers`, {
                    method: 'POST',
                    headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                    body: JSON.stringify({ name: insurance, notes: 'Auto-created from CRM auth sync' })
                });
                const created = await createRes.json();
                if (Array.isArray(created) && created.length > 0) payerId = created[0].id;
            }
        }

        // ----- Build record -----
        const record = {
            crm_auth_id: authorizationId || null,
            client_id: billingClientId,
            payer_id: payerId,
            auth_number: authNumber,
            start_date: startDate,
            end_date: endDate,
            approved_hours_per_week: approvedHoursPerWeek !== undefined && approvedHoursPerWeek !== null
                ? parseFloat(approvedHoursPerWeek) : null,
            total_approved_hours: totalApprovedHours !== undefined && totalApprovedHours !== null
                ? parseFloat(totalApprovedHours) : null,
            used_hours: usedHours !== undefined && usedHours !== null
                ? parseFloat(usedHours) : 0,
            service_type: serviceType || null,
            status: mapStatus(status),
            notes: notes || null,
            source: source,
            last_synced_at: new Date().toISOString()
        };

        // ----- Upsert -----
        let existing = null;

        if (authorizationId) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/authorizations?crm_auth_id=eq.${encodeURIComponent(authorizationId)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (Array.isArray(found) && found.length > 0) existing = found[0];
        }

        if (!existing && billingClientId) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/authorizations?client_id=eq.${billingClientId}&auth_number=eq.${encodeURIComponent(authNumber)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (Array.isArray(found) && found.length > 0) existing = found[0];
        }

        if (existing) {
            const updateRes = await fetch(
                `${SUPABASE_URL}/rest/v1/authorizations?id=eq.${existing.id}`,
                {
                    method: 'PATCH',
                    headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
                    body: JSON.stringify(record)
                }
            );

            if (!updateRes.ok) {
                const errText = await updateRes.text();
                return {
                    statusCode: updateRes.status,
                    body: JSON.stringify({ ok: false, error: 'Update failed: ' + errText })
                };
            }

            return {
                statusCode: 200,
                body: JSON.stringify({ ok: true, action: 'updated', authorizationId: existing.id })
            };
        } else {
            const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/authorizations`, {
                method: 'POST',
                headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                body: JSON.stringify(record)
            });

            if (!insertRes.ok) {
                const errText = await insertRes.text();
                return {
                    statusCode: insertRes.status,
                    body: JSON.stringify({ ok: false, error: 'Insert failed: ' + errText })
                };
            }

            const created = await insertRes.json();
            return {
                statusCode: 201,
                body: JSON.stringify({ ok: true, action: 'created', authorizationId: created[0]?.id })
            };
        }
    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ ok: false, error: err.message })
        };
    }
};
