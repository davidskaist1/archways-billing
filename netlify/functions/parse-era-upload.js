// ============================================
// Manual ERA Upload Parser
// POST an 835 file content and get back parsed preview (without committing to DB)
// Also supports commit=true to actually import it
// ============================================

const { parse835, normalizeForImport } = require('./_lib/edi-835-parser');
const { parse277CA } = require('./_lib/edi-277ca-parser');

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    try {
        const body = JSON.parse(event.body);
        const { content, fileName = 'manual-upload.edi', commit = false } = body;

        if (!content) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing content' }) };
        }

        const isERA = content.includes('ST*835');
        const is277CA = content.includes('ST*277');

        if (!isERA && !is277CA) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Not a valid 835 or 277CA file' })
            };
        }

        if (isERA) {
            const parsed = parse835(content);
            const normalized = normalizeForImport(parsed, fileName);

            return {
                statusCode: 200,
                body: JSON.stringify({
                    type: 'era_835',
                    summary: {
                        transactions: parsed.transactions.length,
                        totalClaims: parsed.claims.length,
                        totalPaid: parsed.transactions.reduce((s, t) => s + (t.payment?.totalPaid || 0), 0)
                    },
                    parsed,
                    normalized
                })
            };
        } else {
            const parsed = parse277CA(content);
            return {
                statusCode: 200,
                body: JSON.stringify({
                    type: '277ca',
                    summary: {
                        acknowledgments: parsed.acknowledgments.length
                    },
                    parsed
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
