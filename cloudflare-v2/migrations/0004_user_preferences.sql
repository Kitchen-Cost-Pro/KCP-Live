-- Personal appearance and UI-scale preferences belong to the authenticated user,
-- not to an individual workspace membership. Workspace routes still enforce access
-- before reading or writing this global personal record.
CREATE TABLE IF NOT EXISTS user_preferences (
  principal_key TEXT PRIMARY KEY,
  auth_uid TEXT,
  email TEXT,
  preferences_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_auth_uid
  ON user_preferences(auth_uid);

CREATE INDEX IF NOT EXISTS idx_user_preferences_email
  ON user_preferences(email);
