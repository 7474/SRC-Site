// アップロードの前に、ブラウザで zip の目次を読んで検査する（Worker の検査と同じ規則。src/lib/zip.ts）。
// scripts/assemble.sh が dist/static/precheck.js に束ねる。public/upload.js が読み込む
import { inspect, readEntries, ZipError, type RangeReader } from '../lib/zip';

export function fileReader(file: Blob): RangeReader {
  return {
    size: file.size,
    async read(offset, length) {
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    },
  };
}

export type Precheck = { ok: true; root: string | null; eve: string | null; files: number } | { ok: false; reason: string };

export async function precheck(file: Blob): Promise<Precheck> {
  try {
    const entries = await readEntries(fileReader(file));
    const result = inspect(entries);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, root: result.root, eve: result.eve, files: entries.filter(e => !e.directory).length };
  } catch (e) {
    if (e instanceof ZipError) {
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}

// SRC が読むデータのファイル（DataLinter が名前で種類を決めるもの）
const DATA_FILE = /(^|\/)(robot|unit|pilot|non_pilot|pilot_message|pilot_dialog|effect|animation|item|sp|mind|alias|terrain)\.txt$/i;

export type Survey = {
  /** scenario: .eve がある / data: .eve は無いがデータがある / other: どちらも無い */
  kind: 'scenario' | 'data' | 'other';
  /** zip の最上位のフォルダ（全体が 1 つのフォルダに入っていれば） */
  root: string | null;
  files: number;
  eves: number;
  dataFiles: string[];
  /** 投稿の検査（zip の目次の規則）に通るか。通らなければその理由 */
  uploadable: boolean;
  uploadReason?: string;
};

/**
 * チェッカー（/check）向けに zip の中身を調べる。投稿の検査と違い、.eve が無いデータだけの zip も受け付け、規則に合わないことは理由として返す
 */
export async function survey(file: Blob): Promise<Survey> {
  const entries = await readEntries(fileReader(file));
  const names = entries.filter(e => !e.directory).map(e => e.name.replace(/\\/g, '/'));
  const inspection = inspect(entries);
  const tops = new Set(names.map(n => (n.includes('/') ? n.slice(0, n.indexOf('/')) : '')));
  const eves = names.filter(n => /\.eve$/i.test(n)).length;
  const dataFiles = names.filter(n => DATA_FILE.test(n));
  return {
    kind: eves > 0 ? 'scenario' : dataFiles.length > 0 ? 'data' : 'other',
    root: tops.size === 1 && !tops.has('') ? [...tops][0] : null,
    files: names.length,
    eves,
    dataFiles,
    uploadable: inspection.ok,
    ...(inspection.ok ? {} : { uploadReason: inspection.reason }),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * ファイルを圧縮せずに zip にまとめる（チェッカーに、zip でなくファイルやフォルダを渡したとき）。名前は UTF-8 で書く。
 * 4 GB を超えるものには対応しない（Zip64 を書かない）
 */
export function buildZip(files: { name: string; data: Uint8Array }[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = encoder.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const header = new Uint8Array(46 + name.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x02014b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 20, true);
    hv.setUint16(8, 0x0800, true);
    hv.setUint32(16, crc, true);
    hv.setUint32(20, f.data.length, true);
    hv.setUint32(24, f.data.length, true);
    hv.setUint16(28, name.length, true);
    hv.setUint32(42, offset, true);
    header.set(name, 46);
    parts.push(local, f.data);
    central.push(header);
    offset += local.length + f.data.length;
  }
  const centralSize = central.reduce((n, h) => n + h.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
