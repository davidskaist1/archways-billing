-- ============================================
-- Migration 007: Auth Request Tracking
-- Track the full auth lifecycle: call → waiting → approved
-- Run this in Supabase SQL Editor after 006
-- ============================================

-- Allow auth_number to be nullable — when the request is first made, we don't
-- have the actual auth number yet
ALTER TABLE authorizations ALTER COLUMN auth_number DROP NOT NULL;

-- Add request tracking fields
ALTER TABLE authorizations
    ADD COLUMN IF NOT EXISTS request_date TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS request_reference_number TEXT,
    ADD COLUMN IF NOT EXISTS request_submission_method TEXT,
    -- 'availity', 'phone', 'fax', 'online_portal', 'other'
    ADD COLUMN IF NOT EXISTS request_representative TEXT,
    ADD COLUMN IF NOT EXISTS request_representative_id TEXT,
    ADD COLUMN IF NOT EXISTS request_follow_up_date DATE,
    ADD COLUMN IF NOT EXISTS request_notes TEXT,
    ADD COLUMN IF NOT EXISTS decision_date DATE,
    ADD COLUMN IF NOT EXISTS decision_notes TEXT,
    -- CRM push tracking (separate from the existing source field)
    ADD COLUMN IF NOT EXISTS crm_push_status TEXT DEFAULT 'not_sent',
    -- 'not_sent', 'pending', 'pushed', 'failed'
    ADD COLUMN IF NOT EXISTS pushed_to_crm_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS crm_push_error TEXT;

-- Index for pending requests (for the request queue)
CREATE INDEX IF NOT EXISTS idx_auth_request_status
    ON authorizations(status) WHERE status IN ('requested', 'in_review');

-- Index for follow-up queue
CREATE INDEX IF NOT EXISTS idx_auth_request_followup
    ON authorizations(request_follow_up_date)
    WHERE status IN ('requested', 'in_review') AND request_follow_up_date IS NOT NULL;
