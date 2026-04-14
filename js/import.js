// ============================================
// Import Engine
// SheetJS parsing, column mapping, validation,
// entity resolution, batch insert
// ============================================

import { supabase } from './supabase-client.js';
import { getCurrentStaff } from './auth.js';
import { showToast } from './ui.js';

// Default column mappings for Central Reach exports
const CR_COLUMN_MAPS = {
    claims: {
        'Claim #': 'cr_claim_id',
        'Claim Number': 'cr_claim_id',
        'Client Name': 'client_name',
        'Client': 'client_name',
        'Client ID': 'cr_client_id',
        'Payer': 'payer_name',
        'Payer Name': 'payer_name',
        'Insurance': 'payer_name',
        'Service Date': 'service_date',
        'Date of Service': 'service_date',
        'DOS': 'service_date',
        'Procedure Code': 'cpt_code',
        'CPT Code': 'cpt_code',
        'CPT': 'cpt_code',
        'Modifier': 'modifier',
        'Mod': 'modifier',
        'Units': 'units',
        'Charge Amount': 'billed_amount',
        'Billed Amount': 'billed_amount',
        'Amount': 'billed_amount',
        'Date Submitted': 'date_submitted',
        'Submit Date': 'date_submitted',
        'Rendering Provider': 'rendering_provider_name',
        'Provider': 'rendering_provider_name',
        'Rendering': 'rendering_provider_name'
    },
    payments: {
        'Claim #': 'cr_claim_id',
        'Claim Number': 'cr_claim_id',
        'Check/EFT #': 'check_number',
        'Check Number': 'check_number',
        'Check #': 'check_number',
        'EFT #': 'check_number',
        'Check Date': 'check_date',
        'Payment Date': 'check_date',
        'Payment Amount': 'payment_amount',
        'Paid Amount': 'payment_amount',
        'Payment': 'payment_amount',
        'Adjustment Amount': 'adjustment_amount',
        'Adjustment': 'adjustment_amount',
        'Adjustment Code': 'adjustment_reason_code',
        'Adj Code': 'adjustment_reason_code',
        'CARC': 'adjustment_reason_code',
        'Payer': 'payer_name',
        'Payer Name': 'payer_name',
        'Client Name': 'client_name',
        'Client': 'client_name',
        'Service Date': 'service_date',
        'DOS': 'service_date',
        'Procedure Code': 'cpt_code',
        'CPT Code': 'cpt_code',
        'CPT': 'cpt_code',
        'Patient Resp': 'patient_responsibility',
        'Patient Responsibility': 'patient_responsibility'
    },
    sessions: {
        'Appointment ID': 'cr_session_id',
        'Session ID': 'cr_session_id',
        'Appt ID': 'cr_session_id',
        'Provider Name': 'staff_name',
        'Provider': 'staff_name',
        'Staff': 'staff_name',
        'Therapist': 'staff_name',
        'Client Name': 'client_name',
        'Client': 'client_name',
        'Date of Service': 'session_date',
        'Service Date': 'session_date',
        'Date': 'session_date',
        'DOS': 'session_date',
        'Start Time': 'start_time',
        'Start': 'start_time',
        'End Time': 'end_time',
        'End': 'end_time',
        'Duration (Hours)': 'duration_hours',
        'Duration': 'duration_hours',
        'Hours': 'duration_hours',
        'Total Hours': 'duration_hours',
        'Service Type': 'session_type',
        'Type': 'session_type',
        'Procedure Code': 'cpt_code',
        'CPT Code': 'cpt_code',
        'CPT': 'cpt_code',
        'Status': 'is_converted',
        'Conversion Status': 'is_converted',
        'Converted': 'is_converted'
    }
};

// Target fields with metadata
const FIELD_DEFS = {
    claims: {
        cr_claim_id: { label: 'Claim ID', required: false },
        client_name: { label: 'Client Name', required: true },
        cr_client_id: { label: 'CR Client ID', required: false },
        payer_name: { label: 'Payer', required: true },
        service_date: { label: 'Service Date', required: true, type: 'date' },
        cpt_code: { label: 'CPT Code', required: true },
        modifier: { label: 'Modifier', required: false },
        units: { label: 'Units', required: true, type: 'number' },
        billed_amount: { label: 'Billed Amount', required: true, type: 'number' },
        date_submitted: { label: 'Date Submitted', required: false, type: 'date' },
        rendering_provider_name: { label: 'Rendering Provider', required: false }
    },
    payments: {
        cr_claim_id: { label: 'Claim ID', required: true },
        check_number: { label: 'Check #', required: true },
        check_date: { label: 'Check Date', required: true, type: 'date' },
        payment_amount: { label: 'Payment Amount', required: true, type: 'number' },
        adjustment_amount: { label: 'Adjustment Amount', required: false, type: 'number' },
        adjustment_reason_code: { label: 'Adjustment Code', required: false },
        payer_name: { label: 'Payer', required: true },
        client_name: { label: 'Client Name', required: false },
        service_date: { label: 'Service Date', required: false, type: 'date' },
        cpt_code: { label: 'CPT Code', required: false },
        patient_responsibility: { label: 'Patient Resp.', required: false, type: 'number' }
    },
    sessions: {
        cr_session_id: { label: 'Session ID', required: false },
        staff_name: { label: 'Staff Name', required: true },
        client_name: { label: 'Client Name', required: true },
        session_date: { label: 'Session Date', required: true, type: 'date' },
        start_time: { label: 'Start Time', required: false },
        end_time: { label: 'End Time', required: false },
        duration_hours: { label: 'Duration (Hours)', required: true, type: 'number' },
        session_type: { label: 'Session Type', required: false },
        cpt_code: { label: 'CPT Code', required: false },
        is_converted: { label: 'Converted', required: true }
    }
};

// --- File Parsing ---

function parseFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array', cellDates: true });
                resolve(workbook);
            } catch (err) {
                reject(new Error('Failed to parse file: ' + err.message));
            }
        };
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsArrayBuffer(file);
    });
}

function getSheetData(workbook, sheetIndex = 0) {
    const sheetName = workbook.SheetNames[sheetIndex];
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    return { sheetName, rows: json, headers: json.length > 0 ? Object.keys(json[0]) : [] };
}

// --- Auto Column Mapping ---

function autoMapColumns(headers, importType) {
    const mapping = {};
    const knownMap = CR_COLUMN_MAPS[importType] || {};

    for (const header of headers) {
        const trimmed = header.trim();
        // Exact match
        if (knownMap[trimmed]) {
            mapping[header] = knownMap[trimmed];
            continue;
        }
        // Case-insensitive match
        const lower = trimmed.toLowerCase();
        const match = Object.entries(knownMap).find(([k]) => k.toLowerCase() === lower);
        if (match) {
            mapping[header] = match[1];
            continue;
        }
        // Partial match
        const partial = Object.entries(knownMap).find(([k]) =>
            lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)
        );
        if (partial) {
            mapping[header] = partial[1];
        }
    }

    return mapping;
}

// --- Apply Mapping ---

function applyMapping(rows, mapping, importType) {
    const fields = FIELD_DEFS[importType];
    return rows.map((row, idx) => {
        const mapped = { _rowNum: idx + 2 }; // +2 for 1-indexed + header row

        for (const [srcCol, targetField] of Object.entries(mapping)) {
            if (!targetField || targetField === '_skip') continue;
            let val = row[srcCol];

            // Type conversions
            const fieldDef = fields[targetField];
            if (fieldDef?.type === 'date' && val) {
                val = normalizeDate(val);
            } else if (fieldDef?.type === 'number' && val !== '') {
                val = parseFloat(String(val).replace(/[$,]/g, '')) || 0;
            }

            // Boolean conversion for is_converted
            if (targetField === 'is_converted') {
                val = normalizeBool(val);
            }

            // Session type normalization
            if (targetField === 'session_type') {
                val = normalizeSessionType(val);
            }

            mapped[targetField] = val;
        }

        return mapped;
    });
}

function normalizeDate(val) {
    if (val instanceof Date) {
        return val.toISOString().split('T')[0];
    }
    const str = String(val).trim();
    // Try ISO format
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
    // Try MM/DD/YYYY
    const parts = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (parts) {
        const year = parts[3].length === 2 ? '20' + parts[3] : parts[3];
        return `${year}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    }
    return str;
}

function normalizeBool(val) {
    if (typeof val === 'boolean') return val;
    const str = String(val).toLowerCase().trim();
    return ['true', 'yes', '1', 'converted', 'complete', 'completed', 'kept'].includes(str);
}

function normalizeSessionType(val) {
    const str = String(val).toLowerCase().trim();
    if (str.includes('direct') || str.includes('1:1') || str === '97153') return 'direct';
    if (str.includes('supervis') || str === '97155') return 'supervision';
    if (str.includes('assess') || str === '97151') return 'assessment';
    if (str.includes('parent') || str.includes('caregiver') || str === '97156') return 'parent_training';
    return 'other';
}

// --- Validation ---

function validateRows(mappedRows, importType) {
    const fields = FIELD_DEFS[importType];
    const errors = [];
    const warnings = [];

    for (const row of mappedRows) {
        const rowNum = row._rowNum;

        for (const [field, def] of Object.entries(fields)) {
            const val = row[field];
            if (def.required && (val === undefined || val === null || val === '')) {
                errors.push({ row: rowNum, field: def.label, message: `Missing required field: ${def.label}` });
            }
            if (def.type === 'date' && val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
                errors.push({ row: rowNum, field: def.label, message: `Invalid date format: "${val}"` });
            }
            if (def.type === 'number' && val !== undefined && val !== '' && isNaN(val)) {
                errors.push({ row: rowNum, field: def.label, message: `Invalid number: "${val}"` });
            }
        }
    }

    return { errors, warnings, isValid: errors.length === 0 };
}

// --- Entity Resolution ---

async function resolveEntities(mappedRows, importType) {
    const resolutions = { clients: {}, payers: {}, staff: {} };
    const unresolved = { clients: new Set(), payers: new Set(), staff: new Set() };

    // Collect unique names
    const clientNames = new Set();
    const payerNames = new Set();
    const staffNames = new Set();

    for (const row of mappedRows) {
        if (row.client_name) clientNames.add(row.client_name.trim());
        if (row.payer_name) payerNames.add(row.payer_name.trim());
        if (row.rendering_provider_name) staffNames.add(row.rendering_provider_name.trim());
        if (row.staff_name) staffNames.add(row.staff_name.trim());
    }

    // Resolve clients
    if (clientNames.size > 0) {
        const { data: clients } = await supabase.from('clients').select('id, first_name, last_name, cr_client_id');
        if (clients) {
            for (const name of clientNames) {
                const match = findClientMatch(name, clients);
                if (match) {
                    resolutions.clients[name] = match.id;
                } else {
                    unresolved.clients.add(name);
                }
            }
        }

        // Also try matching by cr_client_id
        const crIds = mappedRows.filter(r => r.cr_client_id).map(r => r.cr_client_id);
        if (crIds.length > 0 && clients) {
            for (const row of mappedRows) {
                if (row.cr_client_id && !resolutions.clients[row.client_name]) {
                    const match = clients.find(c => c.cr_client_id === row.cr_client_id);
                    if (match) {
                        resolutions.clients[row.client_name] = match.id;
                        unresolved.clients.delete(row.client_name);
                    }
                }
            }
        }
    }

    // Resolve payers
    if (payerNames.size > 0) {
        const { data: payers } = await supabase.from('insurance_payers').select('id, name');
        if (payers) {
            for (const name of payerNames) {
                const match = payers.find(p =>
                    p.name.toLowerCase() === name.toLowerCase() ||
                    p.name.toLowerCase().includes(name.toLowerCase()) ||
                    name.toLowerCase().includes(p.name.toLowerCase())
                );
                if (match) {
                    resolutions.payers[name] = match.id;
                } else {
                    unresolved.payers.add(name);
                }
            }
        }
    }

    // Resolve staff
    if (staffNames.size > 0) {
        const { data: staff } = await supabase.from('staff').select('id, first_name, last_name');
        if (staff) {
            for (const name of staffNames) {
                const match = findStaffMatch(name, staff);
                if (match) {
                    resolutions.staff[name] = match.id;
                } else {
                    unresolved.staff.add(name);
                }
            }
        }
    }

    return { resolutions, unresolved };
}

function findClientMatch(name, clients) {
    const lower = name.toLowerCase().trim();
    // Try "Last, First" format
    const commaMatch = lower.match(/^(.+?),\s*(.+)$/);
    if (commaMatch) {
        const [, last, first] = commaMatch;
        return clients.find(c =>
            c.last_name.toLowerCase() === last.trim() &&
            c.first_name.toLowerCase().startsWith(first.trim())
        );
    }
    // Try "First Last" format
    const parts = lower.split(/\s+/);
    if (parts.length >= 2) {
        const first = parts[0];
        const last = parts.slice(1).join(' ');
        return clients.find(c =>
            c.first_name.toLowerCase() === first &&
            c.last_name.toLowerCase() === last
        ) || clients.find(c =>
            c.last_name.toLowerCase() === first &&
            c.first_name.toLowerCase() === last
        );
    }
    return null;
}

function findStaffMatch(name, staff) {
    const lower = name.toLowerCase().trim();
    const commaMatch = lower.match(/^(.+?),\s*(.+)$/);
    if (commaMatch) {
        const [, last, first] = commaMatch;
        return staff.find(s =>
            s.last_name.toLowerCase() === last.trim() &&
            s.first_name.toLowerCase().startsWith(first.trim())
        );
    }
    const parts = lower.split(/\s+/);
    if (parts.length >= 2) {
        const first = parts[0];
        const last = parts.slice(1).join(' ');
        return staff.find(s =>
            s.first_name.toLowerCase() === first &&
            s.last_name.toLowerCase() === last
        ) || staff.find(s =>
            s.last_name.toLowerCase() === first &&
            s.first_name.toLowerCase() === last
        );
    }
    return null;
}

// --- Batch Insert ---

async function importClaims(mappedRows, resolutions, fileName) {
    const staff = getCurrentStaff();

    // Create import log
    const { data: log, error: logErr } = await supabase
        .from('import_logs')
        .insert({
            imported_by: staff.id,
            import_type: 'claims',
            file_name: fileName,
            row_count: mappedRows.length,
            source: 'spreadsheet'
        })
        .select()
        .single();

    if (logErr) throw new Error('Failed to create import log: ' + logErr.message);

    // Look up contract rates for expected amount
    const { data: rates } = await supabase.from('contract_rates').select('*');
    const rateMap = {};
    if (rates) {
        for (const r of rates) {
            const key = `${r.payer_id}|${r.cpt_code}|${r.modifier || ''}`;
            if (!rateMap[key] || r.effective_date > rateMap[key].effective_date) {
                rateMap[key] = r;
            }
        }
    }

    let successCount = 0;
    let errorCount = 0;
    const errorDetails = [];

    for (const row of mappedRows) {
        try {
            const clientId = resolutions.clients[row.client_name] || null;
            const payerId = resolutions.payers[row.payer_name] || null;
            const providerId = resolutions.staff[row.rendering_provider_name] || null;

            // Calculate expected amount from contract rate
            let expectedAmount = null;
            if (payerId && row.cpt_code) {
                const rateKey = `${payerId}|${row.cpt_code}|${row.modifier || ''}`;
                const rate = rateMap[rateKey];
                if (rate && row.units) {
                    expectedAmount = parseFloat(rate.rate_per_unit) * parseFloat(row.units);
                }
            }

            const { error } = await supabase.from('claims').insert({
                cr_claim_id: row.cr_claim_id || null,
                client_id: clientId,
                payer_id: payerId,
                rendering_provider_id: providerId,
                service_date: row.service_date,
                cpt_code: row.cpt_code,
                modifier: row.modifier || null,
                units: parseFloat(row.units),
                billed_amount: parseFloat(row.billed_amount),
                expected_amount: expectedAmount,
                date_submitted: row.date_submitted || null,
                import_log_id: log.id
            });

            if (error) throw error;
            successCount++;
        } catch (err) {
            errorCount++;
            errorDetails.push({ row: row._rowNum, message: err.message });
        }
    }

    // Update import log
    await supabase.from('import_logs').update({
        success_count: successCount,
        error_count: errorCount,
        error_details: errorDetails.length > 0 ? errorDetails : null
    }).eq('id', log.id);

    return { successCount, errorCount, errorDetails, logId: log.id };
}

async function importPayments(mappedRows, resolutions, fileName) {
    const staff = getCurrentStaff();

    const { data: log, error: logErr } = await supabase
        .from('import_logs')
        .insert({
            imported_by: staff.id,
            import_type: 'payments',
            file_name: fileName,
            row_count: mappedRows.length,
            source: 'spreadsheet'
        })
        .select()
        .single();

    if (logErr) throw new Error('Failed to create import log: ' + logErr.message);

    let successCount = 0;
    let errorCount = 0;
    const errorDetails = [];

    for (const row of mappedRows) {
        try {
            const payerId = resolutions.payers[row.payer_name] || null;

            const { error } = await supabase.from('payments').insert({
                payer_id: payerId,
                check_number: row.check_number || null,
                check_date: row.check_date || null,
                payment_amount: parseFloat(row.payment_amount) || 0,
                adjustment_amount: parseFloat(row.adjustment_amount) || 0,
                adjustment_reason_code: row.adjustment_reason_code || null,
                patient_responsibility: parseFloat(row.patient_responsibility) || 0,
                is_matched: false,
                import_log_id: log.id
            });

            if (error) throw error;
            successCount++;
        } catch (err) {
            errorCount++;
            errorDetails.push({ row: row._rowNum, message: err.message });
        }
    }

    await supabase.from('import_logs').update({
        success_count: successCount,
        error_count: errorCount,
        error_details: errorDetails.length > 0 ? errorDetails : null
    }).eq('id', log.id);

    return { successCount, errorCount, errorDetails, logId: log.id };
}

async function importSessions(mappedRows, resolutions, fileName) {
    const staff = getCurrentStaff();

    const { data: log, error: logErr } = await supabase
        .from('import_logs')
        .insert({
            imported_by: staff.id,
            import_type: 'sessions',
            file_name: fileName,
            row_count: mappedRows.length,
            source: 'spreadsheet'
        })
        .select()
        .single();

    if (logErr) throw new Error('Failed to create import log: ' + logErr.message);

    let successCount = 0;
    let errorCount = 0;
    const errorDetails = [];

    for (const row of mappedRows) {
        try {
            const staffId = resolutions.staff[row.staff_name] || null;
            const clientId = resolutions.clients[row.client_name] || null;

            if (!staffId) {
                throw new Error(`Staff member not found: "${row.staff_name}"`);
            }

            const { error } = await supabase.from('sessions').insert({
                cr_session_id: row.cr_session_id || null,
                staff_id: staffId,
                client_id: clientId,
                session_date: row.session_date,
                start_time: row.start_time || null,
                end_time: row.end_time || null,
                duration_hours: parseFloat(row.duration_hours),
                session_type: row.session_type || 'direct',
                cpt_code: row.cpt_code || null,
                is_converted: row.is_converted,
                import_log_id: log.id
            });

            if (error) throw error;
            successCount++;
        } catch (err) {
            errorCount++;
            errorDetails.push({ row: row._rowNum, message: err.message });
        }
    }

    await supabase.from('import_logs').update({
        success_count: successCount,
        error_count: errorCount,
        error_details: errorDetails.length > 0 ? errorDetails : null
    }).eq('id', log.id);

    return { successCount, errorCount, errorDetails, logId: log.id };
}

// --- Import UI Component ---

function createImportUI(containerId, importType, onComplete) {
    const container = document.getElementById(containerId);
    let workbook = null;
    let sheetData = null;
    let columnMapping = {};
    let mappedRows = [];
    let entityResolutions = null;

    function render() {
        container.innerHTML = `
            <div class="dropzone" id="import-dropzone">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <p><strong>Drop your file here</strong> or click to browse</p>
                <p class="dropzone-hint">Supports CSV, XLSX, XLS</p>
                <input type="file" id="import-file-input" accept=".csv,.xlsx,.xls" style="display:none">
            </div>
            <div id="import-steps" style="display:none;">
                <div id="step-mapping"></div>
                <div id="step-validation"></div>
                <div id="step-resolution"></div>
                <div id="step-results"></div>
            </div>
        `;

        const dropzone = document.getElementById('import-dropzone');
        const fileInput = document.getElementById('import-file-input');

        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length) handleFile(fileInput.files[0]);
        });
    }

    async function handleFile(file) {
        try {
            workbook = await parseFile(file);
            sheetData = getSheetData(workbook, 0);

            if (sheetData.rows.length === 0) {
                showToast('File is empty or has no data rows.', 'error');
                return;
            }

            columnMapping = autoMapColumns(sheetData.headers, importType);
            document.getElementById('import-steps').style.display = 'block';
            document.getElementById('import-dropzone').innerHTML = `
                <p><strong>${file.name}</strong> — ${sheetData.rows.length} rows, ${sheetData.headers.length} columns</p>
                <p class="dropzone-hint">Sheet: ${sheetData.sheetName}</p>
            `;

            renderMappingStep();
        } catch (err) {
            showToast('Error reading file: ' + err.message, 'error');
        }
    }

    function renderMappingStep() {
        const fields = FIELD_DEFS[importType];
        const targetOptions = Object.entries(fields)
            .map(([key, def]) => `<option value="${key}">${def.label}${def.required ? ' *' : ''}</option>`)
            .join('');

        let html = `<h3 class="mb-2">Column Mapping</h3>
            <p class="text-sm text-muted mb-2">Map your spreadsheet columns to the correct fields. Required fields are marked with *.</p>
            <div class="column-mapper"><table class="data-table"><thead><tr>`;

        for (const header of sheetData.headers) {
            const mapped = columnMapping[header] || '';
            html += `<th>
                <div class="text-xs mb-1" title="${header}">${header.length > 20 ? header.slice(0, 18) + '...' : header}</div>
                <select class="mapper-select" data-header="${header}">
                    <option value="_skip">— Skip —</option>
                    ${targetOptions}
                </select>
            </th>`;
        }

        html += '</tr></thead><tbody>';

        // Preview rows (first 5)
        const preview = sheetData.rows.slice(0, 5);
        for (const row of preview) {
            html += '<tr>';
            for (const header of sheetData.headers) {
                const val = row[header];
                const display = val instanceof Date ? val.toLocaleDateString() : String(val ?? '');
                html += `<td title="${display}">${display}</td>`;
            }
            html += '</tr>';
        }

        html += `</tbody></table></div>
            <div class="flex-between mt-2">
                <span class="text-sm text-muted">Showing first ${Math.min(5, sheetData.rows.length)} of ${sheetData.rows.length} rows</span>
                <button class="btn btn-primary" id="validate-btn">Validate & Continue</button>
            </div>`;

        document.getElementById('step-mapping').innerHTML = html;

        // Set auto-mapped values
        document.querySelectorAll('.mapper-select').forEach(select => {
            const header = select.dataset.header;
            if (columnMapping[header]) {
                select.value = columnMapping[header];
            }
        });

        // Update mapping on change
        document.querySelectorAll('.mapper-select').forEach(select => {
            select.addEventListener('change', () => {
                columnMapping[select.dataset.header] = select.value;
            });
        });

        document.getElementById('validate-btn').addEventListener('click', runValidation);
    }

    async function runValidation() {
        // Collect final mapping
        document.querySelectorAll('.mapper-select').forEach(select => {
            columnMapping[select.dataset.header] = select.value;
        });

        mappedRows = applyMapping(sheetData.rows, columnMapping, importType);
        const { errors, warnings, isValid } = validateRows(mappedRows, importType);

        let html = '<h3 class="mb-2">Validation Results</h3>';

        if (isValid) {
            html += '<div class="card" style="background:var(--color-success-light);border-color:var(--color-success);">';
            html += `<p class="text-sm"><strong>All ${mappedRows.length} rows passed validation.</strong></p></div>`;
        } else {
            html += '<div class="card" style="background:var(--color-danger-light);border-color:var(--color-danger);">';
            html += `<p class="text-sm"><strong>${errors.length} errors found.</strong> Fix these in your spreadsheet or adjust column mapping.</p>`;
            html += '<ul class="text-sm mt-1" style="padding-left:20px;">';
            for (const err of errors.slice(0, 20)) {
                html += `<li>Row ${err.row}: ${err.message}</li>`;
            }
            if (errors.length > 20) html += `<li>...and ${errors.length - 20} more</li>`;
            html += '</ul></div>';
        }

        if (isValid) {
            html += '<div class="mt-2"><button class="btn btn-primary" id="resolve-btn">Resolve Entities & Import</button></div>';
        } else {
            html += '<div class="mt-2"><button class="btn btn-secondary" id="back-mapping-btn">Back to Mapping</button></div>';
        }

        document.getElementById('step-validation').innerHTML = html;

        if (isValid) {
            document.getElementById('resolve-btn').addEventListener('click', runResolution);
        } else {
            document.getElementById('back-mapping-btn')?.addEventListener('click', renderMappingStep);
        }
    }

    async function runResolution() {
        const resolveBtn = document.getElementById('resolve-btn');
        resolveBtn.disabled = true;
        resolveBtn.textContent = 'Resolving...';

        try {
            entityResolutions = await resolveEntities(mappedRows, importType);

            const { unresolved } = entityResolutions;
            const hasUnresolved = unresolved.clients.size > 0 || unresolved.payers.size > 0 || unresolved.staff.size > 0;

            let html = '<h3 class="mb-2">Entity Resolution</h3>';

            if (hasUnresolved) {
                html += '<div class="card mb-2" style="background:var(--color-warning-light);border-color:var(--color-warning);">';
                html += '<p class="text-sm"><strong>Some names could not be matched to existing records.</strong> Rows with unresolved names will still be imported but without linked IDs.</p>';

                if (unresolved.clients.size > 0) {
                    html += `<p class="text-sm mt-1"><strong>Unresolved clients:</strong> ${[...unresolved.clients].join(', ')}</p>`;
                }
                if (unresolved.payers.size > 0) {
                    html += `<p class="text-sm mt-1"><strong>Unresolved payers:</strong> ${[...unresolved.payers].join(', ')}</p>`;
                }
                if (unresolved.staff.size > 0) {
                    html += `<p class="text-sm mt-1"><strong>Unresolved staff:</strong> ${[...unresolved.staff].join(', ')}</p>`;
                }
                html += '</div>';
            } else {
                html += '<div class="card" style="background:var(--color-success-light);border-color:var(--color-success);">';
                html += '<p class="text-sm"><strong>All entities resolved successfully.</strong></p></div>';
            }

            html += `<div class="mt-2">
                <button class="btn btn-primary" id="import-btn">Import ${mappedRows.length} Rows</button>
                <button class="btn btn-secondary" id="cancel-import-btn">Cancel</button>
            </div>`;

            document.getElementById('step-resolution').innerHTML = html;

            document.getElementById('import-btn').addEventListener('click', executeImport);
            document.getElementById('cancel-import-btn').addEventListener('click', render);
        } catch (err) {
            showToast('Resolution failed: ' + err.message, 'error');
            resolveBtn.disabled = false;
            resolveBtn.textContent = 'Resolve Entities & Import';
        }
    }

    async function executeImport() {
        const importBtn = document.getElementById('import-btn');
        importBtn.disabled = true;
        importBtn.textContent = 'Importing...';

        try {
            let result;
            const fileName = document.querySelector('#import-dropzone strong')?.textContent || 'unknown';

            if (importType === 'claims') {
                result = await importClaims(mappedRows, entityResolutions.resolutions, fileName);
            } else if (importType === 'payments') {
                result = await importPayments(mappedRows, entityResolutions.resolutions, fileName);
            } else if (importType === 'sessions') {
                result = await importSessions(mappedRows, entityResolutions.resolutions, fileName);
            }

            let html = '<h3 class="mb-2">Import Complete</h3>';
            html += '<div class="card" style="background:var(--color-success-light);border-color:var(--color-success);">';
            html += `<p class="text-sm"><strong>${result.successCount} rows imported successfully.</strong></p>`;
            if (result.errorCount > 0) {
                html += `<p class="text-sm text-danger">${result.errorCount} rows failed.</p>`;
                html += '<ul class="text-sm mt-1" style="padding-left:20px;">';
                for (const err of result.errorDetails.slice(0, 10)) {
                    html += `<li>Row ${err.row}: ${err.message}</li>`;
                }
                html += '</ul>';
            }
            html += '</div>';
            html += '<div class="mt-2"><button class="btn btn-secondary" id="import-again-btn">Import Another File</button></div>';

            document.getElementById('step-results').innerHTML = html;
            document.getElementById('step-resolution').innerHTML = '';
            document.getElementById('import-again-btn').addEventListener('click', render);

            if (onComplete) onComplete(result);
        } catch (err) {
            showToast('Import failed: ' + err.message, 'error');
            importBtn.disabled = false;
            importBtn.textContent = `Import ${mappedRows.length} Rows`;
        }
    }

    render();
    return { reset: render };
}

// --- SpreadsheetParser (used by DataSource) ---

const SpreadsheetParser = {
    parseClaims(file) {
        return parseAndMap(file, 'claims');
    },
    parsePayments(file) {
        return parseAndMap(file, 'payments');
    },
    parseSessions(file) {
        return parseAndMap(file, 'sessions');
    }
};

async function parseAndMap(file, type) {
    const workbook = await parseFile(file);
    const { rows, headers } = getSheetData(workbook);
    const mapping = autoMapColumns(headers, type);
    return applyMapping(rows, mapping, type);
}

export {
    SpreadsheetParser,
    createImportUI,
    parseFile,
    getSheetData,
    autoMapColumns,
    applyMapping,
    validateRows,
    resolveEntities,
    importClaims,
    importPayments,
    importSessions,
    CR_COLUMN_MAPS,
    FIELD_DEFS
};
