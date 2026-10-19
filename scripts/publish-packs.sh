#!/usr/bin/env bash
# パックを作り、R2 に置き、D1 の packs を更新する（.github/workflows/packs.yml から呼ぶ）
#   SRC_DIR=<7474/SRC の checkout> scripts/publish-packs.sh [id ...]
# 要るもの: CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID、python3、jq、npx wrangler
# 取り下げたファイル（D1 の takedowns の pack_file）は zip から除く
set -euo pipefail
cd "$(dirname "$0")/.."
env=production
bucket=src-site
out=out/packs
mkdir -p "$out"

d1() { npx wrangler d1 execute DB --env "$env" --remote --json "$@"; }

d1 --command "SELECT target_id FROM takedowns WHERE target_type = 'pack_file'" \
  | jq -r '.[0].results[].target_id' > out/takedowns.txt
python3 -I scripts/packs.py build --out "$out" --exclude-file out/takedowns.txt "$@"

sql=out/packs.sql
: > "$sql"
for meta in "$out"/*.json; do
  id=$(jq -r .id "$meta")
  key=$(jq -r .r2_key "$meta")
  current=$(d1 --command "SELECT version FROM packs WHERE id = '$id'" | jq -r '.[0].results[0].version // empty')
  if [ "$current" = "$(jq -r .version "$meta")" ]; then
    echo "$id: 変わりなし"
    continue
  fi
  # 版ごとに別のキーに置く。古い版は消さない（docs/architecture.md の「R2」）
  npx wrangler r2 object put "$bucket/$key" --remote --file "$out/$id.zip" --content-type application/zip
  # SQL の文字列は jq の @sh ではなく '' の二重化で埋める
  jq -r --argjson now "$(date +%s)000" '
    def q: if . == null then "NULL" elif type == "number" then tostring else "'"'"'" + (tostring | gsub("'"'"'"; "'"'"''"'"'")) + "'"'"'" end;
    "INSERT INTO packs (id, title, description, source_name, source_url, license, is_default, priority, root, version, r2_key, size, withdrawn, updated_at) VALUES ("
    + ([.id, .title, .description, .source_name, .source_url, .license, .is_default, .priority, .root, .version, .r2_key, .size] | map(q) | join(", "))
    + ", 0, \($now)) ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, source_name = excluded.source_name, source_url = excluded.source_url, license = excluded.license, is_default = excluded.is_default, priority = excluded.priority, root = excluded.root, version = excluded.version, r2_key = excluded.r2_key, size = excluded.size, updated_at = excluded.updated_at;"
  ' "$meta" >> "$sql"
  echo "$id: $(jq -r .version "$meta") を置いた"
done
if [ -s "$sql" ]; then
  d1 --file "$sql" > /dev/null
  echo "D1 の packs を更新した"
fi
