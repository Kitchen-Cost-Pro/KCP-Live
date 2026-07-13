-- Phase 47: user-scoped visual preferences per workspace.
ALTER TABLE workspace_members ADD COLUMN user_preferences_json TEXT NOT NULL DEFAULT '{}';
