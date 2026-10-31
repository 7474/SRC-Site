# 開発

SRC-Site は Cloudflare Workers で動く、SRC#Web を組み込んだ SRC シナリオの投稿・配布サイトです。

## 文書

| 文書 | 内容 |
|---|---|
| [design.md](design.md) | 構成案（方向・課題・決めたこと） |
| [architecture.md](architecture.md) | 設計（URL の体系・データ・投稿と検査・カタログ・配信） |
| [assets.md](assets.md) | プレイのための要素（アセット）の整理 |
| [resources.md](resources.md) | 素材の投稿と閲覧（利用者が作るパック・投稿の承認・承認者のブラウザでの zip の組み直し・データビューア） |
| [operations.md](operations.md) | 運用（準備・Secret・配信・通報・運営・ローカル開発） |

## 構成

- `src/` Worker（Hono）。`src/routes/`（頁・API・ファイル・運営）、`src/lib/`（OIDC・zip の検査・カタログ）
- `migrations/` D1 のマイグレーション
- `packs/` 共有パック（既定で一緒に読み込む素材）の定義。`scripts/packs.py` が作り、`scripts/publish-packs.sh` が配る
- `public/` ポータルの CSS・JS（`/static/`）
- `scripts/assemble.sh` 配信物（`dist/`）の組み立て。SRC#Web は `/play/`
- `sandbox/` 動作確認用のシナリオと共有パック（生成AIで作ったテスト用。`scripts/make-sandbox.py` で zip にし、`scripts/register-sandbox.mjs` で手元に入れる。[sandbox/README.md](../sandbox/README.md)）
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

## テスト

`npm test` で次の 2 つ（`vitest.config.ts` の projects）を流します。CI（`.github/workflows/ci.yml`）でも流します。

| プロジェクト | 置き場 | 内容 |
|---|---|---|
| node | `test/*.test.ts` | ライブラリ（zip・カタログ・検査など）を Node で確かめる |
| workers | `test/workers/*.test.ts` | Worker を Workers の実行環境（[@cloudflare/vitest-plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/)。Miniflare）で動かし、D1・R2 を使って経路を確かめる（ログイン・権限・投稿・承認・投稿の量の上限・版の共有パック） |

- workers は `wrangler.jsonc` の既定（`--env` なし）の設定で動きます。D1 には `migrations/` を当ててから流します（`test/workers/setup.ts`）。回数の制限は緩めています
- ログインは Google を通さず、アプリと同じように `sessions` に行を入れて `sid` の Cookie を渡します（`test/workers/helpers.ts`）
- Turnstile・R2 の S3 互換 API の鍵は設定しないので、確認は通り、zip は Worker を通して上げる形になります
- workers のテストの型は `test/workers/tsconfig.json` で検査します（`npm run typecheck`）
