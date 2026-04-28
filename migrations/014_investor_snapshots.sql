-- ============================================
-- Migration 014: Investor email snapshots
-- Logs every snapshot generated/sent + admin settings
-- ============================================

CREATE TABLE IF NOT EXISTS investor_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    period_type TEXT NOT NULL,  -- 'weekly' or 'monthly'
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    investor_id UUID REFERENCES investors(id) ON DELETE CASCADE,  -- null = sent to all
    investor_email TEXT,        -- denormalized for log/audit
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,    -- the rendered HTML for audit / re-send
    metrics JSONB NOT NULL,     -- the underlying numbers (auditable)
    sent_at TIMESTAMPTZ,        -- null = generated but not actually sent (preview only)
    sent_by UUID REFERENCES app_users(id),
    send_status TEXT NOT NULL DEFAULT 'preview',
    -- 'preview', 'sent', 'failed', 'scheduled'
    send_error TEXT,
    provider_message_id TEXT,   -- response id from Resend / mail provider
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snap_period ON investor_snapshots(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_snap_investor ON investor_snapshots(investor_id);
CREATE INDEX IF NOT EXISTS idx_snap_sent ON investor_snapshots(sent_at);

-- Settings: a single-row table for snapshot config
CREATE TABLE IF NOT EXISTS investor_snapshot_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    weekly_enabled BOOLEAN DEFAULT FALSE,
    weekly_day INTEGER DEFAULT 1,     -- 0=Sun, 1=Mon, ..., 6=Sat
    weekly_hour INTEGER DEFAULT 9,    -- 0-23 in UTC
    monthly_enabled BOOLEAN DEFAULT FALSE,
    monthly_day INTEGER DEFAULT 1,    -- day of month
    monthly_hour INTEGER DEFAULT 9,   -- 0-23 in UTC
    custom_intro TEXT,                -- optional message above the metrics
    custom_signoff TEXT,              -- optional signoff (defaults to founder name)
    sender_name TEXT DEFAULT 'Archways ABA',
    sender_email TEXT,                -- e.g., reports@finance.archwaysaba.com
    last_weekly_run TIMESTAMPTZ,
    last_monthly_run TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT only_one_row CHECK (id = 1)
);

INSERT INTO investor_snapshot_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- RLS
ALTER TABLE investor_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_snapshot_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_full_snapshots" ON investor_snapshots FOR ALL USING (get_user_role() = 'admin');
CREATE POLICY "admin_full_snap_settings" ON investor_snapshot_settings FOR ALL USING (get_user_role() = 'admin');

-- Investors can see their own snapshot history
CREATE POLICY "investor_read_own_snapshots" ON investor_snapshots FOR SELECT USING (
    get_user_role() = 'investor'
    AND investor_id IN (
        SELECT id FROM investors WHERE app_user_id IN (
            SELECT id FROM app_users WHERE auth_user_id = auth.uid()
        )
    )
);

CREATE TRIGGER tr_snap_settings_updated_at BEFORE UPDATE ON investor_snapshot_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
