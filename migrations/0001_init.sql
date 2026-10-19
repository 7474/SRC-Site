-- SRC-Site の初期スキーマ（docs/architecture.md の「データ（D1）」）

CREATE TABLE users (
  id                INTEGER PRIMARY KEY,
  provider          TEXT NOT NULL,                  -- 'google'
  subject           TEXT NOT NULL,                  -- id_token の sub
  handle            TEXT NOT NULL UNIQUE,           -- 表示名（URL にも使う）
  role              TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  suspended         INTEGER NOT NULL DEFAULT 0,
  terms_accepted_at INTEGER,                        -- 投稿の規約に同意した日時（無ければ投稿できない）
  created_at        INTEGER NOT NULL,
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                      -- 32 バイトの乱数（16 進）
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE scenarios (
  id             INTEGER PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,              -- URL と SRC#Web の play に使う
  owner_id       INTEGER NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  author         TEXT,
  description    TEXT,
  license        TEXT,
  rating         TEXT NOT NULL DEFAULT 'general',   -- 'general' | 'r15' | 'r18'
  tags           TEXT NOT NULL DEFAULT '[]',        -- JSON の配列
  visibility     TEXT NOT NULL DEFAULT 'public',    -- 'public' | 'unlisted' | 'private'
  hidden         INTEGER NOT NULL DEFAULT 0,        -- 運営が止めた
  hidden_reason  TEXT,
  latest_version INTEGER,                           -- versions.id（公開した最新の版）
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX scenarios_owner ON scenarios(owner_id);
CREATE INDEX scenarios_updated ON scenarios(updated_at);

CREATE TABLE versions (
  id           INTEGER PRIMARY KEY,
  scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  state        TEXT NOT NULL,                       -- 'uploading' | 'inspecting' | 'published' | 'rejected' | 'withdrawn'
  r2_key       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,                       -- 投稿者が申告した値（検査で確かめる）
  root         TEXT,
  eve          TEXT,
  requires     TEXT NOT NULL DEFAULT '[]',
  excludes     TEXT NOT NULL DEFAULT '[]',
  manifest     TEXT,                                -- 検査で得た目次の要約（JSON）
  refs         TEXT,
  inspect_note TEXT,
  note         TEXT,                                -- 版の説明（更新内容）
  created_at   INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (scenario_id, number)
);
CREATE INDEX versions_state ON versions(state, created_at);

CREATE TABLE packs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  source_name TEXT NOT NULL,
  source_url  TEXT,
  license     TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  priority    INTEGER NOT NULL DEFAULT 0,
  root        TEXT,
  version     TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  size        INTEGER NOT NULL,
  withdrawn   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE takedowns (
  id           INTEGER PRIMARY KEY,
  target_type  TEXT NOT NULL,                       -- 'pack_file' | 'pack' | 'version' | 'scenario'
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  requested_by TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE reports (
  id          INTEGER PRIMARY KEY,
  scenario_id INTEGER REFERENCES scenarios(id) ON DELETE SET NULL,
  pack_id     TEXT REFERENCES packs(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,                        -- 'rights' | 'rating' | 'malware' | 'other'
  detail      TEXT,
  contact     TEXT,
  state       TEXT NOT NULL DEFAULT 'open',         -- 'open' | 'closed'
  created_at  INTEGER NOT NULL
);
CREATE INDEX reports_state ON reports(state, created_at);

CREATE TABLE counters (
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  plays       INTEGER NOT NULL DEFAULT 0,
  downloads   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scenario_id, day)
);
