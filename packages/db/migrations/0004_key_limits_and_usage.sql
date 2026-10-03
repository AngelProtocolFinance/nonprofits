-- Per-key limits and per-subject usage for the request guard. Never in the swapped table
-- set: an import must not touch them.

-- A row here whitelists its key with its own limits; no row means the default tier.
CREATE TABLE key_limits (
  key_id TEXT PRIMARY KEY REFERENCES apikey (id) ON DELETE CASCADE,
  daily INTEGER NOT NULL CHECK (daily > 0),
  per_minute INTEGER NOT NULL CHECK (per_minute > 0)
) STRICT, WITHOUT ROWID;

-- One row per subject per UTC day, written once per admitted request. A key's
-- subject is its apikey id; no foreign key, so a subject need not be a key.
-- WITHOUT ROWID so that write is one row: a rowid table would also write its
-- primary-key index.
CREATE TABLE key_usage (
  subject TEXT NOT NULL,
  day TEXT NOT NULL, -- UTC, YYYY-MM-DD
  requests INTEGER NOT NULL,
  minute INTEGER NOT NULL, -- epoch minute of the latest admitted request
  minute_requests INTEGER NOT NULL,
  PRIMARY KEY (subject, day)
) STRICT, WITHOUT ROWID;
