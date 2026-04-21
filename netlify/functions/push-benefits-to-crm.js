// Push completed benefits verification back to the CRM
// Called when the billing user clicks "Complete & Push to CRM" on the
// Benefits Verification form.
//
// The CRM side needs to expose a matching endpoint that accepts this payload.
// Suggested endpoint: POST https://crm.archwaysaba.com/.netlify/functions/receive-benefits-verification
// Expected headers: x-api-key: whtdmnd_arch_9f3a8b2c1d4e6f7h8j9k0m1n2p3q4r5s

const CRM_ENDPOINT = process.env.CRM_BENEFITS_ENDPOINT ||
    'https://crm.archwaysaba.com/.netlify/functions/receive-benefits-verification';

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
        const { benefit_verification_id } = JSON.parse(event.body);
        if (!benefit_verification_id) {
            return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'benefit_verification_id is required' }) };
        }

        const supabaseHeaders = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        // Load the BV + client info
        const bvRes = await fetch(
            `${SUPABASE_URL}/rest/v1/benefit_verifications?id=eq.${benefit_verification_id}&select=*,clients(id,cr_client_id,first_name,last_name,date_of_birth,insurance_member_id),insurance_payers(name)`,
            { headers: supabaseHeaders }
        );
        const bvList = await bvRes.json();

        if (!Array.isArray(bvList) || bvList.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Benefits verification not found' }) };
        }

        const bv = bvList[0];

        // Build payload for the CRM
        const payload = {
            // Match key — CRM should use this to find the right client
            crmClientId: bv.clients?.cr_client_id || null,
            billingClientId: bv.client_id,
            childFirstName: bv.clients?.first_name,
            childLastName: bv.clients?.last_name,
            dateOfBirth: bv.clients?.date_of_birth,
            insuranceMemberId: bv.clients?.insurance_member_id,
            insuranceName: bv.insurance_payers?.name,
            planYear: bv.plan_year,

            // Verification metadata
            verificationId: bv.id,
            verificationDate: bv.verification_date,
            verifiedAt: bv.updated_at,

            // 1. Network status
            networkStatus: bv.network_status, // 'inn' or 'oon'

            // 2-3. Deductibles
            individualDeductible: bv.individual_deductible,
            individualDeductibleMet: bv.individual_deductible_met,
            familyDeductible: bv.family_deductible,
            familyDeductibleMet: bv.family_deductible_met,

            // 4. After deductible
            afterDeductibleType: bv.after_deductible_type,
            copayAmount: bv.copay_amount,
            coinsurancePercent: bv.coinsurance_percent,

            // 5-6. OOP Max
            individualOopMax: bv.individual_oop_max,
            individualOopMet: bv.individual_oop_met,
            familyOopMax: bv.family_oop_max,
            familyOopMet: bv.family_oop_met,

            // 7. SCA
            scaRequired: bv.sca_required,
            scaStatus: bv.sca_status,
            scaNotes: bv.sca_notes,

            // 8. Fee schedule
            feeScheduleType: bv.fee_schedule_type,
            feeSchedulePercent: bv.fee_schedule_percent,
            feeScheduleNotes: bv.fee_schedule_notes,

            // Coverage dates
            effectiveDate: bv.effective_date,
            terminationDate: bv.termination_date,

            // Auth requirements
            authRequired: bv.auth_required,
            authSubmissionMethod: bv.auth_submission_method,
            authContactPhone: bv.auth_contact_phone,
            authContactNotes: bv.auth_contact_notes,
            cptCodesCovered: bv.cpt_codes_covered,

            // Call documentation
            callDate: bv.call_date,
            callRepresentative: bv.call_representative,
            callRepresentativeId: bv.call_representative_id,
            callReferenceNumber: bv.call_reference_number,
            callNotes: bv.call_notes,

            source: 'archways-billing'
        };

        // Mark as pending push
        await fetch(`${SUPABASE_URL}/rest/v1/benefit_verifications?id=eq.${benefit_verification_id}`, {
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

        const pushResponseText = await pushRes.text();
        let pushResponse = {};
        try { pushResponse = JSON.parse(pushResponseText); } catch {}

        if (!pushRes.ok) {
            await fetch(`${SUPABASE_URL}/rest/v1/benefit_verifications?id=eq.${benefit_verification_id}`, {
                method: 'PATCH',
                headers: supabaseHeaders,
                body: JSON.stringify({
                    crm_push_status: 'failed',
                    crm_push_error: pushResponseText.substring(0, 500)
                })
            });
            return {
                statusCode: pushRes.status,
                body: JSON.stringify({
                    ok: false,
                    error: 'CRM rejected push: ' + (pushResponse.error || pushResponseText)
                })
            };
        }

        // Success — mark as pushed
        await fetch(`${SUPABASE_URL}/rest/v1/benefit_verifications?id=eq.${benefit_verification_id}`, {
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
            body: JSON.stringify({
                ok: true,
                crm_response: pushResponse
            })
        };

    } catch (err) {
        return {
            statusCode: 500,
            body: JSON.stringify({ ok: false, error: err.message })
        };
    }
};
