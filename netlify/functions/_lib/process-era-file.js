// ============================================
// Shared helper: extract EDI content from a downloaded file
// Handles:
//   - Raw EDI (.txt, .835, .277, .dat)
//   - Zipped EDI (.zip containing EDI files)
// ============================================

const AdmZip = require('adm-zip');

/**
 * Given a file buffer and filename, return an array of
 * { filename, content, fileType } extracted from it.
 * - If it's a zip, extracts all EDI-looking files inside
 * - If it's plain text, returns as-is
 * - fileType: 'era' | '277ca' | 'unknown'
 */
function extractEdiContent(buffer, filename) {
    const results = [];
    const lowerName = (filename || '').toLowerCase();

    // Detect zip by magic bytes (PK\x03\x04) or extension
    const isZip = (buffer.length >= 4 &&
                   buffer[0] === 0x50 && buffer[1] === 0x4B &&
                   buffer[2] === 0x03 && buffer[3] === 0x04) ||
                  lowerName.endsWith('.zip');

    if (isZip) {
        try {
            const zip = new AdmZip(buffer);
            const entries = zip.getEntries();

            for (const entry of entries) {
                if (entry.isDirectory) continue;

                const entryName = entry.entryName.toLowerCase();
                // Skip the human-readable version (usually .pdf or .txt with pretty formatting)
                // Keep the raw EDI file (.835, .dat, .edi, or a .txt that starts with ISA)
                if (entryName.endsWith('.pdf')) continue;

                const content = entry.getData().toString('utf8');

                // Only keep files that look like EDI
                if (content.startsWith('ISA') || content.startsWith('ISA*')) {
                    results.push({
                        filename: entry.entryName,
                        content,
                        fileType: classifyEdi(content)
                    });
                }
            }

            if (results.length === 0) {
                throw new Error('Zip contained no valid EDI files');
            }
        } catch (err) {
            throw new Error(`Failed to extract zip: ${err.message}`);
        }
    } else {
        // Plain EDI file
        const content = buffer.toString('utf8');
        if (content.startsWith('ISA') || content.startsWith('ISA*')) {
            results.push({
                filename,
                content,
                fileType: classifyEdi(content)
            });
        } else {
            throw new Error('File is not valid EDI (must start with ISA segment)');
        }
    }

    return results;
}

/**
 * Classify EDI content by inspecting transaction type
 */
function classifyEdi(content) {
    // Look for ST*835 (ERA) or ST*277 (claim acknowledgment)
    if (content.includes('ST*835') || content.includes('ST*835*')) return 'era';
    if (content.includes('ST*277') || content.includes('ST*277*')) return '277ca';
    if (content.includes('ST*999') || content.includes('ST*997')) return 'ack_999';
    return 'unknown';
}

module.exports = { extractEdiContent, classifyEdi };
