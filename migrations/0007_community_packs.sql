-- 利用者が作る共有パックと、パックへの投稿（docs/resources.md）
-- パックの種類。site は運営が配布物から作る（packs/<id>.json）、community は投稿を承認して作る
ALTER TABLE packs ADD COLUMN kind TEXT NOT NULL DEFAULT 'site';            -- 'site' | 'community'
ALTER TABLE packs ADD COLUMN policy TEXT;                                  -- community の管理ポリシー（src/lib/policy.ts）
ALTER TABLE packs ADD COLUMN owner_id INTEGER REFERENCES users(id);        -- 作った人（運営が用意したパックは NULL）
ALTER TABLE packs ADD COLUMN accepts TEXT NOT NULL DEFAULT 'anyone';       -- 投稿を受け付ける相手: 'anyone' | 'managers'
ALTER TABLE packs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;          -- 中身（承認したファイル）が変わるたびに増やす
ALTER TABLE packs ADD COLUMN built_revision INTEGER NOT NULL DEFAULT 0;    -- zip（version・r2_key）に反映した revision

-- パックの管理者（承認・ファイルを外す・zip に反映する）。作った人は role = 'owner'。運営（users.role = 'admin'）はどのパックも管理できる
CREATE TABLE pack_managers (
  pack_id    TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'manager',                    -- 'owner' | 'manager'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pack_id, user_id)
);
CREATE INDEX pack_managers_user ON pack_managers(user_id);

-- パックへの投稿（zip 1 つ。R2 の pack-submissions/<id>.zip にそのまま置く）
CREATE TABLE pack_submissions (
  id           INTEGER PRIMARY KEY,
  pack_id      TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  author       TEXT,                                             -- 作者の表記（投稿者と違ってもよい）
  license      TEXT,                                             -- 出典・パックのポリシーに加える条件
  state        TEXT NOT NULL,                                    -- 'uploading' | 'inspecting' | 'pending' | 'approved' | 'rejected' | 'withdrawn'
  r2_key       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  etag         TEXT,
  upload_id    TEXT,
  root         TEXT,
  manifest     TEXT,                                             -- 検査で得た目次の要約（JSON）
  inspect_note TEXT,                                             -- 検査で弾いた理由
  review_note  TEXT,                                             -- 却下の理由
  reviewed_by  INTEGER REFERENCES users(id),
  reviewed_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX pack_submissions_pack ON pack_submissions(pack_id, state);
CREATE INDEX pack_submissions_user ON pack_submissions(user_id, created_at);

-- 投稿の中のファイル（検査で zip の目次から作る）。承認すると active になり、パックの zip に入る
CREATE TABLE pack_files (
  id              INTEGER PRIMARY KEY,
  pack_id         TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  submission_id   INTEGER NOT NULL REFERENCES pack_submissions(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,                                 -- パックの中の道（投稿の root を除き、区切りは /）
  size            INTEGER NOT NULL,
  compressed_size INTEGER NOT NULL,
  crc32           INTEGER NOT NULL,
  method          INTEGER NOT NULL,                              -- 0: 無圧縮、8: deflate
  offset          INTEGER NOT NULL,                              -- 投稿の zip の中のローカルヘッダの位置
  state           TEXT NOT NULL DEFAULT 'pending'                -- 'pending' | 'active' | 'replaced' | 'removed' | 'rejected'
);
CREATE INDEX pack_files_submission ON pack_files(submission_id);
CREATE INDEX pack_files_pack ON pack_files(pack_id, state, path);

-- パックの zip の組み直し（承認者のブラウザが組み、マルチパートアップロードで上げる）
CREATE TABLE pack_builds (
  id         INTEGER PRIMARY KEY,
  pack_id    TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  revision   INTEGER NOT NULL,                                   -- 組んだときの packs.revision（完了のときに変わっていれば断る）
  state      TEXT NOT NULL,                                      -- 'uploading' | 'published' | 'rejected'
  r2_key     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  upload_id  TEXT,
  note       TEXT,
  created_at INTEGER NOT NULL
);

-- 運営が管理する、管理ポリシーごとの投稿素材のパック（だれでも投稿でき、運営が承認する）
INSERT INTO packs (id, title, description, source_name, source_url, license, is_default, priority, root, version, r2_key, size, withdrawn, updated_at, kind, policy) VALUES
  ('user-free', '投稿素材（自由）', '投稿者が条件を付けずに公開した素材（画像・効果音・BGM・データ）を集めたパック。', 'SRC#Site の投稿', NULL,
   '利用・改変・再配布（シナリオへの添付、ほかの素材サイトへの投稿を含む）は自由。作者の表記も要らない。', 0, 100, NULL, '', '', 0, 0, 0, 'community', 'free'),
  ('user-credit', '投稿素材（作者表記）', '使ったシナリオに作者を書けば自由に使える素材を集めたパック。', 'SRC#Site の投稿', NULL,
   '利用・改変・シナリオへの添付は自由。使ったシナリオの ReadMe などに作者名とパックの頁の URL を書く。作者から差し替え・削除の申し出があれば応じる。', 0, 110, NULL, '', '', 0, 0, 0, 'community', 'credit'),
  ('user-individual', '投稿素材（個別の条件）', '投稿ごとに条件が違う素材を集めたパック。使う前に各投稿の条件を読んでください。', 'SRC#Site の投稿', NULL,
   '投稿ごとの「ライセンス・配布の条件」に従う。SRC#Site でシナリオと一緒に読み込んで遊ぶことは、どの投稿でも認められている。', 0, 120, NULL, '', '', 0, 0, 0, 'community', 'individual');
