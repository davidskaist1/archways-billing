-- ============================================
-- Migration 005: Additional auth fields for CRM sync
-- Run this in Supabase SQL Editor after 004
-- ============================================

-- Add columns to match CRM payload shape
ALTER TABLE authorizations
    ADD COLUMN IF NOT EXISTS total_approved_hours NUMERIC(8,2),
    ADD COLUMN IF NOT EXISTS used_hours NUMERIC(8,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS service_type TEXT,
    ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
-- ^ source can be 'manual', 'archways-crm', 'cr-api', etc.

-- Drop the view first so we can recreate it with new columns
DROP VIEW IF EXISTS v_auth_utilization;
CREATE OR REPLACE VIEW v_auth_utilization AS
SELECT
    a.id AS auth_id,
    a.client_id,
    cl.first_name || ' ' || cl.last_name AS client_name,
    a.auth_number,
    a.start_date,
    a.end_date,
    a.approved_units,
    a.total_approved_hours,
    a.used_hours,
    COALESCE(a.used_hours,
        (SELECT COALESCE(SUM(c.units), 0) / 4 FROM claims c
         WHERE c.client_id = a.client_id
         AND c.service_date BETWEEN a.start_date AND a.end_date
         AND (a.cpt_codes IS NULL OR a.cpt_codes = '{}' OR c.cpt_code = ANY(a.cpt_codes)))
    ) AS computed_used_hours,
    CASE
        WHEN a.total_approved_hours > 0 THEN
            ROUND(COALESCE(a.used_hours, 0) / a.total_approved_hours * 100, 2)
        WHEN a.approved_units > 0 THEN
            ROUND(
                (SELECT COALESCE(SUM(c.units), 0) FROM claims c
                 WHERE c.client_id = a.client_id
                 AND c.service_date BETWEEN a.start_date AND a.end_date
                 AND (a.cpt_codes IS NULL OR a.cpt_codes = '{}' OR c.cpt_code = ANY(a.cpt_codes)))
                / a.approved_units::NUMERIC * 100,
                2
            )
        ELSE 0
    END AS utilization_pct,
    a.end_date - CURRENT_DATE AS days_until_expiry,
    a.status,
    a.service_type,
    a.source
FROM authorizations a
LEFT JOIN clients cl ON a.client_id = cl.id
WHERE a.status IN ('active', 'approved', 'expiring');

-- Index on service_type
CREATE INDEX IF NOT EXISTS idx_auth_service_type ON authorizations(service_type);
