-- ============================================
-- Migration 013: Track last login time properly
-- Adds a SECURITY DEFINER RPC so users can update their own
-- last_login_at without needing UPDATE RLS on app_users.
-- Also backfills existing users' last_login_at from Supabase's
-- internal auth.users.last_sign_in_at (source of truth).
-- ============================================

-- One-time backfill: sync last_login_at from auth.users where it's missing/stale
UPDATE app_users au
SET last_login_at = u.last_sign_in_at
FROM auth.users u
WHERE au.auth_user_id = u.id
  AND u.last_sign_in_at IS NOT NULL
  AND (au.last_login_at IS NULL OR au.last_login_at < u.last_sign_in_at);

-- Going-forward update function
CREATE OR REPLACE FUNCTION update_last_login()
RETURNS void AS $$
    UPDATE app_users
    SET last_login_at = now()
    WHERE auth_user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION update_last_login() TO authenticated;
