// Data Source Abstraction Layer
// Currently: spreadsheet imports only
// Future: swap in Central Reach API with minimal changes

import { SpreadsheetParser } from './import.js';

const DataSource = {
    mode: 'spreadsheet', // 'spreadsheet' or 'cr_api'

    async getClaims(fileOrParams) {
        if (this.mode === 'spreadsheet') {
            return SpreadsheetParser.parseClaims(fileOrParams);
        }
        // Future: return CentralReachAPI.fetchClaims(fileOrParams);
        throw new Error('CR API not yet configured. Set DataSource.mode to "spreadsheet".');
    },

    async getPayments(fileOrParams) {
        if (this.mode === 'spreadsheet') {
            return SpreadsheetParser.parsePayments(fileOrParams);
        }
        throw new Error('CR API not yet configured.');
    },

    async getSessions(fileOrParams) {
        if (this.mode === 'spreadsheet') {
            return SpreadsheetParser.parseSessions(fileOrParams);
        }
        throw new Error('CR API not yet configured.');
    }
};

export { DataSource };
