-- 1 when the return's mission field only points to Schedule O ("SEE SCHEDULE O"),
-- which the import does not extract; mission is then null.
ALTER TABLE filings ADD COLUMN mission_on_schedule_o INTEGER NOT NULL DEFAULT 0 CHECK (mission_on_schedule_o IN (0, 1));
