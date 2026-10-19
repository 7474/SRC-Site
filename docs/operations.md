# 運用

## 構成

| 環境 | Worker | ドメイン | D1・R2 | Queue |
|---|---|---|---|---|
| ローカル | `src-site-dev` | `http://localhost:8787` | `src-site-dev`（`--local`） | `src-site-dev-inspect` |
| 確認 | `src-site-staging` | `src-site-staging.<サブドメイン>.workers.dev` | `src-site-staging` | `src-site-staging-inspect` |
| 本番 | `src-site` | `src.koudenpa.net`（Workers のカスタムドメイン） | `src-site` | `src-site-inspect` |

- Workers Paid が要る（zip の検査の CPU 時間 `limits.cpu_ms`）
- カスタムドメインは `wrangler deploy` が DNS とともに作る（`koudenpa.net` が同じアカウントの Cloudflare のゾーンであること）。[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## 初めの準備

1. Cloudflare の API トークンを作る。権限: Workers Scripts・Workers R2 Storage・D1・Queues の Edit、`koudenpa.net` の Workers Routes・DNS の Edit。[API トークン](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
2. 環境ごとに `scripts/bootstrap.sh` を実行し、書き換わった `wrangler.jsonc`（D1 の `database_id`）をコミットする
   ```sh
   ENV=staging ORIGIN=https://src-site-staging.<サブドメイン>.workers.dev bash scripts/bootstrap.sh
   ENV=production ORIGIN=https://src.koudenpa.net bash scripts/bootstrap.sh
   ```
3. Google Cloud で OAuth クライアント（ウェブ アプリケーション）を作る。承認済みのリダイレクト URI に各環境の `/auth/callback` を加える。スコープは `openid` だけ。[OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
4. R2 の API トークン（対象のバケットの Object Read & Write）を作る。署名付き URL のアップロードに使う。[R2 の API トークン](https://developers.cloudflare.com/r2/api/tokens/)
5. Worker の Secret を入れる（`npx wrangler secret put <名前> --env <環境>`）
6. GitHub の Secrets・環境を設定する（下）
7. Actions の Deploy（確認環境）と Packs を実行する
8. 自分でログインしてから、運営にする（下）

## Secret

### Worker（`wrangler secret put --env <環境>`）

| 名前 | 内容 | 無いとき |
|---|---|---|
| `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` | Google の OAuth クライアント | ログインできない |
| `SESSION_SECRET` | セッションと OIDC の状態の署名（`openssl rand -base64 32`） | ログインできない |
| `R2_ACCOUNT_ID`・`R2_ACCESS_KEY_ID`・`R2_SECRET_ACCESS_KEY` | 署名付き URL（ブラウザから R2 へ直接 PUT） | Worker を通して PUT する（100 MB まで） |
| `TURNSTILE_SITE_KEY`・`TURNSTILE_SECRET` | 版の作成・通報のボット対策 | 確かめない |

### GitHub Actions

| 名前 | 種類 | 内容 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID` | Secret（環境 `staging`・`production`） | 上の 1 のトークン |
| `MACKEREL_CLIENT_TOKEN` | Secret（任意） | SRC#Web のエラーの収集 |
| `SRC_REF` | 変数（任意） | 発行する 7474/SRC のブランチ・タグ（既定は `master`） |

本番の環境（`production`）には、GitHub の環境の保護（承認者）を付けるとよい。

## 配信

| ワークフロー | いつ | すること |
|---|---|---|
| `ci.yml` | push・PR | 型検査・単体テスト・パックの定義の確認 |
| `deploy.yml` | `main` への push → 確認環境。タグ `v*` → 本番。手動 | SRC#Web を AOT で発行（7474/SRC のコミットごとにキャッシュ）、`dist/` を組み立て、25 MiB を超えるものを R2 の `web/` へ、D1 のマイグレーション、`wrangler deploy` |
| `packs.yml` | `packs/` の変更 → 確認環境。手動 | パックを作り R2 の `packs/<id>/<版>.zip` に置き、D1 の `packs` を更新する（中身が同じなら何もしない） |

## 運営

### 運営にする

```sh
npx wrangler d1 execute DB --env production --remote \
  --command "UPDATE users SET role = 'admin' WHERE handle = '<自分のハンドル>'"
```

運営の画面は `/admin`。

### 取り下げ

| 対象 | 方法 |
|---|---|
| シナリオ | `/admin` で非公開にする（即時）。投稿者が直せば戻す |
| パックの 1 ファイル | `/admin` の「パックのファイルの取り下げ」に記録し、Actions の Packs を手動で実行する（そのファイルを除いた新しい版ができる） |
| パック全体 | `UPDATE packs SET withdrawn = 1 WHERE id = '<id>'` |

取り下げた記録は `/about/rights` とパックの頁に出る。

## ローカル開発

```sh
npm ci
npm run db:migrate:local
printf 'DEV_LOGIN=1\n' > .dev.vars   # Google を通さずにログインする（/auth/dev）
SRCWEB_DIR=<SRC#Web の wwwroot> bash scripts/assemble.sh   # 無ければ仮の頁
npx wrangler dev --local
node scripts/smoke.mjs <シナリオのフォルダ>                  # 投稿〜配布の通しの確認
```

パックを手元で作る:

```sh
SRC_DIR=<7474/SRC の checkout> python3 -I scripts/packs.py build [id ...]   # out/packs/
```
