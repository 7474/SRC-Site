#!/usr/bin/env python3
"""サンドボックス（動作確認用のシナリオと共有パック）の zip を作る（sandbox/README.md）。

    python3 -I scripts/make-sandbox.py [出力のフォルダ（既定 out/sandbox）]

- 出力: sandbox-scenario.zip（シナリオ「サンドボックス」）と sandbox-pack.zip（共有パック「サンドボックス素材」）
- 文章・データは sandbox/ にある。マップ・画像・MIDI・WAV はここで作る（生成AIで作ったテスト用のもの。単純な図形と音の並び）
- 動作確認（sandbox/checks/）は、各ファイルの見出しから、インターミッションのメニュー（Lib/動作確認.eve）と一覧（確認一覧.md）を作る
- 同じ入力からは同じ zip ができる（日時を固定する）
"""
import io
import math
import re
import struct
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SANDBOX = ROOT / "sandbox"
DATE = (2026, 1, 1, 0, 0, 0)


# ── 画像（24 ビットの BMP） ──

def bmp(width, height, pixel):
    """pixel(x, y) -> (r, g, b)。上の行から"""
    row = (width * 3 + 3) & ~3
    data = bytearray()
    for y in range(height - 1, -1, -1):
        line = bytearray()
        for x in range(width):
            r, g, b = pixel(x, y)
            line += bytes((b, g, r))
        data += line + b"\0" * (row - len(line))
    header = struct.pack("<2sIHHI", b"BM", 54 + len(data), 0, 0, 54)
    info = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(data), 2835, 2835, 0, 0)
    return header + info + bytes(data)


# 3×5 の文字（絵に「TEST」と入れ、テスト用と分かるようにする）
FONT = {
    "T": ["###", ".#.", ".#.", ".#.", ".#."],
    "E": ["###", "#..", "##.", "#..", "###"],
    "S": [".##", "#..", ".#.", "..#", "##."],
}


def text_pixels(text, left, top, scale=1):
    pixels = set()
    for i, ch in enumerate(text):
        for y, line in enumerate(FONT[ch]):
            for x, c in enumerate(line):
                if c == "#":
                    for dy in range(scale):
                        for dx in range(scale):
                            pixels.add((left + (i * 4 + x) * scale + dx, top + y * scale + dy))
    return pixels


def face(skin, hair, eyes, back):
    """パイロットの顔（64×64）。丸い顔・髪・目と、下に「TEST」"""
    label = text_pixels("TEST", 9, 55, 1)

    def pixel(x, y):
        if (x, y) in label:
            return (255, 255, 255)
        if y >= 53:
            return (40, 40, 40)
        dx, dy = x - 32, y - 30
        d = math.hypot(dx, dy * 1.1)
        if d < 20:
            if y < 22 or (y < 30 and abs(dx) > 15):
                return hair
            if 26 <= y <= 31 and (8 <= abs(dx) <= 12):
                return eyes
            if y == 40 and abs(dx) <= 5:
                return (150, 60, 60)
            return skin
        if d < 23 and y < 34:
            return hair
        return back

    return bmp(64, 64, pixel)


def unit(color):
    """ユニットの絵（32×32）。白い地にひし形"""
    def pixel(x, y):
        if abs(x - 15.5) + abs(y - 15.5) < 13:
            if abs(x - 15.5) + abs(y - 15.5) > 10:
                return (30, 30, 30)
            return color
        return (255, 255, 255)

    return bmp(32, 32, pixel)


def unused():
    """どのデータからも使っていない絵（48×48）。市松模様と「TEST」"""
    label = text_pixels("TEST", 9, 18, 2)
    return bmp(48, 48, lambda x, y: (200, 0, 0) if (x, y) in label else ((230, 230, 230) if (x // 8 + y // 8) % 2 else (180, 180, 200)))


# ── 効果音（WAV。16 ビット・モノラル・22050Hz） ──

def wav(notes, rate=22050):
    """notes: (周波数, 秒) の並び。周波数 0 は無音"""
    samples = bytearray()
    for freq, sec in notes:
        n = int(rate * sec)
        for i in range(n):
            env = min(1.0, i / 200) * min(1.0, (n - i) / 400)
            v = math.sin(2 * math.pi * freq * i / rate) * 0.4 * env if freq else 0
            samples += struct.pack("<h", int(v * 32767))
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(samples), b"WAVE", b"fmt ", 16, 1, 1, rate, rate * 2, 2, 16, b"data", len(samples))
    return header + bytes(samples)


# ── BGM（MIDI。フォーマット 0） ──

def varlen(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.insert(0, (n & 0x7F) | 0x80)
        n >>= 7
    return bytes(out)


def midi(tempo_bpm, program, melody, bass, bass_program=33):
    """melody・bass: (音の高さ, 拍) の並び。高さ None は休み。480 tick = 1 拍"""
    events = []  # (tick, bytes)
    for channel, prog, notes in ((0, program, melody), (1, bass_program, bass)):
        events.append((0, bytes((0xC0 | channel, prog))))
        tick = 0
        for note, beats in notes:
            length = int(beats * 480)
            if note is not None:
                events.append((tick, bytes((0x90 | channel, note, 96))))
                events.append((tick + length - 20, bytes((0x80 | channel, note, 0))))
            tick += length
    events.sort(key=lambda e: (e[0], e[1][0] & 0xF0 == 0x90))
    track = bytearray(b"\x00\xff\x51\x03" + struct.pack(">I", int(60_000_000 / tempo_bpm))[1:])
    last = 0
    for tick, data in events:
        track += varlen(tick - last) + data
        last = tick
    track += b"\x00\xff\x2f\x00"
    return b"MThd" + struct.pack(">IHHH", 6, 0, 1, 480) + b"MTrk" + struct.pack(">I", len(track)) + bytes(track)


C4, D4, E4, F4, G4, A4, B4, C5, D5, E5 = 60, 62, 64, 65, 67, 69, 71, 72, 74, 76
R = None


def title_song():
    melody = [(C5, 1), (G4, 1), (E4, 1), (G4, 1), (A4, 1.5), (G4, 0.5), (E4, 2),
              (F4, 1), (A4, 1), (C5, 1), (A4, 1), (G4, 3), (R, 1),
              (E4, 1), (G4, 1), (C5, 1), (E5, 1), (D5, 1.5), (C5, 0.5), (A4, 2),
              (G4, 1), (E4, 1), (D4, 1), (E4, 1), (C4, 3), (R, 1)]
    bass = [(36, 4), (41, 4), (43, 4), (36, 4), (45, 4), (41, 4), (43, 4), (36, 4)]
    return midi(96, 0, melody, bass)


def battle_song():
    a = [(A4, 0.5), (A4, 0.5), (C5, 0.5), (A4, 0.5), (E5, 1), (D5, 1)]
    b = [(C5, 0.5), (B4, 0.5), (A4, 0.5), (G4, 0.5), (A4, 2)]
    melody = (a + b) * 2 + [(F4, 1), (A4, 1), (C5, 1), (E5, 1), (D5, 2), (B4, 2)] + [(A4, 4)]
    bass = [(33, 0.5)] * 16 + [(29, 0.5)] * 8 + [(31, 0.5)] * 8 + [(33, 0.5)] * 8
    return midi(150, 30, melody, bass)


def support_song():
    melody = [(G4, 0.5), (A4, 0.5), (B4, 0.5), (D5, 0.5), (E5, 1), (D5, 1), (B4, 1), (A4, 1), (G4, 2),
              (E4, 0.5), (G4, 0.5), (A4, 0.5), (B4, 0.5), (D5, 2), (B4, 2), (G4, 4)]
    bass = [(43, 2), (40, 2), (36, 2), (38, 2), (43, 2), (40, 2), (38, 2), (43, 2)]
    return midi(128, 73, melody, bass)


def enemy_song():
    melody = [(E4, 1), (F4, 1), (E4, 1), (R, 1), (E4, 1), (G4, 1), (F4, 2),
              (D4, 1), (E4, 1), (D4, 1), (R, 1), (C4, 2), (B4 - 12, 2)]
    bass = [(28, 1)] * 16
    return midi(110, 48, melody, bass, bass_program=43)


# ── zip ──

def add(z, name, data):
    info = zipfile.ZipInfo(name, DATE)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    z.writestr(info, data)


def sandbox_map(width=12, height=10):
    """平地に、道路・林・山・海を少し置く（番号は汎用データの terrain.txt）"""
    lines = ["MapData", "", f"{width},{height}"]
    for y in range(height):
        for x in range(width):
            terrain = 0
            if y == 5:
                terrain = 2
            elif x in (6, 7) and y in (1, 2, 8):
                terrain = 11
            elif x == 11 and y < 3:
                terrain = 15
            elif x == 0 and y > 6:
                terrain = 17
            lines.append(f"{terrain},0")
    return "\n".join(lines) + "\n"


# ── 動作確認（sandbox/checks/README.md） ──

CHECKS = SANDBOX / "checks"
CHECK_FIELDS = ("題", "日付", "種類", "関連", "確かめ方", "説明")
CHECK_NAME = re.compile(r"^(\d{4}-\d{2}-\d{2})-[a-z0-9-]+\.eve$")


class CheckError(Exception):
    pass


def read_checks():
    """見出し（# 項目: 値）を読む。新しい順（同じ日は名前の順）"""
    checks = []
    for path in sorted(CHECKS.glob("*.eve")):
        m = CHECK_NAME.match(path.name)
        if not m:
            raise CheckError(f"{path.name}: 名前は YYYY-MM-DD-英小文字・数字・-.eve にする")
        meta = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            h = re.match(r"^#\s*([^:：]+)[:：]\s*(.+)$", line)
            if h and h.group(1).strip() in CHECK_FIELDS:
                meta[h.group(1).strip()] = h.group(2).strip()
        missing = [f for f in CHECK_FIELDS if f not in meta]
        if missing:
            raise CheckError(f"{path.name}: 見出しが足りない（{'・'.join(missing)}）")
        if meta["日付"] != m.group(1):
            raise CheckError(f"{path.name}: 見出しの日付（{meta['日付']}）と名前の日付が違う")
        if meta["種類"] not in ("修正", "追加") or meta["確かめ方"] not in ("自動", "目視"):
            raise CheckError(f"{path.name}: 種類は 修正・追加、確かめ方は 自動・目視")
        body = path.read_text(encoding="utf-8").splitlines()
        if "確認:" not in body or "Call 後片付け" not in body:
            raise CheckError(f"{path.name}: 「確認:」のラベルから始め、最後に Call 後片付け でインターミッションに戻す")
        if any(line.strip() in ("後片付け:", "残りの片付け:") for line in body):
            raise CheckError(f"{path.name}: 後片付け: のラベルは書かない（scripts/make-sandbox.py が足す）")
        if any(line.startswith("Continue") for line in body):
            raise CheckError(f"{path.name}: Continue は使わない（Call 後片付け で、作ったパイロットを消してから戻る）")
        checks.append({"file": path.name, **meta})
    checks.sort(key=lambda c: (c["日付"], c["file"]), reverse=True)
    return checks


def check_pilots():
    """動作確認のデータ（data/pilot.txt）のパイロットの名前。確認が Create で作り、後片付けで消す"""
    names = []
    block = []
    for line in (CHECKS / "data" / "pilot.txt").read_text(encoding="utf-8").splitlines() + [""]:
        if line.startswith("#"):
            continue
        if line.strip():
            block.append(line.strip())
        elif block:
            names.append(block[0])
            block = []
    return names


def cleanup(label):
    """確認が作ったパイロット（と乗っているユニット）を消し、Continue（引数なし）でインターミッションに戻るラベル"""
    lines = [f"{label}:"]
    for p in check_pilots():
        lines += [f"If Level({p}) > 0 Then", f"  RemovePilot {p} 非同期", "EndIf"]
    return lines + ["Continue"]


def check_file(c):
    """
    確認のファイル。最後に「後片付け:」のラベルを足す。
    ラベルを確認のファイルの中に置くので、シナリオを上げるときの確認（ファイルごとにラベルを探す）でも見つかる
    """
    body = (CHECKS / c["file"]).read_text(encoding="utf-8").rstrip("\n")
    lines = [body, "", "# 確認の後片付け（scripts/make-sandbox.py が足す）", *cleanup("後片付け"), ""]
    return "\n".join(lines).encode("utf-8")


def check_menu(checks):
    """
    インターミッションのコマンド「動作確認」。選んだ確認のファイルを Require し、このサブステージのまま「確認:」から始める。
    確認の最後の Call 後片付け で、確認が作ったパイロット（と乗っているユニット）を消し、Continue（引数なし）でインターミッションに戻る。
    消したものはステージ（サブステージ）が終わったときにデータから消えるので、同じ確認をもう一度選んでも Create できる
    """
    pilots = check_pilots()
    leftover = " Or ".join(f"Level({p}) > 0" for p in pilots)
    lines = [
        "# インターミッションのコマンド「動作確認」（scripts/make-sandbox.py が sandbox/checks/ から作る。手で直さない）",
        "# 生成AIで作ったテスト用のシナリオの一部",
        "プロローグ:",
        "KeepBGM",
        "# 前の確認の残り（途中で終わったときなど）があれば、片付けてから選び直してもらう",
        f"If {leftover} Then",
        "  Talk システム",
        "  前の動作確認で作ったユニットが残っていたので片付けました。もう一度「動作確認」を選んでください。",
        "  End",
        "  Call 残りの片付け",
        "EndIf",
        "Ask 確かめるものを選んでください（新しい順）",
    ]
    lines += [f"{c['日付']} {c['題']}（{c['確かめ方']}）" for c in checks]
    lines += ["選ばずに戻る", "End", "Switch 選択"]
    for i, c in enumerate(checks, 1):
        lines += [
            f"Case {i}",
            "  Talk システム",
            f"  【{c['種類']}・{c['確かめ方']}】{c['題']}",
            f"  {c['説明']}",
            "  このあとすぐ始まります。終わるとインターミッションに戻ります。",
            "  End",
            f"  Require ステージ\\確認\\{c['file']}",
        ]
    lines += ["Case Else", "  Continue", "EndSw", "Exit", "", "スタート:", "Call 確認", "Exit", ""]
    # 確認の「後片付け:」は確認のファイルに足す（check_file）。Require したときに同じ名前のラベルが 2 つにならないよう、ここは別の名前にする
    lines += ["# 前の確認の残りの片付け", *cleanup("残りの片付け"), ""]
    return "\n".join(lines)


def link_label(url):
    """https://github.com/7474/SRC/pull/1330 → 7474/SRC#1330、…/commit/32db040… → 7474/SRC@32db040"""
    parts = url.rstrip("/").split("/")
    if len(parts) >= 7 and parts[2] == "github.com":
        repo = f"{parts[3]}/{parts[4]}"
        return f"{repo}@{parts[6][:7]}" if parts[5] == "commit" else f"{repo}#{parts[6]}"
    return url


def check_list(checks):
    """確認の一覧（シナリオに同梱する文書。SRC#Web の「文書」で読める）"""
    lines = [
        "# 動作確認の一覧",
        "",
        "> 生成AIで作ったテスト用のシナリオの一部です。インターミッションの「動作確認」から選んで始めます。",
        "",
        "| 日付 | 確かめること | 種類 | 確かめ方 | 関連 |",
        "|---|---|---|---|---|",
    ]
    for c in checks:
        links = " ".join(f"[{link_label(u)}]({u})" for u in c["関連"].split())
        lines.append(f"| {c['日付']} | {c['題']}。{c['説明']} | {c['種類']} | {c['確かめ方']} | {links} |")
    return "\n".join(lines) + "\n"


def build_scenario(out):
    src = SANDBOX / "scenario"
    checks = read_checks()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for path in sorted(p for p in src.rglob("*") if p.is_file()):
            add(z, path.relative_to(src).as_posix(), path.read_bytes())
        add(z, "サンドボックス/sandbox.map", sandbox_map().encode("utf-8"))
        for c in checks:
            add(z, f"サンドボックス/ステージ/確認/{c['file']}", check_file(c))
        for path in sorted((CHECKS / "lib").glob("*.eve")):
            add(z, f"サンドボックス/Lib/確認/{path.name}", path.read_bytes())
        for path in sorted((CHECKS / "data").glob("*.txt")):
            add(z, f"サンドボックス/Data/確認/{path.name}", path.read_bytes())
        add(z, "サンドボックス/Lib/動作確認.eve", check_menu(checks).encode("utf-8"))
        add(z, "サンドボックス/確認一覧.md", check_list(checks).encode("utf-8"))
    (out / "sandbox-scenario.zip").write_bytes(buf.getvalue())


def build_pack(out):
    files = {
        "README.txt": (SANDBOX / "pack" / "README.txt").read_bytes(),
        "Bitmap/Pilot/Sandbox_Aoi.bmp": face((250, 220, 190), (40, 70, 160), (20, 40, 120), (200, 220, 250)),
        "Bitmap/Pilot/Sandbox_Midori.bmp": face((245, 215, 185), (40, 130, 70), (20, 90, 40), (210, 240, 210)),
        "Bitmap/Pilot/Sandbox_Target.bmp": face((180, 180, 180), (90, 90, 90), (200, 30, 30), (240, 210, 210)),
        "Bitmap/Unit/Sandbox_Unit_Blue.bmp": unit((60, 110, 220)),
        "Bitmap/Unit/Sandbox_Unit_Green.bmp": unit((60, 170, 90)),
        "Bitmap/Unit/Sandbox_Unit_Red.bmp": unit((210, 60, 60)),
        "Bitmap/Event/Sandbox_Unused.bmp": unused(),
        "Midi/sandbox_title.mid": title_song(),
        "Midi/sandbox_battle.mid": battle_song(),
        "Midi/sandbox_support.mid": support_song(),
        "Midi/sandbox_enemy.mid": enemy_song(),
        "Sound/sandbox_beep.wav": wav([(880, 0.12), (0, 0.04), (1320, 0.18)]),
        "Sound/sandbox_unused.wav": wav([(440, 0.2), (330, 0.3)]),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            add(z, name, data)
    (out / "sandbox-pack.zip").write_bytes(buf.getvalue())


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "out" / "sandbox"
    out.mkdir(parents=True, exist_ok=True)
    build_scenario(out)
    build_pack(out)
    for name in ("sandbox-scenario.zip", "sandbox-pack.zip"):
        print(out / name)


if __name__ == "__main__":
    main()
