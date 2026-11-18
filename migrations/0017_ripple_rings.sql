-- Your ripple: how many people each action makes happy (from its "How many"):
-- one person 1, a few people 3, a group 8, a whole community 25.
ALTER TABLE actions ADD COLUMN people_reached INTEGER NOT NULL DEFAULT 1;
