-- ============================================
-- Migration 003: Separate App Users from Clinical Staff
-- Run this in Supabase SQL Editor
-- ============================================

-- App Users table: people who log into the billing software
-- Completely separate from the staff table (which tracks clinical employees for payroll)
CREATE TABLE IF NOT EXISTS app_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auth_user_id UUID UNIQUE REFERENCES auth.users(id),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role user_role NOT NULL DEFAULT 'billing',  -- admin, billing, payroll
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_users_auth ON app_users(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_app_users_active ON app_users(is_active);

-- Migrate your existing admin user from staff to app_users
-- (keeps staff table clean for clinical employees only)
INSERT INTO app_users (auth_user_id, first_name, last_name, email, role, is_active)
SELECT auth_user_id, first_name, last_name, email, role, is_active
FROM staff
WHERE auth_user_id IS NOT NULL
ON CONFLICT (email) DO NOTHING;

-- Update the get_user_role function to check app_users instead of staff
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS user_role AS $$
    SELECT role FROM app_users WHERE auth_user_id = auth.uid() AND is_active = true
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- RLS for app_users
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;

-- Admins can manage all app users
CREATE POLICY "admin_full_app_users" ON app_users
    FOR ALL USING (get_user_role() = 'admin');

-- Users can read their own record (needed for login)
CREATE POLICY "self_read_app_users" ON app_users
    FOR SELECT USING (auth_user_id = auth.uid());

-- Remove auth_user_id requirement from staff table
-- Staff pushed from CRM won't have login accounts
-- (auth_user_id column stays but is no longer used for login checks)

-- Update the staff self-read policy to not require auth
-- Clinical staff records should be readable by any logged-in user
DROP POLICY IF EXISTS "staff_self_read" ON staff;
CREATE POLICY "authenticated_read_staff" ON staff
    FOR SELECT USING (auth.role() = 'authenticated');

-- Updated at trigger for app_users
CREATE TRIGGER tr_app_users_updated_at BEFORE UPDATE ON app_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
