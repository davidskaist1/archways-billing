// Backfill authorizations by calling the CRM's get-authorizations endpoint
// Then upserting each one via the same logic as sync-authorization
// Callable from the admin UI as a one-time (or periodic) sync

const CRM_URL = 'https://crm.archwaysaba.com/.netlify/functions/get-authorizations';

// Re-use the same status mapping
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
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const BILLING_API_KEY = process.env.BILLING_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !BILLING_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server configuration missing' }) };
    }

    // Parse optional query params
    const params = event.queryStringParameters || {};
    const queryString = Object.entries(params)
        .filter(([, v]) => v)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    const url = queryString ? `${CRM_URL}?${queryString}` : CRM_URL;

    try {
        // ----- Fetch from CRM -----
        const crmRes = await fetch(url, {
            headers: { 'x-api-key': BILLING_API_KEY }
        });

        if (!crmRes.ok) {
            const errText = await crmRes.text();
            return {
                statusCode: crmRes.status,
                body: JSON.stringify({ ok: false, error: 'CRM request failed: ' + errText })
            };
        }

        const crmData = await crmRes.json();
        const authorizations = crmData.authorizations || [];

        if (!authorizations.length) {
            return {
                statusCode: 200,
                body: JSON.stringify({ ok: true, count: 0, message: 'No authorizations in CRM' })
            };
        }

        const supabaseHeaders = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        let created = 0;
        let updated = 0;
        let failed = 0;
        const errors = [];

        // Cache to avoid repeatedly querying same clients/payers
        const clientCache = {};
        const payerCache = {};

        for (const auth of authorizations) {
            try {
                const authorizationId = auth.authorizationId;
                const clientId = auth.clientId;
                const childFirstName = auth.childFirstName;
                const childLastName = auth.childLastName;
                const insurance = auth.insurance;
                const authNumber = auth.authNumber;
                const startDate = auth.startDate;
                const endDate = auth.endDate;

                if (!authNumber || !startDate || !endDate) {
                    failed++;
                    errors.push({ authorizationId, error: 'Missing required fields' });
                    continue;
                }

                // Resolve client
                let billingClientId = null;

                if (clientId && clientCache[clientId] !== undefined) {
                    billingClientId = clientCache[clientId];
                } else if (clientId) {
                    const res = await fetch(
                        `${SUPABASE_URL}/rest/v1/clients?cr_client_id=eq.${encodeURIComponent(clientId)}&select=id`,
                        { headers: supabaseHeaders }
                    );
                    const found = await res.json();
                    if (Array.isArray(found) && found.length > 0) {
                        billingClientId = found[0].id;
                    } else if (childFirstName && childLastName) {
                        // Try name match
                        const nameRes = await fetch(
                            `${SUPABASE_URL}/rest/v1/clients?first_name=ilike.${encodeURIComponent(childFirstName)}&last_name=ilike.${encodeURIComponent(childLastName)}&select=id&limit=1`,
                            { headers: supabaseHeaders }
                        );
                        const nameFound = await nameRes.json();
                        if (Array.isArray(nameFound) && nameFound.length > 0) {
                            billingClientId = nameFound[0].id;
                            // Backfill cr_client_id
                            await fetch(`${SUPABASE_URL}/rest/v1/clients?id=eq.${billingClientId}`, {
                                method: 'PATCH',
                                headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
                                body: JSON.stringify({ cr_client_id: clientId })
                            });
                        } else {
                            // Auto-create client
                            const createRes = await fetch(`${SUPABASE_URL}/rest/v1/clients`, {
                                method: 'POST',
                                headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                                body: JSON.stringify({
                                    cr_client_id: clientId,
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
                    }
                    clientCache[clientId] = billingClientId;
                }

                // Resolve or create payer
                let payerId = null;
                if (insurance) {
                    if (payerCache[insurance] !== undefined) {
                        payerId = payerCache[insurance];
                    } else {
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
                                body: JSON.stringify({ name: insurance, notes: 'Auto-created from CRM auth backfill' })
                            });
                            const created = await createRes.json();
                            if (Array.isArray(created) && created.length > 0) payerId = created[0].id;
                        }
                        payerCache[insurance] = payerId;
                    }
                }

                // Build record
                const record = {
                    crm_auth_id: authorizationId || null,
                    client_id: billingClientId,
                    payer_id: payerId,
                    auth_number: authNumber,
                    start_date: startDate,
                    end_date: endDate,
                    approved_hours_per_week: auth.approvedHoursPerWeek !== undefined && auth.approvedHoursPerWeek !== null
                        ? parseFloat(auth.approvedHoursPerWeek) : null,
                    total_approved_hours: auth.totalApprovedHours !== undefined && auth.totalApprovedHours !== null
                        ? parseFloat(auth.totalApprovedHours) : null,
                    used_hours: auth.usedHours !== undefined && auth.usedHours !== null
                        ? parseFloat(auth.usedHours) : 0,
                    service_type: auth.serviceType || null,
                    status: mapStatus(auth.status),
                    notes: auth.notes || null,
                    source: auth.source || 'archways-crm',
                    last_synced_at: new Date().toISOString()
                };

                // Upsert
                let existing = null;
                if (authorizationId) {
                    const res = await fetch(
                        `${SUPABASE_URL}/rest/v1/authorizations?crm_auth_id=eq.${encodeURIComponent(authorizationId)}&select=id`,
                        { headers: supabaseHeaders }
                    );
                    const found = await res.json();
                    if (Array.isArray(found) && found.length > 0) existing = found[0];
                }

                if (existing) {
                    await fetch(`${SUPABASE_URL}/rest/v1/authorizations?id=eq.${existing.id}`, {
                        method: 'PATCH',
                        headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
                        body: JSON.stringify(record)
                    });
                    updated++;
                } else {
                    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/authorizations`, {
                        method: 'POST',
                        headers: { ...supabaseHeaders, 'Prefer': 'return=minimal' },
                        body: JSON.stringify(record)
                    });
                    if (insertRes.ok) {
                        created++;
                    } else {
                        failed++;
                        errors.push({ authorizationId, error: await insertRes.text() });
                    }
                }
            } catch (err) {
                failed++;
                errors.push({ authorizationId: auth.authorizationId, error: err.message });
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                ok: true,
                total: authorizations.length,
                created,
                updated,
                failed,
                errors: errors.slice(0, 20)
            })
        };
    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ ok: false, error: err.message })
        };
    }
};
