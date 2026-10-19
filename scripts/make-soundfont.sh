#!/usr/bin/env bash
# MIDI 用の SoundFont（TimGM6mb、GPL-2.0）を素材の zip にする。R2 の soundfont.zip に置く（README の「SoundFont」）
#   bash scripts/make-soundfont.sh <出力 zip>
# Debian のパッケージ timgm6mb-soundfont から取り出し、著作権表示とライセンス文を同梱する
# https://packages.debian.org/source/sid/timgm6mb-soundfont
set -euo pipefail
out=$(realpath -m "${1:?出力する zip のパスを指定する}")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/timgm6mb.deb" "https://deb.debian.org/debian/pool/main/t/timgm6mb-soundfont/timgm6mb-soundfont_1.3-5_all.deb"
dpkg-deb -x "$work/timgm6mb.deb" "$work/x"
mkdir -p "$work/zip/SoundFont"
cp "$work/x/usr/share/sounds/sf2/TimGM6mb.sf2" "$work/zip/SoundFont/"
cp "$work/x/usr/share/doc/timgm6mb-soundfont/copyright" "$work/zip/SoundFont/TimGM6mb-copyright.txt"
curl -fsSL -o "$work/zip/SoundFont/GPL-2.0.txt" "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/GPL-2.0-only.txt"
rm -f "$out"
(cd "$work/zip" && zip -qr "$out" SoundFont)
echo "$out"
