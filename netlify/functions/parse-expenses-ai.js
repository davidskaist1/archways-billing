// Parse a spreadsheet of expenses using Claude API
// Takes raw parsed rows from a CSV/XLSX (already extracted client-side via SheetJS)
// Returns structured expense records ready to insert
//
// Required env var: ANTHROPIC_API_KEY

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CATEGORIES = [
    'rent', 'utilities', 'software', 'marketing', 'insurance', 'legal',
    'accounting', 'office_supplies', 'travel', 'professional_services',
    'taxes', 'dues_subscriptions', 'other'
];

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'POST only' }) };
    }
    if (!ANTHROPIC_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }) };
    }

    try {
        const { rows, headers } = JSON.parse(event.body);
        if (!Array.isArray(rows) || rows.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'rows array required' }) };
        }

        // Cap at 200 rows per request to keep token usage reasonable
        const sampleRows = rows.slice(0, 200);

        const systemPrompt = `You are a financial data assistant. The user uploaded a spreadsheet of business expenses for an Applied Behavior Analysis (ABA) therapy agency. Your job is to extract clean, structured expense records from the messy raw data.

Return a JSON object with this exact shape (no markdown, no commentary):
{
  "expenses": [
    {
      "expense_date": "YYYY-MM-DD",
      "category": "<one of: ${CATEGORIES.join(', ')}>",
      "description": "Short clear description",
      "amount": <number, no currency symbols>,
      "vendor": "Vendor name or null",
      "is_recurring": <true if this looks like a monthly/quarterly/annual subscription, else false>,
      "recurrence_frequency": "monthly" | "quarterly" | "annually" | null,
      "notes": "Any extra context worth saving, or null",
      "source_row": <0-indexed row number from the input>,
      "confidence": "high" | "medium" | "low"
    }
  ],
  "skipped_rows": [
    { "source_row": <number>, "reason": "Why this row was skipped" }
  ]
}

Rules:
- Skip rows that are clearly headers, totals, subtotals, blank rows, or non-expense data
- Skip income/revenue rows
- Skip personal expenses if you can identify them (e.g., "lunch with friend")
- For ambiguous categorization, use "other" and set confidence to "low"
- Software/SaaS subscriptions = "software"; rent of any kind = "rent"; insurance premiums = "insurance"; legal fees = "legal"; accountant/CPA = "accounting"; ads/website = "marketing"
- "is_recurring" should be TRUE for things that obviously repeat (monthly software, quarterly insurance) and FALSE for one-time items
- If a date is ambiguous, default to a reasonable interpretation (US format MM/DD/YYYY)
- Amounts must be positive numbers (no parentheses, no minus signs — those usually indicate the same thing as positive in expense lists)
- Be aggressive about extracting; the user can review and discard before final import`;

        const userPrompt = `Spreadsheet headers: ${JSON.stringify(headers)}

First ${sampleRows.length} rows of data:
${JSON.stringify(sampleRows, null, 2)}

Extract structured expense records as specified.`;

        const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5',
                max_tokens: 8000,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }]
            })
        });

        if (!apiRes.ok) {
            const errText = await apiRes.text();
            return { statusCode: apiRes.status, body: JSON.stringify({ ok: false, error: 'Anthropic API error: ' + errText }) };
        }

        const apiData = await apiRes.json();
        const content = apiData.content?.[0]?.text || '';

        // Extract JSON from the response (Claude usually returns clean JSON,
        // but strip any code fences just in case)
        const jsonText = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch (e) {
            return {
                statusCode: 500,
                body: JSON.stringify({
                    ok: false,
                    error: 'Failed to parse AI response as JSON',
                    raw_response: content.substring(0, 1000)
                })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                ok: true,
                expenses: parsed.expenses || [],
                skipped_rows: parsed.skipped_rows || [],
                row_count_processed: sampleRows.length,
                row_count_total: rows.length
            })
        };

    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
    }
};
