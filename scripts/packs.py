#!/usr/bin/env python3
"""packs/<id>.json の定義からパック（素材の zip）を作る（docs/architecture.md の「パック」）。

    python3 -I scripts/packs.py build [--out out/packs] [--exclude-file F] [--cache DIR] [id ...]

- 出力: <out>/<id>.zip と <out>/<id>.json（D1 の packs の行に入れる値）
- 版（version）は zip の中身（パスと内容）の sha256 の先頭 12 桁。中身が同じなら版も同じ
- --exclude-file: 取り下げたファイル（takedowns の pack_file）。1 行に「<id>:<パス>」
- 元の配布物の種類（source.type）
  - srcsharp: 7474/SRC のフォルダ（環境変数 SRC_DIR に 7474/SRC の checkout）
  - command:  コマンドが第 1 引数に zip を書く
  - zip:      URL から取得し sha256 を確かめて、strip・include で取り出す
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKS_DIR = ROOT / "packs"
# zip のタイムスタンプを固定し、同じ中身なら同じバイト列にする
FIXED_TIME = (2000, 1, 1, 0, 0, 0)


def load_defs(ids: list[str]) -> list[dict]:
    defs = []
    for f in sorted(PACKS_DIR.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if d["id"] != f.stem:
            sys.exit(f"{f.name}: id が {d['id']} でファイル名と違う")
        if not ids or d["id"] in ids:
            defs.append(d)
    missing = set(ids) - {d["id"] for d in defs}
    if missing:
        sys.exit(f"定義が無い: {', '.join(sorted(missing))}")
    return defs


def decode_name(info: zipfile.ZipInfo) -> str:
    # UTF-8 フラグ（bit 11）が無い名前は zipfile が cp437 として読む。Shift_JIS として読み直す
    if info.flag_bits & 0x800:
        return info.filename
    raw = info.filename.encode("cp437")
    for enc in ("cp932", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return info.filename


def safe_path(name: str) -> str | None:
    name = name.replace("\\", "/")
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts) or ":" in parts[0]:
        return None
    return "/".join(parts)


def download(url: str, sha256: str, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    dest = cache / f"{sha256}.zip"
    if not dest.exists():
        tmp = dest.with_suffix(".part")
        with urllib.request.urlopen(url, timeout=600) as r, open(tmp, "wb") as w:
            while chunk := r.read(1 << 20):
                w.write(chunk)
        tmp.rename(dest)
    h = hashlib.sha256()
    with open(dest, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    if h.hexdigest() != sha256:
        dest.unlink()
        sys.exit(f"{url}: sha256 が違う（{h.hexdigest()}）")
    return dest


def collect_zip(src: dict, cache: Path) -> dict[str, bytes]:
    path = download(src["url"], src["sha256"], cache)
    strip = src.get("strip", 0)
    include = src.get("include") or [""]
    files: dict[str, bytes] = {}
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            p = safe_path(decode_name(info))
            if p is None:
                continue
            parts = p.split("/")[strip:]
            if not parts:
                continue
            p = "/".join(parts)
            # 大文字小文字を区別しない（SRC は Windows のパスを前提にしている）
            if any(p.lower().startswith(i.lower()) for i in include):
                files[p] = z.read(info)
    return files


def collect_dir(base: Path, exclude: list[str]) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for f in sorted(base.rglob("*")):
        if f.is_file():
            rel = f.relative_to(base).as_posix()
            if rel not in exclude:
                files[rel] = f.read_bytes()
    return files


def collect(d: dict, cache: Path) -> dict[str, bytes]:
    src = d["source"]
    t = src["type"]
    if t == "zip":
        return collect_zip(src, cache)
    if t == "srcsharp":
        src_dir = os.environ.get("SRC_DIR")
        if not src_dir:
            sys.exit("SRC_DIR（7474/SRC の checkout）を指定する")
        return collect_dir(Path(src_dir) / src["path"], src.get("exclude", []))
    if t == "command":
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.zip"
            subprocess.run([*src["command"], str(out)], cwd=ROOT, check=True)
            with zipfile.ZipFile(out) as z:
                return {p: z.read(i) for i in z.infolist()
                        if not i.is_dir() and (p := safe_path(decode_name(i)))}
    sys.exit(f"{d['id']}: 知らない source.type: {t}")


def write_zip(files: dict[str, bytes], out: Path) -> str:
    h = hashlib.sha256()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(files):
            info = zipfile.ZipInfo(p, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            # 名前は UTF-8（zipfile は ASCII 以外の名前に UTF-8 のフラグを立てる）
            z.writestr(info, files[p])
            h.update(p.encode("utf-8") + b"\0" + hashlib.sha256(files[p]).digest())
    return h.hexdigest()[:12]


def build(args: argparse.Namespace) -> None:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    takedowns: dict[str, set[str]] = {}
    if args.exclude_file:
        for line in Path(args.exclude_file).read_text(encoding="utf-8").splitlines():
            if ":" in line:
                pid, p = line.split(":", 1)
                takedowns.setdefault(pid, set()).add(p.strip().lower())
    for d in load_defs(args.ids):
        files = collect(d, Path(args.cache))
        removed = takedowns.get(d["id"], set())
        before = len(files)
        files = {p: b for p, b in files.items() if p.lower() not in removed}
        taken = before - len(files)
        if not files:
            sys.exit(f"{d['id']}: ファイルが 1 つも無い")
        zip_path = out_dir / f"{d['id']}.zip"
        version = write_zip(files, zip_path)
        meta = {
            "id": d["id"],
            "title": d["title"],
            "description": d.get("description"),
            "source_name": d["source_name"],
            "source_url": d.get("source_url"),
            "license": d["license"],
            "is_default": d.get("is_default", 0),
            "priority": d.get("priority", 0),
            "root": d.get("root"),
            "version": version,
            "r2_key": f"packs/{d['id']}/{version}.zip",
            "size": zip_path.stat().st_size,
        }
        (out_dir / f"{d['id']}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{d['id']}: {len(files)} files, {meta['size']} bytes, version {version}"
              + (f", {taken} taken down" if taken else ""))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("ids", nargs="*")
    b.add_argument("--out", default=str(ROOT / "out" / "packs"))
    b.add_argument("--exclude-file")
    b.add_argument("--cache", default=str(ROOT / "out" / "cache"))
    args = ap.parse_args()
    if args.cmd == "build":
        build(args)


if __name__ == "__main__":
    main()
