#!/usr/bin/env bash
# dist/ に配信する静的ファイルを組み立てる。
#   dist/static/  ポータルの CSS・JS（public/）
#   dist/play/    SRC#Web の発行物（$SRCWEB_DIR。無ければ仮の頁）
#   dist/lint/    ブラウザで動く lint の発行物（$SRCLINT_DIR。7474/SRC の SRCLintWeb。無ければ置かず、投稿の画面は lint を飛ばす）
# 使い方: SRCWEB_DIR=out/web/wwwroot SRCLINT_DIR=out/lint/wwwroot SRC_VERSION="master abc1234" scripts/assemble.sh
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist/static dist/play
cp -r public/. dist/static/
# アップロードの前の検査（Worker の検査と同じ src/lib/zip.ts をブラウザ向けに束ねる）
npx esbuild src/client/precheck.ts --bundle --format=esm --target=es2022 --minify --outfile=dist/static/precheck.js --log-level=warning

if [ -n "${SRCWEB_DIR:-}" ]; then
  cp -r "$SRCWEB_DIR"/. dist/play/
  # /play/ の下に置く（https://github.com/7474/SRC/blob/master/docs/gui/web-hosting.md の「置き方」）
  sed -i 's#<base href="/" />#<base href="/play/" />#' dist/play/index.html
  grep -q '<base href="/play/" />' dist/play/index.html
  # ポータルの外の zip は読ませない（カタログは /api/catalog.json だけ）
  cat > dist/play/srcweb.json <<JSON
{
  "title": "${SITE_TITLE:-SRC-Site}",
  "catalogs": ["/api/catalog.json"],
  "playCatalog": "/api/catalog/{id}.json",
  "allowUserArchives": true,
  "allowUserCatalogs": false
}
JSON
  # SRC#Web のエラーの収集（Mackerel のトレース）。MACKEREL_CLIENT_TOKEN があるときだけ
  if [ -n "${MACKEREL_CLIENT_TOKEN:-}" ]; then
    jq --arg token "$MACKEREL_CLIENT_TOKEN" '.errorReporting.mackerel = {clientToken: $token, serviceName: "src-site-web"}' dist/play/srcweb.json > dist/play/srcweb.json.tmp
    mv dist/play/srcweb.json.tmp dist/play/srcweb.json
  fi
else
  cat > dist/play/index.html <<'HTML'
<!doctype html><meta charset="utf-8"><title>SRC#Web</title>
<p>SRC#Web はまだ組み込まれていません（scripts/assemble.sh に SRCWEB_DIR を渡してください）。</p>
HTML
fi
echo "${SRC_VERSION:-local}" > dist/play/version.txt

if [ -n "${SRCLINT_DIR:-}" ]; then
  mkdir -p dist/lint
  # 事前に圧縮したもの（.br・.gz）は置かない（Workers の静的アセットが圧縮して返す）
  (cd "$SRCLINT_DIR" && find . -type f ! -name '*.br' ! -name '*.gz') | while read -r f; do
    mkdir -p "dist/lint/$(dirname "$f")"
    cp "$SRCLINT_DIR/$f" "dist/lint/$f"
  done
fi
