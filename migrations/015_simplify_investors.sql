-- ============================================
-- Migration 015: Simplify investor model
-- - Drop per-investor tracking (no individual records, just a group "Azria")
-- - Capital contributions become flat (no investor_id required)
-- - Snapshot recipients = simple email list in settings
-- ============================================

-- Allow contributions and distributions without per-investor link
ALTER TABLE investor_contributions ALTER COLUMN investor_id DROP NOT NULL;
ALTER TABLE investor_distributions ALTER COLUMN investor_id DROP NOT NULL;

-- Add a recipients list to snapshot settings (comma-separated emails)
ALTER TABLE investor_snapshot_settings
    ADD COLUMN IF NOT EXISTS recipient_emails TEXT;
