# 運用

## 構成

| 環境 | Worker | ドメイン | D1・R2 | Queue |
|---|---|---|---|---|
| ローカル | `src-site-dev` | `http://localhost:8787` | `src-site-dev`（`--local`） | `src-site-dev-inspect` |
| 本番 | `src-site` | `src.koudenpa.net`（Workers のカスタムドメイン） | `src-site` | `src-site-inspect` |
| 確認 | `src-site` のバージョン URL | `staging-src-site.koudenpa.workers.dev`・`pr-<番号>-src-site.koudenpa.workers.dev` | 本番と同じ | 本番と同じ |

- 確認用の別の環境は持たない。配信前の版は本番の Worker のバージョン URL で確かめる（[Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)）
  - データ（D1・R2・Queue）は本番と同じ。確認で投稿したものは本番に残るので、確かめたら消す
  - D1 のマイグレーションは本番への配信のときだけ当てる。新しい列などを使う版は、マイグレーションを先に（後方互換に）出してから確かめる
  - Queue の検査・定期の片付けは、本番に出ている版のコードで動く

- 大きい zip の検査には Workers Paid が要る（Free は 1 要求の CPU が 10 ms）。Paid にしたら `wrangler.jsonc` の `limits.cpu_ms` のコメントを外す。Free のままでは `limits` を書くと配信が失敗する
- カスタムドメインは `wrangler deploy` が DNS とともに作る（`koudenpa.net` が同じアカウントの Cloudflare のゾーンであること）。[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## 初めの準備

1. Cloudflare の API トークンを作る。権限: Workers Scripts・Workers R2 Storage・D1・Queues の Edit、`koudenpa.net` の Workers Routes・DNS の Edit。[API トークン](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
2. `bash scripts/bootstrap.sh` を実行し、書き換わった `wrangler.jsonc`（D1 の `database_id`）をコミットする
3. Google Cloud で OAuth クライアント（ウェブ アプリケーション）を作る。承認済みのリダイレクト URI に `https://src.koudenpa.net/auth/callback` と `https://staging-src-site.koudenpa.workers.dev/auth/callback` を加える。スコープは `openid` だけ。[OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
4. R2 の API トークン（対象のバケットの **Object Read & Write**。読み取りだけではアップロードが 403 になる）を作る。署名付き URL のアップロードに使う。[R2 の API トークン](https://developers.cloudflare.com/r2/api/tokens/)
5. Worker の Secret を入れる（`npx wrangler secret put <名前> --env production`）
6. GitHub の Secrets・環境を設定する（下）
7. Actions の Packs と Deploy を実行する
8. 自分でログインしてから、運営にする（下）

## Secret

### Worker（`wrangler secret put --env production`）

値が `PLACEHOLDER` の Secret は、無いものとして扱う（設定前の仮の値）。

| 名前 | 内容 | 無いとき |
|---|---|---|
| `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` | Google の OAuth クライアント | ログインできない |
| `SESSION_SECRET` | セッションと OIDC の状態の署名（`openssl rand -base64 32`） | ログインできない |
| `R2_ACCOUNT_ID`・`R2_ACCESS_KEY_ID`・`R2_SECRET_ACCESS_KEY` | パートの署名付き URL（ブラウザから R2 へ直接 PUT）。トークンは対象のバケットの Object Read & Write | Worker を通してパートを PUT する |
| `TURNSTILE_SITE_KEY`・`TURNSTILE_SECRET` | 版の作成のボット対策 | 確かめない |

### GitHub Actions

| 名前 | 種類 | 内容 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID` | Secret（GitHub の環境 `production`） | 上の 1 のトークン |
| `MACKEREL_CLIENT_TOKEN` | Secret（任意） | SRC#Web のエラーの収集 |
| `SRC_REF` | 変数（任意） | 発行する 7474/SRC のブランチ・タグ（既定は `master`） |

本番の環境（`production`）には、GitHub の環境の保護（承認者）を付けるとよい。

## 配信

| ワークフロー | いつ | すること |
|---|---|---|
| `ci.yml` | push・PR | 型検査・単体テスト・パックの定義の確認 |
| `deploy.yml` | `main` への push → 本番。PR → バージョン URL `pr-<番号>`。手動 → 本番かバージョン URL `staging` | SRC#Web を AOT で発行（7474/SRC のコミットごとにキャッシュ）、`dist/` を組み立て、25 MiB を超えるものを R2 の `web/` へ。本番は D1 のマイグレーションと `wrangler deploy`、バージョン URL は `wrangler versions upload --preview-alias` |
| `packs.yml` | `packs/` の変更、手動 | パックを作り R2 の `packs/<id>/<版>.zip` に置き、D1 の `packs` を更新する（中身が同じなら何もしない） |

## 運営

### 運営にする

```sh
npx wrangler d1 execute DB --env production --remote \
  --command "UPDATE users SET role = 'admin' WHERE handle = '<自分のハンドル>'"
```

運営の画面は `/admin`。

### 通報

通報は Google フォームで受ける。サイトは通報を保存せず、フォームへのリンクを出すだけ（シナリオの頁の「このシナリオを通報する」と `/about/rights`）。

1. Google フォームを作る。項目の例
   - 対象のシナリオの URL（記述式。必須）
   - 理由（ラジオボタン: 権利の侵害・成人向けの内容・有害なファイル・その他。必須）
   - 詳細（段落。必須）
   - 連絡先（記述式。任意）
2. 「回答」タブの「新しい回答についてのメール通知を受け取る」をオンにする（[Google フォームのヘルプ](https://support.google.com/docs/answer/139706)）
3. 「事前入力した URL を取得」で、URL の項目に `{url}` と入れたリンクを作る（[事前入力](https://support.google.com/docs/answer/160000)）。`entry.<番号>={url}` の形になる。題も入れたいときは別の項目に `{title}`
4. そのリンクを `wrangler.jsonc` の環境ごとの `vars` の `REPORT_FORM_URL` に入れて配信する。サイトが `{url}`・`{title}` をシナリオの URL・題に置き換える（URL エンコードする）
   - `REPORT_FORM_URL` が無ければ、通報のリンクは出さない（`/about/rights` は「準備中」）

対応はシナリオの頁の「運営: 公開を止める」（運営にだけ出る）で行い、再開は `/admin` の「公開を止めているシナリオ」から行う。

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
