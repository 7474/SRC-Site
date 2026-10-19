#!/usr/bin/env bash
# dist/ に配信する静的ファイルを組み立てる。
#   dist/static/  ポータルの CSS・JS（public/）
#   dist/play/    SRC#Web の発行物（$SRCWEB_DIR。無ければ仮の頁）
# 使い方: SRCWEB_DIR=out/web/wwwroot SRC_VERSION="master abc1234" scripts/assemble.sh
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist/static dist/play
cp -r public/. dist/static/

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
