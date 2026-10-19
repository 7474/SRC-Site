#!/usr/bin/env bash
# Cloudflare に環境（D1・R2・Queues）を作り、D1 の ID を wrangler.jsonc に入れる。初めの 1 回だけ（docs/operations.md）
#   scripts/bootstrap.sh
# 要るもの: npx wrangler login 済みか CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID、jq
# 作り済みのものはそのまま使う
set -euo pipefail
cd "$(dirname "$0")/.."
env=production
name=src-site
origin=https://src.koudenpa.net

w() { npx wrangler "$@"; }

# D1
id=$(w d1 list --json | jq -r --arg n "$name" '.[] | select(.name == $n) | .uuid')
if [ -z "$id" ]; then
  w d1 create "$name" > /dev/null
  id=$(w d1 list --json | jq -r --arg n "$name" '.[] | select(.name == $n) | .uuid')
fi
echo "D1 $name: $id"
sed -i -E "s#(\"database_name\": \"$name\", \"database_id\": \")[0-9a-f-]+\"#\1$id\"#" wrangler.jsonc
grep -q "\"database_name\": \"$name\", \"database_id\": \"$id\"" wrangler.jsonc

# R2（署名付き URL でブラウザから PUT するため CORS を設定する）
# https://developers.cloudflare.com/r2/buckets/cors/
w r2 bucket create "$name" 2>/dev/null || echo "R2 $name: 作り済み"
cors=$(mktemp)
trap 'rm -f "$cors"' EXIT
# 本番と、確認に使うバージョン URL（別名 staging。docs/operations.md の「配信」）
jq -n --arg origin "$origin" --arg preview "https://staging-$name.koudenpa.workers.dev" '{rules: [{allowed: {origins: [$origin, $preview], methods: ["PUT"], headers: ["content-type"]}, exposeHeaders: ["ETag"], maxAgeSeconds: 3600}]}' > "$cors"
w r2 bucket cors set "$name" --file "$cors" --force

# Queues（zip の検査）
w queues create "$name-inspect" 2>/dev/null || echo "Queue $name-inspect: 作り済み"

w d1 migrations apply DB --env "$env" --remote

cat <<EOF

できたこと: D1・R2（CORS）・Queue。wrangler.jsonc の database_id を書き換えたのでコミットする。
次にすること（docs/operations.md）:
  1. R2 の API トークン（$name への Object Read & Write）を作る
  2. Secret を入れる: npx wrangler secret put <名前> --env $env
     GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET SESSION_SECRET R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
     （任意）TURNSTILE_SITE_KEY TURNSTILE_SECRET
  3. Google の OAuth クライアントのリダイレクト URI に $origin/auth/callback と https://staging-$name.koudenpa.workers.dev/auth/callback を加える
EOF
