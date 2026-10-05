-- The Turso data database the api serves, and the build in it; one row. Both
-- name and url are null, and build_id 'empty', until the first build switches
-- to one: the api connects by url, the import deletes the one it replaced by
-- name. An import switches it as a compare-and-set on the name it expects
-- served (switchServedDatabase); the freshness guard writes only the
-- last_dispatch columns.
CREATE TABLE served_database (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  database_name TEXT,
  database_url TEXT,
  build_id TEXT NOT NULL,
  switched_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', switched_at) IS switched_at),
  -- the guard's last start of the import workflow on stale data, written before
  -- its calls so a failing one waits out the redispatch interval too; the status
  -- is GitHub's HTTP answer to the dispatch, or to the enable call before it when
  -- that failed, and null while no answer was recorded
  last_dispatch_at TEXT CHECK (last_dispatch_at IS NULL OR julianday(last_dispatch_at) IS NOT NULL),
  last_dispatch_status INTEGER CHECK (last_dispatch_status IS NULL OR last_dispatch_status BETWEEN 100 AND 599),
  CHECK ((database_name IS NULL) = (database_url IS NULL)),
  CHECK ((database_name IS NULL) = (build_id = 'empty')),
  CHECK (last_dispatch_status IS NULL OR last_dispatch_at IS NOT NULL)
) STRICT;

INSERT INTO served_database (id, build_id, switched_at)
  VALUES (1, 'empty', '1970-01-01T00:00:00Z');
