// Shared helpers for investor portal pages
// Excel export, formatting, data fetching via security-definer RPCs

import { supabase } from './supabase-client.js';

// ---- Business metrics ----

async function getBusinessSnapshot() {
    const { data, error } = await supabase.rpc('get_business_snapshot');
    if (error) return null;
    return Array.isArray(data) ? data[0] : data;
}

async function getMonthlyFinancials() {
    const { data, error } = await supabase.rpc('get_monthly_financials');
    if (error) return [];
    return data || [];
}

async function getARLagMonthly() {
    const { data, error } = await supabase.rpc('get_ar_lag_monthly');
    if (error) return [];
    return data || [];
}

async function getInvestorSummaryAll() {
    const { data, error } = await supabase.rpc('get_investor_summary_all');
    if (error) return [];
    return data || [];
}

// ---- P&L calculator ----

function calculatePL(monthly) {
    return monthly.map(m => {
        const revenue = parseFloat(m.revenue) || 0;
        const payroll = parseFloat(m.payroll) || 0;
        const opex = parseFloat(m.opex) || 0;
        const totalCosts = payroll + opex;
        const netProfit = revenue - totalCosts;
        const margin = revenue > 0 ? (netProfit / revenue * 100) : 0;
        return {
            ...m,
            revenue,
            payroll,
            opex,
            total_costs: totalCosts,
            net_profit: netProfit,
            margin_pct: margin
        };
    });
}

// ---- Excel export ----

function exportToExcel(filename, sheets) {
    // sheets is an array of { name, data } where data is array of objects
    const wb = XLSX.utils.book_new();
    for (const sheet of sheets) {
        const ws = XLSX.utils.json_to_sheet(sheet.data);
        XLSX.utils.book_append_sheet(wb, ws, sheet.name.substring(0, 31)); // max 31 chars
    }
    XLSX.writeFile(wb, filename);
}

// ---- Formatters ----

function fmtMoney(v) {
    const n = parseFloat(v) || 0;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPercent(v, decimals = 1) {
    const n = parseFloat(v) || 0;
    return n.toFixed(decimals) + '%';
}

function fmtMonth(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function fmtInt(v) {
    const n = parseInt(v) || 0;
    return n.toLocaleString('en-US');
}

export {
    getBusinessSnapshot,
    getMonthlyFinancials,
    getARLagMonthly,
    getInvestorSummaryAll,
    calculatePL,
    exportToExcel,
    fmtMoney,
    fmtPercent,
    fmtMonth,
    fmtInt
};
