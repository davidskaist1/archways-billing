-- ============================================
-- Migration 009a: Add investor role to the user_role enum
-- RUN THIS ALONE FIRST, then run 009b separately.
-- Cannot run inside a transaction with other statements.
-- ============================================

ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'investor';
