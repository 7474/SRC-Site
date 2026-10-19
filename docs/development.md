# 開発

SRC-Site は Cloudflare Workers で動く、SRC#Web を組み込んだ SRC シナリオの投稿・配布サイトです。

## 文書

| 文書 | 内容 |
|---|---|
| [design.md](design.md) | 構成案（方向・課題・決めたこと） |
| [architecture.md](architecture.md) | 設計（URL の体系・データ・投稿と検査・カタログ・配信） |
| [assets.md](assets.md) | プレイのための要素（アセット）の整理 |
| [operations.md](operations.md) | 運用（準備・Secret・配信・通報・運営・ローカル開発） |

## 構成

- `src/` Worker（Hono）。`src/routes/`（頁・API・ファイル・運営）、`src/lib/`（OIDC・zip の検査・カタログ）
- `migrations/` D1 のマイグレーション
- `packs/` 共有パック（既定で一緒に読み込む素材）の定義。`scripts/packs.py` が作り、`scripts/publish-packs.sh` が配る
- `public/` ポータルの CSS・JS（`/static/`）
- `scripts/assemble.sh` 配信物（`dist/`）の組み立て。SRC#Web は `/play/`
- `scripts/smoke.mjs` 手元の `wrangler dev` での通しの確認。`scripts/check-site.mjs` 配信したサイトを外から確かめる

## 手元で動かす

```sh
npm ci
npm run db:migrate:local
printf 'DEV_LOGIN=1\n' > .dev.vars   # Google を通さずにログインする（/auth/dev）
bash scripts/assemble.sh             # SRC#Web は SRCWEB_DIR に発行物を渡す（無ければ仮の頁）
npx wrangler dev --local
npm run typecheck && npm test
```

詳しくは [operations.md の「ローカル開発」](operations.md#ローカル開発)。
