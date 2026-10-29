// 利用者が作ったパックの zip の組み立て（docs/resources.md の「zip への反映」）。
// 承認者のブラウザ（src/client/packbuild.ts）が組み、Worker（verifyPackZip）が目次を確かめる。
// 投稿の zip の項目を、展開・再圧縮せずに写す（ローカルヘッダだけ書き直す）。Zip64 は使わない
import type { ZipEntry } from './zip';

/** パックに入れるファイル（pack_files の active の行と、それがある投稿の zip） */
export type PackFile = {
  path: string;
  size: number;
  compressedSize: number;
  crc32: number;
  method: number;
  /** 投稿の zip の中のローカルヘッダの位置 */
  offset: number;
  /** 投稿の zip の URL */
  source: string;
};

export const PACK_LIMITS = { maxEntries: 0xffff, maxSize: 0xffffffff };

const encoder = new TextEncoder();
const LOCAL = 30;
const CENTRAL = 46;
const END = 22;
// 1980-01-01 00:00（時刻は持たない。中身が同じなら同じ zip になる）
const DOS_DATE = 0x21;
const UTF8 = 0x0800;

export function nameBytes(path: string): Uint8Array {
  return encoder.encode(path);
}

/** 組んだ zip の大きさ（承認者のブラウザと Worker が同じ値を出す） */
export function packZipSize(files: Pick<PackFile, 'path' | 'compressedSize'>[]): number {
  let size = END;
  for (const f of files) {
    const n = nameBytes(f.path).length;
    size += LOCAL + n + f.compressedSize + CENTRAL + n;
  }
  return size;
}

/** 組めるか（Zip64 を使わないので、項目の数と大きさに上限がある） */
export function packZipProblem(files: Pick<PackFile, 'path' | 'compressedSize'>[]): string | null {
  if (files.length === 0) {
    return 'パックにファイルがありません';
  }
  if (files.length > PACK_LIMITS.maxEntries) {
    return `ファイルが多すぎます（${files.length}、上限 ${PACK_LIMITS.maxEntries}）`;
  }
  if (packZipSize(files) >= PACK_LIMITS.maxSize) {
    return 'パックが大きすぎます（4 GB まで）';
  }
  return null;
}

function header(f: PackFile, name: Uint8Array, central: boolean, offset = 0): Uint8Array {
  const b = new Uint8Array((central ? CENTRAL : LOCAL) + name.length);
  const v = new DataView(b.buffer);
  let p = 0;
  v.setUint32(p, central ? 0x02014b50 : 0x04034b50, true);
  p += 4;
  if (central) {
    v.setUint16(p, 20, true);
    p += 2;
  }
  v.setUint16(p, 20, true);
  v.setUint16(p + 2, UTF8, true);
  v.setUint16(p + 4, f.method, true);
  v.setUint16(p + 6, 0, true);
  v.setUint16(p + 8, DOS_DATE, true);
  v.setUint32(p + 10, f.crc32 >>> 0, true);
  v.setUint32(p + 14, f.compressedSize, true);
  v.setUint32(p + 18, f.size, true);
  v.setUint16(p + 22, name.length, true);
  v.setUint16(p + 24, 0, true);
  if (central) {
    // コメントの長さ・ディスク番号・内部属性・外部属性・ローカルヘッダの位置
    v.setUint32(42, offset, true);
  }
  b.set(name, central ? CENTRAL : LOCAL);
  return b;
}

export function localHeader(f: PackFile): Uint8Array {
  return header(f, nameBytes(f.path), false);
}

/** 中央ディレクトリと終端。offsets は各項目のローカルヘッダの位置 */
export function centralDirectory(files: PackFile[], offsets: number[]): Uint8Array {
  const parts = files.map((f, i) => header(f, nameBytes(f.path), true, offsets[i]));
  const cdSize = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(cdSize + END);
  let p = 0;
  for (const b of parts) {
    out.set(b, p);
    p += b.length;
  }
  const v = new DataView(out.buffer);
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, files.length, true);
  v.setUint16(p + 10, files.length, true);
  v.setUint32(p + 12, cdSize, true);
  v.setUint32(p + 16, offsets.length ? offsets[offsets.length - 1] + LOCAL + nameBytes(files[files.length - 1].path).length + files[files.length - 1].compressedSize : 0, true);
  return out;
}

/**
 * 上がってきた zip の目次を、パックに入れるファイルと照らし合わせる（Worker）。
 * 名前・大きさ・CRC32・圧縮の方式が一致し、項目がすき間なく並んでいる（ほかのデータを挟んでいない）こと。問題があれば理由
 */
export function verifyPackZip(entries: ZipEntry[], files: Pick<PackFile, 'path' | 'size' | 'compressedSize' | 'crc32' | 'method'>[], zipSize: number): string | null {
  if (zipSize !== packZipSize(files)) {
    return `大きさが合いません（${zipSize}、期待 ${packZipSize(files)}）`;
  }
  if (entries.length !== files.length) {
    return `ファイルの数が合いません（${entries.length}、期待 ${files.length}）`;
  }
  const expected = new Map(files.map(f => [f.path, f]));
  let next = 0;
  for (const e of [...entries].sort((a, b) => a.offset - b.offset)) {
    const f = expected.get(e.name);
    if (!f) {
      return `パックに無いファイルがあります: ${e.name}`;
    }
    expected.delete(e.name);
    if (e.size !== f.size || e.compressedSize !== f.compressedSize || (e.crc32 >>> 0) !== (f.crc32 >>> 0) || e.method !== f.method || e.encrypted) {
      return `中身が合いません: ${e.name}`;
    }
    if (e.offset !== next) {
      return `項目の並びが合いません: ${e.name}`;
    }
    next += LOCAL + nameBytes(e.name).length + e.compressedSize;
  }
  return null;
}
