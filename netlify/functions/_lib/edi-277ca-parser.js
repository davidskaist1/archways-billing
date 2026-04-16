// ============================================
// EDI X12 277CA (Claim Acknowledgment) Parser
// Tracks claim accept/reject status from clearinghouse and payer
// ============================================

function parse277CA(rawContent) {
    if (!rawContent || typeof rawContent !== 'string') {
        throw new Error('Invalid 277CA content');
    }

    const isaStart = rawContent.indexOf('ISA');
    if (isaStart === -1) throw new Error('No ISA segment found');

    const elementSep = rawContent.charAt(isaStart + 3);
    const segmentSep = rawContent.charAt(isaStart + 105);

    const segments = rawContent
        .substring(isaStart)
        .split(segmentSep)
        .map(s => s.trim().replace(/\r?\n/g, ''))
        .filter(s => s.length > 0);

    const result = {
        interchange: {},
        acknowledgments: []
    };

    let currentAck = null;

    for (const segment of segments) {
        const parts = segment.split(elementSep);
        const code = parts[0];

        switch (code) {
            case 'ISA':
                result.interchange = {
                    senderId: parts[6]?.trim(),
                    receiverId: parts[8]?.trim(),
                    date: parts[9],
                    time: parts[10]
                };
                break;

            case 'BHT':
                result.purpose = parts[2];
                result.referenceId = parts[3];
                result.date = formatEdiDate(parts[4]);
                break;

            case 'TRN':
                if (currentAck) {
                    currentAck.traceNumber = parts[2];
                }
                break;

            case 'REF':
                // REF*1K*PAYER_CLAIM_NUMBER or REF*D9*CLEARINGHOUSE_TRACE
                if (currentAck) {
                    currentAck.references = currentAck.references || {};
                    currentAck.references[parts[1]] = parts[2];
                }
                break;

            case 'NM1':
                // NM1*QC = patient claim, NM1*41 = submitter, NM1*40 = receiver
                if (parts[1] === 'QC') {
                    currentAck = currentAck || {};
                    currentAck.patient = {
                        lastName: parts[3],
                        firstName: parts[4],
                        id: parts[9]
                    };
                }
                break;

            case 'STC':
                // Status segment: STC*A1:19:PR*20230515*WQ*1234.56
                // Composite status: CATEGORY:CODE:ENTITY
                const statusParts = (parts[1] || '').split(':');
                const ack = {
                    statusCategory: statusParts[0],  // A0=Ack, A1=Receipt, A2=Accepted, A3=Returned, A4=Not found, A5, A6, A7, A8
                    statusCode: statusParts[1],
                    entityCode: statusParts[2],
                    statusDate: formatEdiDate(parts[2]),
                    actionCode: parts[3],
                    totalAmount: parseFloat(parts[4]) || 0,
                    statusText: statusCategoryText(statusParts[0]),
                    references: {}
                };
                currentAck = { ...ack };
                result.acknowledgments.push(currentAck);
                break;

            case 'SE':
                currentAck = null;
                break;
        }
    }

    return result;
}

function formatEdiDate(ediDate) {
    if (!ediDate) return null;
    const s = String(ediDate).trim();
    if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (s.length === 6) return `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
    return s;
}

function statusCategoryText(code) {
    const map = {
        'A0': 'Acknowledgment — Rejected',
        'A1': 'Acknowledgment — Receipt',
        'A2': 'Acknowledgment — Acceptance',
        'A3': 'Acknowledgment — Returned as unprocessable',
        'A4': 'Acknowledgment — Not Found',
        'A5': 'Acknowledgment — Split Claim',
        'A6': 'Acknowledgment — Rejected for Missing Information',
        'A7': 'Acknowledgment — Rejected for Invalid Information',
        'A8': 'Acknowledgment — Rejected for Relational Field Error',
        'F0': 'Finalized',
        'F1': 'Finalized — Payment',
        'F2': 'Finalized — Denial',
        'F3': 'Finalized — Revised',
        'F4': 'Finalized — Adjudication Complete',
        'P0': 'Pending',
        'P1': 'Pending — In Process',
        'P2': 'Pending — Incomplete',
        'P3': 'Pending — Payer Review',
        'P4': 'Pending — Patient Review',
        'R0': 'Requests for Additional Info',
        'R1': 'Request Provider Info',
        'R3': 'Request Medical Records'
    };
    return map[code] || `Unknown (${code})`;
}

module.exports = { parse277CA, statusCategoryText };
