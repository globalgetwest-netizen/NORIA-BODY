-- Noria accounts — Cloudflare D1 schema (safe to run more than once).
-- Apply with:  npx wrangler d1 execute noria-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  pw_hash     TEXT NOT NULL,           -- pbkdf2-sha512$iterations$salt$hash  (never the password)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL DEFAULT '',
  tz            TEXT NOT NULL DEFAULT '',
  lang          TEXT NOT NULL DEFAULT '',
  prefs         TEXT NOT NULL DEFAULT '{}',   -- small JSON: voice on/off, theme, and so on (8 KB at most)
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,        -- SHA-256 of the session token; the token itself is never stored
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  agent       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS convos (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  payload     TEXT NOT NULL,           -- opaque to the server; the app encrypts it on the device
  updated_at  INTEGER NOT NULL,
  encrypted   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_convos_user_time ON convos(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  k             TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);
