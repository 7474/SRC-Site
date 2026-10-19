# SRC-Site

SRC#Web を組み込んだ SRC シナリオの投稿・配布ポータル（Cloudflare）。

- [構成案](docs/design.md)
- [設計](docs/architecture.md)
- [プレイのための要素（アセット）の整理](docs/assets.md)
- [運用](docs/operations.md)（準備・Secret・配信・運営）

## 構成

- `src/` Worker（Hono）。`src/routes/`（頁・API・ファイル・運営）、`src/lib/`（OIDC・zip の検査・カタログ）
- `migrations/` D1
- `packs/` パック（既定で重ねる素材）の定義。`scripts/packs.py` が作り、`scripts/publish-packs.sh` が配る
- `public/` ポータルの CSS・JS（`/static/`）
- `scripts/assemble.sh` 配信物（`dist/`）の組み立て。SRC#Web は `/play/`
