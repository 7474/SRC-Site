import { describe, expect, it } from 'vitest';
import { crc32, deflateRawSync } from 'node:zlib';
import { buildPack, partWriter, WindowReader, type Plan } from '../src/client/packbuild';
import { packZipSize, verifyPackZip, type PackFile } from '../src/lib/packzip';
import { extractEntry, readEntries, type RangeReader } from '../src/lib/zip';

const text = (s: string) => new TextEncoder().encode(s);

// 投稿の zip を作る（deflate か無圧縮。テスト用）
function makeZip(files: { name: string; data: Uint8Array; deflate?: boolean }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = text(f.name);
    const body = f.deflate ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, f.deflate ? 8 : 0, true);
    local.setUint32(14, crc32(f.data), true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, f.deflate ? 8 : 0, true);
    entry.setUint32(16, crc32(f.data), true);
    entry.setUint32(20, body.length, true);
    entry.setUint32(24, f.data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of all) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

function reader(bytes: Uint8Array): RangeReader {
  return { size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) };
}

/** 投稿の zip の目次から、パックに入れるファイル（root を除いた道）を作る（inspectSubmission と同じ） */
async function filesOf(zip: Uint8Array, source: string, root = ''): Promise<PackFile[]> {
  return (await readEntries(reader(zip))).map(e => ({
    path: root ? e.name.slice(root.length + 1) : e.name, size: e.size, compressedSize: e.compressedSize, crc32: e.crc32, method: e.method, offset: e.offset, source,
  }));
}

describe('パックの zip の組み立て', () => {
  const faces = makeZip([
    { name: '顔/Bitmap/Pilot/a.bmp', data: text('BM' + 'a'.repeat(1000)), deflate: true },
    { name: '顔/Bitmap/Pilot/b.bmp', data: text('BM b') },
  ]);
  const sounds = makeZip([{ name: 'Sound/beep.wav', data: text('RIFF' + 'x'.repeat(5000)), deflate: true }]);
  const sources: Record<string, Uint8Array> = { '/s/1.zip': faces, '/s/2.zip': sounds };
  const readerFor = (source: string) => new WindowReader(async (o, l) => sources[source].slice(o, o + l), 16);

  it('投稿の zip から圧縮したまま写し、Worker の確かめに通る', async () => {
    const plan: Plan = { revision: 3, files: [...await filesOf(faces, '/s/1.zip', '顔'), ...await filesOf(sounds, '/s/2.zip')] };
    const chunks: Uint8Array[] = [];
    const size = await buildPack(plan, { write: async c => void chunks.push(c.slice()) }, readerFor);
    const zip = new Uint8Array(size);
    let p = 0;
    for (const c of chunks) {
      zip.set(c, p);
      p += c.length;
    }
    expect(size).toBe(packZipSize(plan.files));
    const entries = await readEntries(reader(zip));
    expect(entries.map(e => e.name)).toEqual(['Bitmap/Pilot/a.bmp', 'Bitmap/Pilot/b.bmp', 'Sound/beep.wav']);
    expect(verifyPackZip(entries, plan.files, size)).toBeNull();
    expect(new TextDecoder().decode(await extractEntry(reader(zip), entries[0]))).toBe('BM' + 'a'.repeat(1000));
    expect(new TextDecoder().decode(await extractEntry(reader(zip), entries[2]))).toBe('RIFF' + 'x'.repeat(5000));

    // 承認していないファイルを足した・中身を変えた zip は断る
    const other = makeZip([{ name: 'Bitmap/Pilot/a.bmp', data: text('evil') }]);
    expect(verifyPackZip(await readEntries(reader(other)), plan.files, other.length)).toMatch(/大きさ|数/);
    const swapped = plan.files.map(f => f.path === 'Bitmap/Pilot/b.bmp' ? { ...f, crc32: f.crc32 ^ 1 } : f);
    expect(verifyPackZip(entries, swapped, size)).toMatch(/中身が合いません/);
  });

  it('partSize ずつにまとめて渡す（最後だけ短い）', async () => {
    const got: [number, number][] = [];
    const w = partWriter(4, async (n, body) => void got.push([n, body.length]));
    await w.write(text('abc'));
    await w.write(text('defghij'));
    await w.flush();
    expect(got).toEqual([[1, 4], [2, 4], [3, 2]]);
  });
});
