-- ============================================
-- Migration 012: Let investors save their own pro forma scenarios
-- ============================================

-- Allow investors to save new scenarios (but created_by tracks who made it)
CREATE POLICY "investor_insert_proforma" ON pro_forma_scenarios
    FOR INSERT
    WITH CHECK (get_user_role() = 'investor');

-- Allow investors to update only scenarios they created
CREATE POLICY "investor_update_own_proforma" ON pro_forma_scenarios
    FOR UPDATE
    USING (
        get_user_role() = 'investor'
        AND created_by IN (
            SELECT id FROM app_users WHERE auth_user_id = auth.uid()
        )
    );

-- Allow investors to delete only scenarios they created
-- (not the default scenario, not admin-created ones)
CREATE POLICY "investor_delete_own_proforma" ON pro_forma_scenarios
    FOR DELETE
    USING (
        get_user_role() = 'investor'
        AND created_by IN (
            SELECT id FROM app_users WHERE auth_user_id = auth.uid()
        )
        AND is_default = false
    );
