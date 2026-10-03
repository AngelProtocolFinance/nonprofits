-- Which data database (DATA_DB_A or DATA_DB_B) the Worker serves, and the build
-- that filled it; one row. 'empty' until the first build. A build claims the
-- slot it will reset (claimSlotSql) and flips to it (flipActiveSlotSql), each a
-- compare-and-set here; the Worker only reads this row.
CREATE TABLE data_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active TEXT NOT NULL CHECK (active IN ('a', 'b')),
  build_id TEXT NOT NULL,
  flipped_at TEXT NOT NULL,
  -- the build holding the inactive slot, until it flips, releases, or its lease
  -- runs out; all four null when no build holds it
  claim_slot TEXT CHECK (claim_slot IN ('a', 'b')),
  claim_build_id TEXT,
  claimed_at TEXT,
  claim_expires_at TEXT,
  CHECK (claim_slot IS NULL OR claim_slot != active),
  CHECK (
    (claim_slot IS NULL) = (claim_build_id IS NULL)
    AND (claim_slot IS NULL) = (claimed_at IS NULL)
    AND (claim_slot IS NULL) = (claim_expires_at IS NULL)
  )
) STRICT;

INSERT INTO data_generation (id, active, build_id, flipped_at)
  VALUES (1, 'a', 'empty', '1970-01-01T00:00:00Z');
