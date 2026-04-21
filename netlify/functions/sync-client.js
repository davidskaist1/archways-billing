// Webhook endpoint: receive client data from the CRM
// Fires at two points: "Sent to Insurance" and "Active"
// Upsert strategy (in priority order):
//   1. Match by cr_client_id (if provided)
//   2. Match by insurance_member_id (if provided)
//   3. Match by first_name + last_name + date_of_birth
//
// Partial updates: null/empty values in the payload DO NOT overwrite
// existing data. This way the first sync (sent_to_insurance, no auth yet)
// doesn't get clobbered by the second sync (active, with auth).
// Conversely, the auth number set by the "active" sync won't be wiped
// if a later re-sync has a blank auth field.

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
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

        // Accept many naming variations so we're resilient to CRM naming choices
        const firstName =
            body.child_first_name || body.childFirstName ||
            body.first_name || body.firstName;
        const lastName =
            body.child_last_name || body.childLastName ||
            body.last_name || body.lastName;
        const dateOfBirth =
            body.date_of_birth || body.dateOfBirth || body.dob;
        const insurancePayerName =
            body.insurance_payer_name || body.insurancePayerName ||
            body.insurance || body.primary_insurance;
        const insuranceMemberId =
            body.insurance_member_id || body.insuranceMemberId ||
            body.insurance_id || body.memberId || body.member_id;
        const authorizationNumber =
            body.authorization_number || body.authorizationNumber ||
            body.auth_number || body.authNumber;
        const authorizedUnitsPerWeek =
            body.authorized_units_per_week || body.authorizedUnitsPerWeek ||
            body.approved_hours_per_week || body.approvedHoursPerWeek;
        const crClientId =
            body.cr_client_id || body.crClientId ||
            body.clientId || body.client_id;
        const stage = body.stage || body.status; // sent_to_insurance, active, etc.

        if (!firstName || !lastName) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    ok: false,
                    error: 'first_name and last_name (or child_first_name / child_last_name) are required'
                })
            };
        }

        const supabaseHeaders = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        // ----- Resolve or create insurance payer -----
        let payerId = null;
        if (insurancePayerName) {
            const payerRes = await fetch(
                `${SUPABASE_URL}/rest/v1/insurance_payers?name=eq.${encodeURIComponent(insurancePayerName)}&select=id`,
                { headers: supabaseHeaders }
            );
            const existing = await payerRes.json();

            if (Array.isArray(existing) && existing.length > 0) {
                payerId = existing[0].id;
            } else {
                const createRes = await fetch(`${SUPABASE_URL}/rest/v1/insurance_payers`, {
                    method: 'POST',
                    headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                    body: JSON.stringify({
                        name: insurancePayerName,
                        notes: 'Auto-created from CRM client sync'
                    })
                });
                const created = await createRes.json();
                if (Array.isArray(created) && created.length > 0) payerId = created[0].id;
            }
        }

        // ----- Find existing client (3-tier match) -----
        let existingClient = null;

        // Tier 1: match by cr_client_id (most reliable)
        if (!existingClient && crClientId) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?cr_client_id=eq.${encodeURIComponent(crClientId)}&select=*`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (Array.isArray(found) && found.length > 0) existingClient = found[0];
        }

        // Tier 2: match by insurance_member_id
        if (!existingClient && insuranceMemberId) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?insurance_member_id=eq.${encodeURIComponent(insuranceMemberId)}&select=*`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (Array.isArray(found) && found.length > 0) existingClient = found[0];
        }

        // Tier 3: match by name + DOB
        if (!existingClient && dateOfBirth) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?first_name=ilike.${encodeURIComponent(firstName)}&last_name=ilike.${encodeURIComponent(lastName)}&date_of_birth=eq.${dateOfBirth}&select=*`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (Array.isArray(found) && found.length > 0) existingClient = found[0];
        }

        // Tier 4 (fallback): match by name alone (no DOB)
        if (!existingClient && !dateOfBirth) {
            const res = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?first_name=ilike.${encodeURIComponent(firstName)}&last_name=ilike.${encodeURIComponent(lastName)}&select=*&limit=1`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (Array.isArray(found) && found.length > 0) existingClient = found[0];
        }

        // ----- Build partial record (null/empty values do not overwrite) -----
        // For an update, we only include fields that have actual values in the payload.
        // This lets the first sync set name/DOB/insurance, and the second sync
        // add the auth number without wiping anything that was already populated.
        const updateRecord = {};
        const insertRecord = {
            first_name: firstName,
            last_name: lastName,
            date_of_birth: dateOfBirth || null,
            insurance_payer_id: payerId,
            insurance_member_id: insuranceMemberId || null,
            authorization_number: authorizationNumber || null,
            authorized_units_per_week: authorizedUnitsPerWeek ? parseInt(authorizedUnitsPerWeek) : null,
            cr_client_id: crClientId || null,
            is_active: true
        };

        // Only include fields with values for updates
        if (firstName) updateRecord.first_name = firstName;
        if (lastName) updateRecord.last_name = lastName;
        if (dateOfBirth) updateRecord.date_of_birth = dateOfBirth;
        if (payerId) updateRecord.insurance_payer_id = payerId;
        if (insuranceMemberId) updateRecord.insurance_member_id = insuranceMemberId;
        if (authorizationNumber) updateRecord.authorization_number = authorizationNumber;
        if (authorizedUnitsPerWeek) updateRecord.authorized_units_per_week = parseInt(authorizedUnitsPerWeek);
        if (crClientId) updateRecord.cr_client_id = crClientId;

        // Stage "active" should ensure is_active = true (they made it to services)
        if (stage && String(stage).toLowerCase() === 'active') {
            updateRecord.is_active = true;
        }

        // ----- Upsert -----
        let clientId = null;
        let action = null;

        if (existingClient) {
            const updateRes = await fetch(
                `${SUPABASE_URL}/rest/v1/clients?id=eq.${existingClient.id}`,
                {
                    method: 'PATCH',
                    headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                    body: JSON.stringify(updateRecord)
                }
            );

            if (!updateRes.ok) {
                const errText = await updateRes.text();
                return {
                    statusCode: updateRes.status,
                    body: JSON.stringify({ ok: false, error: 'Update failed: ' + errText })
                };
            }

            clientId = existingClient.id;
            action = 'updated';
        } else {
            const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/clients`, {
                method: 'POST',
                headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                body: JSON.stringify(insertRecord)
            });

            if (!insertRes.ok) {
                const errText = await insertRes.text();
                return {
                    statusCode: insertRes.status,
                    body: JSON.stringify({ ok: false, error: 'Insert failed: ' + errText })
                };
            }

            const result = await insertRes.json();
            clientId = result[0].id;
            action = 'created';
        }

        // ----- Auto-create pending Benefits Verification if stage is sent_to_insurance -----
        let bvCreated = false;
        const isSentToInsurance = stage && String(stage).toLowerCase().replace(/\s+/g, '_') === 'sent_to_insurance';

        if (isSentToInsurance && clientId) {
            // Check if there's already an open (non-completed) BV for this client
            const bvCheck = await fetch(
                `${SUPABASE_URL}/rest/v1/benefit_verifications?client_id=eq.${clientId}&status=in.(pending,in_progress)&select=id`,
                { headers: supabaseHeaders }
            );
            const existingBV = await bvCheck.json();

            if (!Array.isArray(existingBV) || existingBV.length === 0) {
                const bvRes = await fetch(`${SUPABASE_URL}/rest/v1/benefit_verifications`, {
                    method: 'POST',
                    headers: supabaseHeaders,
                    body: JSON.stringify({
                        client_id: clientId,
                        payer_id: payerId,
                        status: 'pending',
                        plan_year: new Date().getFullYear()
                    })
                });
                bvCreated = bvRes.ok;
            }
        }

        return {
            statusCode: action === 'created' ? 201 : 200,
            body: JSON.stringify({
                ok: true,
                action,
                client_id: clientId,
                stage: stage || null,
                benefit_verification_created: bvCreated
            })
        };
    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ ok: false, error: err.message })
        };
    }
};
