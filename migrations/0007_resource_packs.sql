-- 投稿した素材を共有パックにまとめる（docs/resources.md）
-- 素材の投稿はシナリオと同じ表（scenarios・versions）に置き、種類（kind）と投稿先のパック（pack_id）で分ける
ALTER TABLE scenarios ADD COLUMN kind TEXT NOT NULL DEFAULT 'scenario';   -- 'scenario' | 'resource'
ALTER TABLE scenarios ADD COLUMN pack_id TEXT REFERENCES packs(id);       -- 素材の投稿先（kind = 'resource'）
CREATE INDEX scenarios_pack ON scenarios(pack_id);

-- パックの種類。site は運営が配布物から作る（packs/<id>.json）、community は投稿した素材を集めたもの（zip を持たない）
ALTER TABLE packs ADD COLUMN kind TEXT NOT NULL DEFAULT 'site';           -- 'site' | 'community'
ALTER TABLE packs ADD COLUMN policy TEXT;                                 -- community の管理ポリシー（src/lib/policy.ts）

-- 管理ポリシーごとの投稿素材のパック。既定にはせず、シナリオの投稿者が選ぶ。サイトのパックより後に重ねる（同じ名前なら投稿素材が勝つ）
INSERT INTO packs (id, title, description, source_name, source_url, license, is_default, priority, root, version, r2_key, size, withdrawn, updated_at, kind, policy) VALUES
  ('user-free', '投稿素材（自由）', '投稿者が条件を付けずに公開した素材（画像・効果音・BGM・データ）を集めたパック。', 'SRC#Site の投稿', NULL,
   '利用・改変・再配布（シナリオへの添付、ほかの素材サイトへの投稿を含む）は自由。作者の表記も要らない。', 0, 100, NULL, '', '', 0, 0, 0, 'community', 'free'),
  ('user-credit', '投稿素材（作者表記）', '使ったシナリオに作者を書けば自由に使える素材を集めたパック。', 'SRC#Site の投稿', NULL,
   '利用・改変・シナリオへの添付は自由。使ったシナリオの ReadMe などに作者名と素材の頁の URL を書く。作者から差し替え・削除の申し出があれば応じる。', 0, 110, NULL, '', '', 0, 0, 0, 'community', 'credit'),
  ('user-individual', '投稿素材（個別の条件）', '素材ごとに条件が違うものを集めたパック。使う前に各素材の条件を読んでください。', 'SRC#Site の投稿', NULL,
   '素材ごとの「ライセンス・配布の条件」に従う。SRC#Site でシナリオと一緒に読み込んで遊ぶことは、どの素材でも認められている。', 0, 120, NULL, '', '', 0, 0, 0, 'community', 'individual');
