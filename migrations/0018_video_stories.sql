-- Short video stories: an uploaded vertical video (15–30 seconds) with a poster
-- image, and whether the person said children are in it (checked with extra care).
ALTER TABLE stories ADD COLUMN video_key TEXT;
ALTER TABLE stories ADD COLUMN poster_key TEXT;
ALTER TABLE stories ADD COLUMN video_codec TEXT;
ALTER TABLE stories ADD COLUMN has_children INTEGER;
