// ============================================
// Manual Office Ally Sync Trigger
// Callable via POST from the Clearinghouse page's "Sync Now" button
// ============================================

const SftpClient = require('ssh2-sftp-client');
const { parse835, normalizeForImport } = require('./_lib/edi-835-parser');
const { parse277CA } = require('./_lib/edi-277ca-parser');
const { extractEdiContent } = require('./_lib/process-era-file');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const SFTP_HOST = process.env.OFFICE_ALLY_SFTP_HOST;
    const SFTP_PORT = parseInt(process.env.OFFICE_ALLY_SFTP_PORT || '22');
    const SFTP_USER = process.env.OFFICE_ALLY_SFTP_USER;
    const SFTP_PASSWORD = process.env.OFFICE_ALLY_SFTP_PASSWORD;
    // Support both OUTBOUND_DIR (correct) and INBOUND_DIR (legacy)
    const OUTBOUND_DIR = process.env.OFFICE_ALLY_OUTBOUND_DIR ||
                         process.env.OFFICE_ALLY_INBOUND_DIR || '/outbound';
    const ARCHIVE_DIR = process.env.OFFICE_ALLY_ARCHIVE_DIR || null;

    if (!SFTP_HOST || !SFTP_USER || !SFTP_PASSWORD) {
        return {
            statusCode: 400,
            body: JSON.stringify({
                status: 'not_configured',
                message: 'Office Ally SFTP credentials are not configured. Add OFFICE_ALLY_SFTP_HOST, OFFICE_ALLY_SFTP_USER, and OFFICE_ALLY_SFTP_PASSWORD to Netlify environment variables.'
            })
        };
    }

    // Delegate to the same handler logic as the scheduled version
    // We duplicate just the inner body here to avoid cron wrapping issues

    const supabaseHeaders = {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    };

    const syncLogRes = await fetch(`${SUPABASE_URL}/rest/v1/sync_logs`, {
        method: 'POST',
        headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({
            sync_type: 'office_ally_full',
            triggered_by: 'manual',
            status: 'running'
        })
    });
    const syncLog = (await syncLogRes.json())[0];
    const syncLogId = syncLog?.id;

    const sftp = new SftpClient();
    const summary = {
        syncLogId,
        filesFound: 0,
        filesProcessed: 0,
        filesFailed: 0,
        paymentsCreated: 0,
        claimsMatched: 0,
        acknowledgmentsCreated: 0,
        errors: []
    };

    try {
        await sftp.connect({
            host: SFTP_HOST,
            port: SFTP_PORT,
            username: SFTP_USER,
            password: SFTP_PASSWORD,
            readyTimeout: 30000
        });

        const files = await sftp.list(OUTBOUND_DIR);
        summary.filesFound = files.length;

        // Fetch already-processed files to skip
        const processedRes = await fetch(
            `${SUPABASE_URL}/rest/v1/era_files?select=file_name&source=eq.office_ally&limit=5000`,
            { headers: supabaseHeaders }
        );
        const processedFiles = new Set((await processedRes.json()).map(f => f.file_name));

        for (const file of files) {
            if (file.type !== '-') continue;
            if (processedFiles.has(file.name)) continue;

            try {
                const remotePath = `${OUTBOUND_DIR}/${file.name}`;
                const buffer = await sftp.get(remotePath);

                let extracted;
                try {
                    extracted = extractEdiContent(buffer, file.name);
                } catch (extractErr) {
                    summary.errors.push(`${file.name}: ${extractErr.message}`);
                    summary.filesFailed++;
                    continue;
                }

                for (const { filename: innerName, content, fileType } of extracted) {
                    const displayName = innerName === file.name ? file.name : `${file.name}:${innerName}`;

                    if (fileType === 'era') {
                        const result = await processERA(content, displayName, supabaseHeaders, SUPABASE_URL);
                        summary.paymentsCreated += result.paymentsCreated;
                        summary.claimsMatched += result.claimsMatched;
                    } else if (fileType === '277ca') {
                        const result = await process277CA(content, displayName, supabaseHeaders, SUPABASE_URL);
                        summary.acknowledgmentsCreated += result.acknowledgmentsCreated;
                    } else {
                        summary.errors.push(`${displayName}: ${fileType} not processed`);
                    }
                }

                if (ARCHIVE_DIR) {
                    try {
                        await sftp.rename(remotePath, `${ARCHIVE_DIR}/${file.name}`);
                    } catch (archiveErr) {
                        // Office Ally /outbound may not allow moves — that's fine, we track via DB
                    }
                }

                summary.filesProcessed++;
            } catch (fileErr) {
                summary.filesFailed++;
                summary.errors.push(`${file.name}: ${fileErr.message}`);
            }
        }

        await sftp.end();

        if (syncLogId) {
            await fetch(`${SUPABASE_URL}/rest/v1/sync_logs?id=eq.${syncLogId}`, {
                method: 'PATCH',
                headers: supabaseHeaders,
                body: JSON.stringify({
                    status: summary.filesFailed > 0 && summary.filesProcessed > 0 ? 'partial' :
                           summary.filesFailed > 0 ? 'error' : 'success',
                    files_found: summary.filesFound,
                    files_processed: summary.filesProcessed,
                    files_failed: summary.filesFailed,
                    payments_created: summary.paymentsCreated,
                    claims_matched: summary.claimsMatched,
                    acknowledgments_created: summary.acknowledgmentsCreated,
                    details: { errors: summary.errors },
                    completed_at: new Date().toISOString()
                })
            });
        }

        return { statusCode: 200, body: JSON.stringify(summary) };
    } catch (err) {
        try { await sftp.end(); } catch {}

        if (syncLogId) {
            await fetch(`${SUPABASE_URL}/rest/v1/sync_logs?id=eq.${syncLogId}`, {
                method: 'PATCH',
                headers: supabaseHeaders,
                body: JSON.stringify({
                    status: 'error',
                    error_message: err.message,
                    completed_at: new Date().toISOString()
                })
            });
        }

        return { statusCode: 500, body: JSON.stringify({ error: err.message, summary }) };
    }
};

// Reuse the same processing functions from the scheduled handler
async function processERA(content, fileName, supabaseHeaders, supabaseUrl) {
    const parsed = parse835(content);
    const normalizedPayments = normalizeForImport(parsed, fileName);
    const firstTx = parsed.transactions[0] || {};

    let payerId = null;
    const payerName = firstTx.payer?.name;
    if (payerName) {
        const res = await fetch(
            `${supabaseUrl}/rest/v1/insurance_payers?name=eq.${encodeURIComponent(payerName)}&select=id`,
            { headers: supabaseHeaders }
        );
        const found = await res.json();
        if (found.length > 0) {
            payerId = found[0].id;
        } else {
            const createRes = await fetch(`${supabaseUrl}/rest/v1/insurance_payers`, {
                method: 'POST',
                headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
                body: JSON.stringify({
                    name: payerName,
                    payer_id_number: firstTx.payer?.id,
                    office_ally_payer_id: firstTx.payer?.id,
                    routes_through_office_ally: true,
                    notes: 'Auto-created from Office Ally ERA'
                })
            });
            const created = await createRes.json();
            payerId = created[0]?.id || null;
        }
    }

    const eraFileRes = await fetch(`${supabaseUrl}/rest/v1/era_files`, {
        method: 'POST',
        headers: { ...supabaseHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({
            file_name: fileName,
            file_size_bytes: content.length,
            source: 'office_ally',
            check_number: firstTx.trace?.checkOrEftNumber,
            check_date: firstTx.payment?.effectiveDate,
            total_paid: firstTx.payment?.totalPaid,
            payment_method: firstTx.payment?.paymentMethod,
            payer_name: payerName,
            payer_id_number: firstTx.payer?.id,
            payer_id: payerId,
            payee_name: firstTx.payee?.name,
            payee_npi: firstTx.payee?.id,
            status: 'parsed',
            claims_in_file: normalizedPayments.length,
            raw_content: content,
            parsed_json: parsed,
            processed_at: new Date().toISOString()
        })
    });
    const eraFile = (await eraFileRes.json())[0];

    let claimsMatched = 0;
    for (const payment of normalizedPayments) {
        let claimId = null;
        if (payment.cr_claim_id) {
            const claimRes = await fetch(
                `${supabaseUrl}/rest/v1/claims?cr_claim_id=eq.${encodeURIComponent(payment.cr_claim_id)}&select=id,billed_amount,expected_amount,paid_amount`,
                { headers: supabaseHeaders }
            );
            const claims = await claimRes.json();
            if (claims.length > 0) {
                claimId = claims[0].id;
                claimsMatched++;

                const newPaid = parseFloat(claims[0].paid_amount || 0) + parseFloat(payment.payment_amount);
                const expected = parseFloat(claims[0].expected_amount || claims[0].billed_amount);
                let newStatus = 'partial';
                if (newPaid >= expected * 0.95) newStatus = 'paid';
                if (parseFloat(payment.payment_amount) === 0 && parseFloat(payment.adjustment_amount) > 0) newStatus = 'denied';

                await fetch(`${supabaseUrl}/rest/v1/claims?id=eq.${claimId}`, {
                    method: 'PATCH',
                    headers: supabaseHeaders,
                    body: JSON.stringify({
                        paid_amount: newPaid,
                        adjustment_amount: parseFloat(payment.adjustment_amount) || 0,
                        status: newStatus,
                        date_paid: newStatus === 'paid' ? new Date().toISOString().split('T')[0] : null
                    })
                });
            }
        }

        await fetch(`${supabaseUrl}/rest/v1/payments`, {
            method: 'POST',
            headers: supabaseHeaders,
            body: JSON.stringify({
                claim_id: claimId,
                payer_id: payerId,
                check_number: payment.check_number,
                check_date: payment.check_date,
                payment_amount: payment.payment_amount,
                adjustment_amount: payment.adjustment_amount,
                adjustment_reason_code: payment.adjustment_reason_code,
                adjustment_reason_text: payment.adjustment_reason_text,
                patient_responsibility: payment.patient_responsibility,
                is_matched: !!claimId,
                era_file_id: eraFile?.id
            })
        });
    }

    if (eraFile?.id) {
        await fetch(`${supabaseUrl}/rest/v1/era_files?id=eq.${eraFile.id}`, {
            method: 'PATCH',
            headers: supabaseHeaders,
            body: JSON.stringify({
                status: claimsMatched === normalizedPayments.length ? 'matched' : 'parsed',
                claims_matched: claimsMatched
            })
        });
    }

    return { paymentsCreated: normalizedPayments.length, claimsMatched };
}

async function process277CA(content, fileName, supabaseHeaders, supabaseUrl) {
    const parsed = parse277CA(content);
    let created = 0;

    for (const ack of parsed.acknowledgments) {
        const crClaimId = ack.references?.['D9'] || ack.references?.['1K'] || null;
        const payerClaimId = ack.references?.['1K'] || null;

        let claimId = null;
        if (crClaimId) {
            const res = await fetch(
                `${supabaseUrl}/rest/v1/claims?cr_claim_id=eq.${encodeURIComponent(crClaimId)}&select=id`,
                { headers: supabaseHeaders }
            );
            const found = await res.json();
            if (found.length > 0) claimId = found[0].id;
        }

        await fetch(`${supabaseUrl}/rest/v1/claim_acknowledgments`, {
            method: 'POST',
            headers: supabaseHeaders,
            body: JSON.stringify({
                claim_id: claimId,
                cr_claim_id: crClaimId,
                payer_claim_id: payerClaimId,
                status_category: ack.statusCategory,
                status_code: ack.statusCode,
                status_description: ack.statusText,
                ack_date: ack.statusDate,
                file_name: fileName
            })
        });

        if (claimId && ['A0', 'A3', 'A4', 'A6', 'A7', 'A8'].includes(ack.statusCategory)) {
            await fetch(`${supabaseUrl}/rest/v1/claims?id=eq.${claimId}`, {
                method: 'PATCH',
                headers: supabaseHeaders,
                body: JSON.stringify({
                    status: 'denied',
                    denial_reason: ack.statusText + (ack.statusCode ? ` (${ack.statusCode})` : '')
                })
            });
        }

        created++;
    }

    return { acknowledgmentsCreated: created };
}
