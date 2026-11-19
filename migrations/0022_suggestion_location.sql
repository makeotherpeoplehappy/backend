-- Where a suggested action works best (a Locations item slug); empty means anywhere.
ALTER TABLE suggestions ADD COLUMN location TEXT;
