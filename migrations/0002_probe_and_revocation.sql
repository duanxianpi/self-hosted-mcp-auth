CREATE TABLE auth_probe_note (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
CREATE TABLE oauth_revocations (authorization_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
