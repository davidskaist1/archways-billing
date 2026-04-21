// Push an authorization (request OR approved) back to the CRM
// Called from the Authorizations page when the biller clicks "Push to CRM"
//
// The CRM side needs to expose a matching endpoint that accepts this payload.
// Suggested: POST https://crm.archwaysaba.com/.netlify/functions/receive-authorization-update
// Expected headers: x-api-key: <BILLING_API_KEY>

const CRM_ENDPOINT = process.env.CRM_AUTH_ENDPOINT ||
    'https://crm.archwaysaba.com/.netlify/functions/receive-authorization-update';

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const BILLING_API_KEY = process.env.BILLING_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !BILLING_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Server config missing' }) };
    }

    try {
        const { authorization_id } = JSON.parse(event.body);
        if (!authorization_id) {
            return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'authorization_id is required' }) };
        }

        const supabaseHeaders = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        // Load auth + client info
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/authorizations?id=eq.${authorization_id}&select=*,clients(id,cr_client_id,first_name,last_name,date_of_birth,insurance_member_id),insurance_payers(name)`,
            { headers: supabaseHeaders }
        );
        const list = await res.json();

        if (!Array.isArray(list) || list.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Authorization not found' }) };
        }

        const auth = list[0];

        const payload = {
            // Match keys
            crmClientId: auth.clients?.cr_client_id || null,
            billingAuthId: auth.id,
            crmAuthId: auth.crm_auth_id || null,
            childFirstName: auth.clients?.first_name,
            childLastName: auth.clients?.last_name,
            dateOfBirth: auth.clients?.date_of_birth,
            insuranceMemberId: auth.clients?.insurance_member_id,
            insuranceName: auth.insurance_payers?.name,

            // Status & lifecycle
            status: auth.status,
            // requested, in_review, approved, active, expiring, expired, denied, cancelled

            // Request tracking (populated when auth was called in)
            requestDate: auth.request_date,
            requestReferenceNumber: auth.request_reference_number,
            requestSubmissionMethod: auth.request_submission_method,
            requestRepresentative: auth.request_representative,
            requestRepresentativeId: auth.request_representative_id,
            requestFollowUpDate: auth.request_follow_up_date,
            requestNotes: auth.request_notes,

            // Decision info (populated when approved/denied)
            decisionDate: auth.decision_date,
            decisionNotes: auth.decision_notes,

            // Authorization details (populated when approved)
            authNumber: auth.auth_number,
            startDate: auth.start_date,
            endDate: auth.end_date,
            approvedUnits: auth.approved_units,
            totalApprovedHours: auth.total_approved_hours,
            approvedHoursPerWeek: auth.approved_hours_per_week,
            usedHours: auth.used_hours,
            cptCodes: auth.cpt_codes,
            serviceType: auth.service_type,

            notes: auth.notes,
            source: 'archways-billing'
        };

        // Mark as pending push
        await fetch(`${SUPABASE_URL}/rest/v1/authorizations?id=eq.${authorization_id}`, {
            method: 'PATCH',
            headers: supabaseHeaders,
            body: JSON.stringify({ crm_push_status: 'pending' })
        });

        // POST to CRM
        const pushRes = await fetch(CRM_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': BILLING_API_KEY
            },
            body: JSON.stringify(payload)
        });

        const respText = await pushRes.text();
        let respJson = {};
        try { respJson = JSON.parse(respText); } catch {}

        if (!pushRes.ok) {
            await fetch(`${SUPABASE_URL}/rest/v1/authorizations?id=eq.${authorization_id}`, {
                method: 'PATCH',
                headers: supabaseHeaders,
                body: JSON.stringify({
                    crm_push_status: 'failed',
                    crm_push_error: respText.substring(0, 500)
                })
            });
            return {
                statusCode: pushRes.status,
                body: JSON.stringify({
                    ok: false,
                    error: 'CRM rejected push: ' + (respJson.error || respText)
                })
            };
        }

        // Success
        await fetch(`${SUPABASE_URL}/rest/v1/authorizations?id=eq.${authorization_id}`, {
            method: 'PATCH',
            headers: supabaseHeaders,
            body: JSON.stringify({
                crm_push_status: 'pushed',
                pushed_to_crm_at: new Date().toISOString(),
                crm_push_error: null
            })
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ ok: true, crm_response: respJson })
        };

    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ ok: false, error: err.message })
        };
    }
};
