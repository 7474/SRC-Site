#!/usr/bin/env bash
# サンドボックス（sandbox/README.md）を srcsharp play で画面なしに通す。本編と、動作確認（sandbox/checks/）の 1 つずつ。
#   SRCSHARP="srcsharp"（または "dotnet path/to/srcsharp.dll"） BASIC_DATA=<7474/SRC の SRC.Sharp/Content/basic-data> scripts/check-sandbox.sh [確認のファイル名…]
# 動作確認の手順は sandbox/checks/<名前>.play（無ければ、始まってインターミッションに戻るまで）。
# 各確認は「本編の戦闘 → インターミッションの『動作確認』で選ぶ（すぐ始まる）→ 確認 → インターミッション → もう一度同じ確認 →『次のステージへ』→ 終わり」の順に通す
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BASIC_DATA:?7474/SRC の SRC.Sharp/Content/basic-data を指定する}"
read -r -a srcsharp <<< "${SRCSHARP:-srcsharp}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
python3 -I scripts/make-sandbox.py "$work/zip" > /dev/null
mkdir -p "$work/app" "$work/sc"
cp -r "$BASIC_DATA"/. "$work/app/"
(cd "$work/app" && unzip -qo "$work/zip/sandbox-pack.zip")
(cd "$work/sc" && unzip -qo "$work/zip/sandbox-scenario.zip")
eve="$work/sc/サンドボックス/サンドボックス.eve"

play() {
  local name=$1 script=$2
  if "${srcsharp[@]}" play "$eve" --script "$script" --app-path "$work/app" --skip-wait --out "$work/out/$name" > "$work/$name.log" 2>&1; then
    echo "✓ $name"
  else
    echo "✗ $name"
    grep -v PHASE "$work/$name.log" | tail -20
    return 1
  fi
}

failed=0
cat > "$work/main.play" <<'PLAY'
chooseseq コマンド サンドボックスについて|次のステージへ
auto 60
turns 10
expect message 動作確認は以上です
expect finished
expect error none
PLAY
[ $# -gt 0 ] || play 本編 "$work/main.play" || failed=1

for check in ${@:-$(cd sandbox/checks && ls *.eve)}; do
  name=${check%.eve}
  title=$(sed -n 's/^# 題: //p' "sandbox/checks/$check")
  {
    # 同じ確認を 2 回続けて選ぶ（前の回に作ったユニット・パイロットが残っていても始められること）
    echo "choose1 確かめるもの $title"
    echo "choose1 確かめるもの $title"
    echo "chooseseq コマンド 動作確認|動作確認|次のステージへ"
    for _ in 1 2; do
      echo "auto 60"
      echo "turns 3"
      [ -f "sandbox/checks/$name.play" ] && cat "sandbox/checks/$name.play"
    done
    echo "auto 60"
    echo "turns 3"
    echo "expect message 動作確認は以上です"
    echo "expect finished"
    echo "expect error none"
  } > "$work/$name.play"
  play "$name" "$work/$name.play" || failed=1
done
exit $failed
