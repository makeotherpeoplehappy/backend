-- How many people one "I did this" made happy, as the member told us (1, 2 for "2-5", 6 for "more").
-- Empty means they didn't say: it counts as 1. Replaces the action's "how many" estimate in all counts.
ALTER TABLE done_marks ADD COLUMN people INTEGER;
