-- Your own action: something kind a member did that isn't on the site yet.
-- It is saved as a suggestion (kind 'own', with who it was for) and as a done
-- mark with source 'own' that points at the suggestion. It counts for the
-- member at once; public numbers and the feed leave it out until the
-- suggestion is approved and published as an action, when the mark moves to it.
ALTER TABLE suggestions ADD COLUMN kind TEXT NOT NULL DEFAULT 'idea';
ALTER TABLE suggestions ADD COLUMN who TEXT;
ALTER TABLE done_marks ADD COLUMN suggestion_id INTEGER;
CREATE INDEX done_marks_suggestion ON done_marks(suggestion_id);
