CREATE TABLE connected_apps (authorization_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL, auth_epoch INTEGER NOT NULL, created_at INTEGER NOT NULL);
