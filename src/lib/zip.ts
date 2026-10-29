// zip の目次（中央ディレクトリ）だけを読んで検査する。中身は展開しない。
// 形式: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT

export interface RangeReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type ZipEntry = {
  name: string;
  compressedSize: number;
  size: number;
  encrypted: boolean;
  directory: boolean;
  /** 圧縮の方式（0: 無圧縮、8: deflate） */
  method: number;
  /** ローカルヘッダの位置 */
  offset: number;
};

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {}

function u16(b: Uint8Array, o: number) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
}
function u64(b: Uint8Array, o: number) {
  return u32(b, o) + u32(b, o + 4) * 0x100000000;
}

let sjis: TextDecoder | null | undefined;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  // 印が無くても、UTF-8 として正しく読めれば UTF-8（macOS・Linux の zip は UTF-8 の名前に印を付けないことがある）。
  // SRC#Web（ScenarioArchive の ZipNameEncoding）と同じ規則にし、root・.eve の名前を合わせる
  try {
    return strictUtf8.decode(bytes);
  } catch {
    // UTF-8 でなければ Shift_JIS（Windows で作った zip）
  }
  // 使えなければ 1 バイトずつ読む（拡張子と区切りの判定には足りる）
  if (sjis === undefined) {
    try {
      sjis = new TextDecoder('shift_jis');
    } catch {
      sjis = null;
    }
  }
  if (sjis) {
    return sjis.decode(bytes);
  }
  return String.fromCharCode(...bytes);
}

export async function readEntries(reader: RangeReader, maxEntries = 200_000): Promise<ZipEntry[]> {
  if (reader.size < 22) {
    throw new ZipError('zip ではありません（小さすぎます）');
  }
  const tailLength = Math.min(reader.size, 22 + MAX_COMMENT);
  const tailOffset = reader.size - tailLength;
  const tail = await reader.read(tailOffset, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ZipError('zip ではありません（終端が見つかりません）');
  }
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (u16(tail, eocd + 4) !== 0 || u16(tail, eocd + 6) !== 0) {
    throw new ZipError('分割された zip には対応していません');
  }
  // Zip64
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locatorAt = eocd - 20;
    if (locatorAt < 0 || u32(tail, locatorAt) !== ZIP64_LOCATOR_SIG) {
      throw new ZipError('Zip64 の終端が見つかりません');
    }
    const zip64Offset = u64(tail, locatorAt + 8);
    const z = await reader.read(zip64Offset, 56);
    if (u32(z, 0) !== ZIP64_EOCD_SIG) {
      throw new ZipError('Zip64 の終端が壊れています');
    }
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOffset = u64(z, 48);
  }
  if (count > maxEntries) {
    throw new ZipError(`ファイルが多すぎます（${count}）`);
  }
  if (cdOffset + cdSize > reader.size) {
    throw new ZipError('目次の位置が壊れています');
  }
  const cd = await reader.read(cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || u32(cd, p) !== CENTRAL_SIG) {
      throw new ZipError('目次が壊れています');
    }
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let offset = u32(cd, p + 42);
    let compressedSize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLength = u16(cd, p + 28);
    const extraLength = u16(cd, p + 30);
    const commentLength = u16(cd, p + 32);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLength);
    const extra = cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    // Zip64 の拡張フィールド（大きさが 0xffffffff のとき）
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
      for (let e = 0; e + 4 <= extra.length;) {
        const id = u16(extra, e);
        const len = u16(extra, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) {
            size = u64(extra, q);
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(extra, q);
            q += 8;
          }
          if (offset === 0xffffffff) {
            offset = u64(extra, q);
          }
          break;
        }
        e += 4 + len;
      }
    }
    const name = decodeName(nameBytes, (flags & 0x0800) !== 0);
    entries.push({
      name,
      compressedSize,
      size,
      encrypted: (flags & 0x0001) !== 0,
      directory: name.endsWith('/') || name.endsWith('\\'),
      method,
      offset,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export const LIMITS = {
  maxEntries: 50_000,
  maxTotalSize: 3 * 1024 * 1024 * 1024,
  maxRatio: 100,
};

const EXECUTABLE = /\.(exe|dll|bat|cmd|vbs|vbe|js|jse|wsf|wsh|ps1|scr|msi|com|lnk|hta|cpl|jar)$/i;
const DOCUMENT = /\.(txt|md|htm|html)$/i;

export type Manifest = {
  files: number;
  totalSize: number;
  eves: string[];
  documents: string[];
  roots: string[];
  /** 種類ごとのファイルの数（素材の投稿だけ） */
  media?: Partial<Record<MediaKind, number>>;
};

/** 投稿の種類。scenario はシナリオ、resource は共有パックに投稿する素材（docs/resources.md） */
export type UploadKind = 'scenario' | 'resource';

export type MediaKind = 'image' | 'audio' | 'midi' | 'data' | 'event' | 'map' | 'document' | 'other';

/** ファイルの種類（拡張子で決める）。データビューアの一覧とパックの頁に使う */
const MEDIA_KINDS: [MediaKind, RegExp][] = [
  ['image', /\.(bmp|png|jpe?g|gif)$/i],
  ['audio', /\.(wav|mp3|ogg)$/i],
  ['midi', /\.(mid|midi)$/i],
  ['event', /\.eve$/i],
  ['map', /\.map$/i],
  ['document', /(^|\/)(readme[^/]*|[^/]*\.(md|htm|html))$/i],
  ['data', /\.txt$/i],
];

export function mediaKind(name: string): MediaKind {
  return MEDIA_KINDS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'other';
}

// 素材の zip で、SRC のフォルダ（展開先）の直下にあるフォルダ。これで始まらない 1 つのフォルダに入っていれば、それを root にする
const SRC_FOLDERS = /^(bitmap|sound|midi|music|data|lib)$/i;

export type Inspection = { ok: true; manifest: Manifest; root: string | null; eve: string | null } | { ok: false; reason: string };

/**
 * 目次を規則で検査し、root と最初の .eve の候補を出す（docs/architecture.md の「検査」）。
 * 素材（resource）は .eve が無くてよく、root は SRC のフォルダの中身（Bitmap・Sound など）の上のフォルダにする
 */
export function inspect(entries: ZipEntry[], kind: UploadKind = 'scenario'): Inspection {
  const files = entries.filter(e => !e.directory);
  if (files.length > LIMITS.maxEntries) {
    return { ok: false, reason: `ファイルが多すぎます（${files.length}、上限 ${LIMITS.maxEntries}）` };
  }
  let total = 0;
  for (const e of files) {
    const name = e.name.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
      return { ok: false, reason: `パスが不正です: ${e.name}` };
    }
    if (EXECUTABLE.test(name)) {
      return { ok: false, reason: `実行ファイルは置けません: ${e.name}` };
    }
    if (e.encrypted) {
      return { ok: false, reason: `暗号化されたファイルは置けません: ${e.name}` };
    }
    if (e.size > 1024 * 1024 && e.compressedSize > 0 && e.size / e.compressedSize > LIMITS.maxRatio) {
      return { ok: false, reason: `圧縮率が高すぎます（zip 爆弾の疑い）: ${e.name}` };
    }
    total += e.size;
  }
  if (total > LIMITS.maxTotalSize) {
    return { ok: false, reason: '展開後の大きさが上限（3 GB）を超えます' };
  }
  const names = files.map(e => e.name.replace(/\\/g, '/'));
  const eves = names.filter(n => /\.eve$/i.test(n));
  if (eves.length === 0 && kind === 'scenario') {
    return { ok: false, reason: 'シナリオ（.eve）がありません' };
  }
  if (files.length === 0) {
    return { ok: false, reason: 'ファイルがありません' };
  }
  // 全体が 1 つのフォルダに入っていれば、それを root にする（素材は、そのフォルダが Bitmap などそのものでなければ）
  const tops = new Set(names.map(n => (n.includes('/') ? n.slice(0, n.indexOf('/')) : '')));
  const single = tops.size === 1 && !tops.has('') ? [...tops][0] : null;
  const root = single && !(kind === 'resource' && SRC_FOLDERS.test(single)) ? single : null;
  const strip = (n: string) => (root ? n.slice(root.length + 1) : n);
  const depth = (n: string) => n.split('/').length;
  const sorted = eves.map(strip).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const media: Partial<Record<MediaKind, number>> = {};
  if (kind === 'resource') {
    for (const n of names) {
      const k = mediaKind(n);
      media[k] = (media[k] ?? 0) + 1;
    }
  }
  // 浅い階層の .eve のうち、データの読み込み用（Data・Lib・Include の下）でないものを最初の候補にする
  const candidate = kind === 'scenario' ? sorted.find(n => !/^(data|lib|include)\//i.test(n)) ?? sorted[0] : null;
  return {
    ok: true,
    root,
    eve: candidate,
    manifest: {
      files: files.length,
      totalSize: total,
      eves: sorted.slice(0, 200),
      documents: names.map(strip).filter(n => DOCUMENT.test(n) && depth(n) <= 2).slice(0, 50),
      roots: [...tops].filter(t => t).slice(0, 20),
      ...(kind === 'resource' ? { media } : {}),
    },
  };
}

/** 項目を名前で探す（区切りの \ と /、大文字小文字を区別しない。元の SRC は Windows で動くため） */
export function findEntry(entries: ZipEntry[], path: string): ZipEntry | undefined {
  const key = path.replace(/\\/g, '/').toLowerCase();
  return entries.find(e => !e.directory && e.name.replace(/\\/g, '/').toLowerCase() === key);
}

/** 項目の中身を取り出す（無圧縮か deflate。DecompressionStream を使う） */
export async function extractEntry(reader: RangeReader, e: ZipEntry): Promise<Uint8Array> {
  if (e.encrypted) {
    throw new ZipError(`暗号化されています: ${e.name}`);
  }
  const local = await reader.read(e.offset, 30);
  if (u32(local, 0) !== 0x04034b50) {
    throw new ZipError(`zip が壊れています: ${e.name}`);
  }
  const data = await reader.read(e.offset + 30 + u16(local, 26) + u16(local, 28), e.compressedSize);
  if (e.method === 0) {
    return data;
  }
  if (e.method === 8) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new ZipError(`対応していない圧縮方式です（${e.method}）: ${e.name}`);
}

/** R2 のオブジェクトを読む RangeReader */
export function r2Reader(bucket: R2Bucket, key: string, size: number): RangeReader {
  return {
    size,
    async read(offset, length) {
      const object = await bucket.get(key, { range: { offset, length } });
      if (!object) {
        throw new ZipError('ファイルがありません');
      }
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}
