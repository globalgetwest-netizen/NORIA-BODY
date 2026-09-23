CREATE TABLE IF NOT EXISTS kb_docs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, collection TEXT NOT NULL, title TEXT NOT NULL, source TEXT, chars INTEGER NOT NULL, chunks INTEGER NOT NULL, embedded INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS kb_docs_user ON kb_docs (user_id, collection);
CREATE TABLE IF NOT EXISTS kb_chunks (doc_id TEXT NOT NULL, idx INTEGER NOT NULL, user_id TEXT NOT NULL, collection TEXT NOT NULL, text TEXT NOT NULL, meta TEXT, vec TEXT, embedder TEXT, PRIMARY KEY (doc_id, idx));
CREATE INDEX IF NOT EXISTS kb_chunks_user ON kb_chunks (user_id, collection);
CREATE TABLE IF NOT EXISTS kb_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, chunks INTEGER NOT NULL DEFAULT 0, queries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
