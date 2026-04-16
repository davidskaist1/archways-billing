// ============================================
// EDI X12 835 (ERA) Parser
// Parses Electronic Remittance Advice files from Office Ally
// ============================================
//
// 835 Structure (simplified):
//   ISA*... (envelope)
//     GS*... (functional group)
//       ST*835*... (transaction set)
//         BPR*... (financial info: check#, amount, method)
//         TRN*... (trace number)
//         N1*PR*... (payer)
//         N1*PE*... (payee)
//         LX*... (header)
//           CLP*... (claim payment — one per claim)
//             CAS*... (claim-level adjustments)
//             NM1*QC*... (patient)
//             DTM*232... (service date)
//             SVC*... (service line — one per CPT)
//               CAS*... (line-level adjustments)
//               DTM*472... (line service date)
//               AMT*... (amounts)
//         PLB*... (provider-level adjustments)
//       SE*... (transaction end)
//     GE*... (group end)
//   IEA*... (envelope end)

/**
 * Parse a raw 835 file string into a structured object.
 * @param {string} rawContent - Raw EDI content
 * @returns {Object} Parsed ERA data
 */
function parse835(rawContent) {
    if (!rawContent || typeof rawContent !== 'string') {
        throw new Error('Invalid 835 content');
    }

    // Detect segment and element separators from ISA
    const isaStart = rawContent.indexOf('ISA');
    if (isaStart === -1) throw new Error('No ISA segment found — not a valid EDI file');

    // ISA is fixed-width: 106 chars. Element separator is at position 3, segment separator is at 105.
    const elementSep = rawContent.charAt(isaStart + 3);
    const segmentSep = rawContent.charAt(isaStart + 105);
    const subElementSep = rawContent.charAt(isaStart + 104);

    // Split into segments, trim whitespace/newlines
    const segments = rawContent
        .substring(isaStart)
        .split(segmentSep)
        .map(s => s.trim().replace(/\r?\n/g, ''))
        .filter(s => s.length > 0);

    const result = {
        interchange: {},
        functionalGroup: {},
        transactions: [],
        claims: [],
        providerAdjustments: []
    };

    let currentTransaction = null;
    let currentClaim = null;
    let currentService = null;
    let currentContext = 'transaction';  // 'transaction', 'claim', 'service'

    for (const segment of segments) {
        const parts = segment.split(elementSep);
        const code = parts[0];

        switch (code) {
            case 'ISA':
                result.interchange = {
                    senderId: parts[6]?.trim(),
                    receiverId: parts[8]?.trim(),
                    date: parts[9],
                    time: parts[10],
                    controlNumber: parts[13]
                };
                break;

            case 'GS':
                result.functionalGroup = {
                    functionId: parts[1],
                    senderCode: parts[2],
                    receiverCode: parts[3],
                    date: parts[4],
                    time: parts[5],
                    controlNumber: parts[6],
                    version: parts[8]
                };
                break;

            case 'ST':
                currentTransaction = {
                    controlNumber: parts[2],
                    payment: {},
                    trace: {},
                    payer: {},
                    payee: {},
                    claims: []
                };
                result.transactions.push(currentTransaction);
                break;

            case 'BPR':
                // BPR*I*11234.56*C*CHK***999999999*DA*123456789*1234567890**01*999999999*DA*987654321*20230515
                if (currentTransaction) {
                    currentTransaction.payment = {
                        transactionType: parts[1],  // I=info only, C=credit, D=debit
                        totalPaid: parseFloat(parts[2]) || 0,
                        creditDebitFlag: parts[3],
                        paymentMethod: parts[4],  // CHK, ACH, NON, BOP, FWT
                        paymentFormat: parts[5],
                        senderDfiId: parts[6],
                        senderAccountNumber: parts[8],
                        senderRoutingNumber: parts[9],
                        effectiveDate: formatEdiDate(parts[16])
                    };
                }
                break;

            case 'TRN':
                if (currentTransaction) {
                    currentTransaction.trace = {
                        traceType: parts[1],
                        checkOrEftNumber: parts[2],
                        payerId: parts[3],
                        originatingCompanyId: parts[4]
                    };
                }
                break;

            case 'REF':
                // Various REF segments — capture key ones
                if (parts[1] === 'EV' && currentTransaction) {
                    currentTransaction.payee = currentTransaction.payee || {};
                    currentTransaction.payee.receiverId = parts[2];
                }
                if (currentClaim) {
                    currentClaim.references = currentClaim.references || {};
                    currentClaim.references[parts[1]] = parts[2];
                }
                break;

            case 'DTM':
                // DTM*405 = production date, DTM*232 = service period start, DTM*472 = service date
                const dtmType = parts[1];
                const dtmDate = formatEdiDate(parts[2]);
                if (currentService) {
                    currentService.serviceDate = dtmDate;
                } else if (currentClaim) {
                    if (dtmType === '232') currentClaim.serviceDateStart = dtmDate;
                    if (dtmType === '233') currentClaim.serviceDateEnd = dtmDate;
                    if (dtmType === '050') currentClaim.receivedDate = dtmDate;
                } else if (currentTransaction) {
                    if (dtmType === '405') currentTransaction.productionDate = dtmDate;
                }
                break;

            case 'N1':
                // N1*PR*INSURANCE NAME*XV*12345 (payer)
                // N1*PE*PRACTICE NAME*XX*1234567890 (payee)
                if (parts[1] === 'PR' && currentTransaction) {
                    currentTransaction.payer = {
                        name: parts[2],
                        idQualifier: parts[3],
                        id: parts[4]
                    };
                } else if (parts[1] === 'PE' && currentTransaction) {
                    currentTransaction.payee = {
                        ...currentTransaction.payee,
                        name: parts[2],
                        idQualifier: parts[3],
                        id: parts[4]
                    };
                }
                break;

            case 'CLP':
                // CLP*PATIENT_CONTROL_NUMBER*STATUS*CHARGE*PAID*PATIENT_RESP*CLAIM_FILING_IND*PAYER_CLAIM_CONTROL*FACILITY_CODE*FREQUENCY
                currentClaim = {
                    patientControlNumber: parts[1],
                    claimStatus: parts[2],  // 1=processed as primary, 2=secondary, 3=tertiary, 4=denied, 19=reversed, 22=forwarded
                    claimStatusText: claimStatusText(parts[2]),
                    totalCharge: parseFloat(parts[3]) || 0,
                    totalPaid: parseFloat(parts[4]) || 0,
                    patientResponsibility: parseFloat(parts[5]) || 0,
                    claimFilingIndicator: parts[6],
                    payerClaimControlNumber: parts[7],
                    facilityCode: parts[8],
                    claimFrequency: parts[9],
                    services: [],
                    adjustments: [],
                    references: {},
                    remarks: []
                };
                if (currentTransaction) {
                    currentTransaction.claims.push(currentClaim);
                    result.claims.push(currentClaim);
                }
                currentService = null;
                currentContext = 'claim';
                break;

            case 'CAS':
                // CAS*GROUP_CODE*REASON_CODE*AMOUNT*QUANTITY*...(repeating)
                // Groups: CO=Contractual, OA=Other, PI=Payer Initiated, PR=Patient Resp, CR=Correction
                const adjustment = {
                    groupCode: parts[1],
                    adjustments: []
                };
                // CAS segments can have up to 6 reason/amount triplets
                for (let i = 2; i < parts.length; i += 3) {
                    if (parts[i]) {
                        adjustment.adjustments.push({
                            reasonCode: parts[i],
                            amount: parseFloat(parts[i + 1]) || 0,
                            quantity: parts[i + 2] ? parseFloat(parts[i + 2]) : null
                        });
                    }
                }
                if (currentService) {
                    currentService.adjustments.push(adjustment);
                } else if (currentClaim) {
                    currentClaim.adjustments.push(adjustment);
                }
                break;

            case 'NM1':
                // NM1*QC*1*LASTNAME*FIRSTNAME*MI**MEMBER_ID (patient)
                // NM1*IL*1*LASTNAME*FIRSTNAME (insured)
                // NM1*82*1*LASTNAME*FIRSTNAME*MI**NPI (rendering provider)
                if (parts[1] === 'QC' && currentClaim) {
                    currentClaim.patient = {
                        lastName: parts[3],
                        firstName: parts[4],
                        middleInitial: parts[5],
                        idQualifier: parts[8],
                        id: parts[9]
                    };
                } else if (parts[1] === 'IL' && currentClaim) {
                    currentClaim.insured = {
                        lastName: parts[3],
                        firstName: parts[4],
                        id: parts[9]
                    };
                } else if (parts[1] === '82' && currentClaim) {
                    currentClaim.renderingProvider = {
                        lastName: parts[3],
                        firstName: parts[4],
                        npi: parts[9]
                    };
                }
                break;

            case 'SVC':
                // SVC*HC:97153:HN*TOTAL_CHARGE*PAID_AMOUNT*REVENUE_CODE*UNITS*SUBMITTED_PROC_CODE_AND_MODS
                const procParts = (parts[1] || '').split(':');
                const qualifier = procParts[0];
                const cptCode = procParts[1];
                const mod1 = procParts[2];
                const mod2 = procParts[3];
                const mod3 = procParts[4];
                const mod4 = procParts[5];

                currentService = {
                    procedureQualifier: qualifier,
                    cptCode,
                    modifiers: [mod1, mod2, mod3, mod4].filter(Boolean),
                    totalCharge: parseFloat(parts[2]) || 0,
                    totalPaid: parseFloat(parts[3]) || 0,
                    revenueCode: parts[4],
                    units: parseFloat(parts[5]) || 0,
                    adjustments: [],
                    amounts: {},
                    remarks: []
                };
                if (currentClaim) {
                    currentClaim.services.push(currentService);
                }
                currentContext = 'service';
                break;

            case 'AMT':
                // AMT*QUALIFIER*AMOUNT
                // Common qualifiers: B6=allowed, KH=deduction amt, etc.
                const amtQual = parts[1];
                const amtValue = parseFloat(parts[2]) || 0;
                if (currentService) {
                    currentService.amounts[amtQual] = amtValue;
                } else if (currentClaim) {
                    currentClaim.amounts = currentClaim.amounts || {};
                    currentClaim.amounts[amtQual] = amtValue;
                }
                break;

            case 'QTY':
                if (currentClaim) {
                    currentClaim.quantities = currentClaim.quantities || {};
                    currentClaim.quantities[parts[1]] = parseFloat(parts[2]) || 0;
                }
                break;

            case 'LQ':
                // Remark codes
                if (currentService) {
                    currentService.remarks.push({ qualifier: parts[1], code: parts[2] });
                } else if (currentClaim) {
                    currentClaim.remarks.push({ qualifier: parts[1], code: parts[2] });
                }
                break;

            case 'PLB':
                // Provider-level adjustments (not tied to a specific claim)
                const plb = {
                    providerId: parts[1],
                    fiscalDate: formatEdiDate(parts[2]),
                    adjustments: []
                };
                for (let i = 3; i < parts.length; i += 2) {
                    if (parts[i]) {
                        const reasonParts = (parts[i] || '').split(subElementSep);
                        plb.adjustments.push({
                            reasonCode: reasonParts[0],
                            referenceId: reasonParts[1],
                            amount: parseFloat(parts[i + 1]) || 0
                        });
                    }
                }
                result.providerAdjustments.push(plb);
                break;

            case 'SE':
                // End of transaction set
                currentClaim = null;
                currentService = null;
                break;

            case 'IEA':
                // End of interchange
                break;
        }
    }

    return result;
}

function formatEdiDate(ediDate) {
    if (!ediDate) return null;
    const s = String(ediDate).trim();
    if (s.length === 8) {
        // CCYYMMDD
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    } else if (s.length === 6) {
        // YYMMDD → assume 20YY
        return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
    }
    return s;
}

function claimStatusText(code) {
    const map = {
        '1': 'Processed as Primary',
        '2': 'Processed as Secondary',
        '3': 'Processed as Tertiary',
        '4': 'Denied',
        '5': 'Pended',
        '19': 'Reversed',
        '20': 'Reversed — Forwarded',
        '21': 'Forwarded',
        '22': 'Primary Paid, Forwarded',
        '23': 'Not Our Claim',
        '25': 'Predetermination Pricing'
    };
    return map[code] || `Unknown (${code})`;
}

/**
 * Convert parsed 835 into normalized payment records ready for import
 * Shape matches the billing app's payments table expectations
 */
function normalizeForImport(parsed835, fileName) {
    const payments = [];

    for (const transaction of parsed835.transactions) {
        const checkNumber = transaction.trace?.checkOrEftNumber;
        const checkDate = transaction.payment?.effectiveDate;
        const paymentMethod = transaction.payment?.paymentMethod;
        const payerName = transaction.payer?.name;
        const payerIdNumber = transaction.payer?.id;

        for (const claim of transaction.claims) {
            // One payment record per claim (aggregate of service lines)
            const adjustmentTotal = claim.adjustments.reduce((sum, cas) =>
                sum + cas.adjustments.reduce((s, a) => s + a.amount, 0), 0
            );

            // Extract first adjustment reason code for flagging
            const firstAdjReason = claim.adjustments[0]?.adjustments[0];

            payments.push({
                // Claim matching fields
                cr_claim_id: claim.patientControlNumber,  // our internal claim ID
                payer_claim_id: claim.payerClaimControlNumber,
                client_name: claim.patient ? `${claim.patient.lastName}, ${claim.patient.firstName}` : null,

                // Payment details
                check_number: checkNumber,
                check_date: checkDate,
                payment_amount: claim.totalPaid,
                billed_amount: claim.totalCharge,
                adjustment_amount: adjustmentTotal,
                adjustment_reason_code: firstAdjReason?.reasonCode || null,
                adjustment_reason_text: firstAdjReason ? `${claim.adjustments[0].groupCode}/${firstAdjReason.reasonCode}` : null,
                patient_responsibility: claim.patientResponsibility,

                // Context
                payer_name: payerName,
                payer_id_number: payerIdNumber,
                payment_method: paymentMethod,
                claim_status: claim.claimStatus,
                claim_status_text: claim.claimStatusText,
                service_date: claim.serviceDateStart || null,

                // Service line detail (for granular matching)
                service_lines: claim.services.map(s => ({
                    cpt_code: s.cptCode,
                    modifiers: s.modifiers,
                    service_date: s.serviceDate,
                    billed: s.totalCharge,
                    paid: s.totalPaid,
                    units: s.units,
                    allowed: s.amounts?.B6 || null
                })),

                file_name: fileName
            });
        }
    }

    return payments;
}

module.exports = { parse835, normalizeForImport, claimStatusText };
