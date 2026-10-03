-- Which data database (DATA_DB_A or DATA_DB_B) the Worker serves, and the build
-- that filled it; one row. Written only by a flip (flipActiveSlotSql), a
-- compare-and-set on `active`; the Worker only reads it. 'empty' until the first build.
CREATE TABLE data_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active TEXT NOT NULL CHECK (active IN ('a', 'b')),
  build_id TEXT NOT NULL,
  flipped_at TEXT NOT NULL
) STRICT;

INSERT INTO data_generation (id, active, build_id, flipped_at)
  VALUES (1, 'a', 'empty', '1970-01-01T00:00:00Z');
