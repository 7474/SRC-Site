CREATE TABLE pack_submissions (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL,
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  description TEXT,
  source_name TEXT NOT NULL,
  source_url  TEXT,
  license     TEXT NOT NULL,
  root        TEXT,
  excludes_jasrac INTEGER NOT NULL DEFAULT 0,
  size        INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  upload_id   TEXT,
  status      TEXT NOT NULL DEFAULT 'uploading', -- 'uploading' | 'pending' | 'approved' | 'rejected'
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX pack_submissions_owner ON pack_submissions(owner_id, created_at);
CREATE INDEX pack_submissions_review ON pack_submissions(status, created_at);
CREATE UNIQUE INDEX pack_submissions_active_slug ON pack_submissions(slug)
  WHERE status IN ('uploading', 'pending', 'approved');
