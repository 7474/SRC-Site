-- 通報から作った GitHub の Issue の URL
ALTER TABLE reports ADD COLUMN github_issue TEXT;
