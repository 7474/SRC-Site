import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { extractEntry, findEntry, inspect, mediaKind, readEntries, type RangeReader } from '../src/lib/zip';

// 無圧縮の zip を作る（テスト用）
function makeZip(files: { name: string | Uint8Array; data: Uint8Array; utf8?: boolean; flags?: number; size?: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = typeof f.name === 'string' ? new TextEncoder().encode(f.name) : f.name;
    const flags = (f.utf8 === false ? 0 : 0x0800) | (f.flags ?? 0);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.size ?? f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, flags, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, f.data.length, true);
    entry.setUint32(24, f.size ?? f.data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + f.data.length;
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
  return { size: bytes.length, read: async (o, l) => bytes.slice(o, o + l) };
}

const text = (s: string) => new TextEncoder().encode(s);

describe('readEntries', () => {
  it('中央ディレクトリから名前と大きさを読む', async () => {
    const zip = makeZip([{ name: 'game/start.eve', data: text('Talk') }, { name: 'game/data/unit.txt', data: text('x') }]);
    const entries = await readEntries(reader(zip));
    expect(entries.map(e => [e.name, e.size])).toEqual([['game/start.eve', 4], ['game/data/unit.txt', 1]]);
  });

  it('UTF-8 の印の無い名前は Shift_JIS として読む', async () => {
    // 「開始.eve」の Shift_JIS
    const sjis = new Uint8Array([0x8a, 0x4a, 0x8e, 0x6e, 0x2e, 0x65, 0x76, 0x65]);
    const entries = await readEntries(reader(makeZip([{ name: sjis, data: text('a'), utf8: false }])));
    expect(entries[0].name).toBe('開始.eve');
  });

  it('UTF-8 の印の無い名前も、UTF-8 として正しく読めれば UTF-8 として読む', async () => {
    // macOS・Linux の zip コマンドが作る形
    const entries = await readEntries(reader(makeZip([{ name: text('灯の港/01_灯の港.eve'), data: text('a'), utf8: false }])));
    expect(entries[0].name).toBe('灯の港/01_灯の港.eve');
  });

  it('zip でないものは弾く', async () => {
    await expect(readEntries(reader(text('not a zip file at all, just text')))).rejects.toThrow(/zip ではありません/);
  });
});

describe('inspect', () => {
  const entries = (names: string[], extra: Partial<{ size: number; compressedSize: number; encrypted: boolean }> = {}) =>
    names.map(name => ({ name, size: 10, compressedSize: 10, encrypted: false, directory: name.endsWith('/'), ...extra }));

  it('1 つのフォルダに入っていれば root にし、浅い .eve を最初に選ぶ', () => {
    const r = inspect(entries(['ロボ/', 'ロボ/data/include.eve', 'ロボ/ニューゲーム.eve', 'ロボ/README.txt', 'ロボ/Lib/x.eve']));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.root).toBe('ロボ');
      expect(r.eve).toBe('ニューゲーム.eve');
      expect(r.manifest.documents).toEqual(['README.txt']);
    }
  });

  it('.eve が無いものは弾く', () => {
    expect(inspect(entries(['a.txt']))).toMatchObject({ ok: false, reason: expect.stringContaining('.eve') });
  });

  it.each([
    ['../evil.eve', 'パスが不正'],
    ['/abs.eve', 'パスが不正'],
    ['C:/x.eve', 'パスが不正'],
    ['a\\..\\b.eve', 'パスが不正'],
    ['tool.exe', '実行ファイル'],
    ['Setup.BAT', '実行ファイル'],
  ])('%s は弾く', (name, reason) => {
    expect(inspect(entries(['ok.eve', name]))).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  });

  it('暗号化・zip 爆弾は弾く', () => {
    expect(inspect(entries(['a.eve'], { encrypted: true }))).toMatchObject({ ok: false });
    expect(inspect(entries(['a.eve'], { size: 500 * 1024 * 1024, compressedSize: 1024 }))).toMatchObject({ ok: false, reason: expect.stringContaining('圧縮率') });
  });
});

describe('extractEntry', () => {
  it('取り出す（ローカルヘッダの位置と方式を目次から読む）', async () => {
    const text = (s: string) => new TextEncoder().encode(s);
    const r = reader(makeZip([{ name: 'a/System/sp.txt', data: text('集中') }, { name: 'a/Bitmap/x.bmp', data: text('BM') }]));
    const entries = await readEntries(r);
    expect(entries.map(e => [e.name, e.method])).toEqual([['a/System/sp.txt', 0], ['a/Bitmap/x.bmp', 0]]);
    expect(entries[1].offset).toBeGreaterThan(0);
    expect(new TextDecoder().decode(await extractEntry(r, entries[0]))).toBe('集中');
    expect(new TextDecoder().decode(await extractEntry(r, entries[1]))).toBe('BM');
  });
});

describe('素材（resource）の検査', () => {
  const entries = async (names: string[]) => readEntries(reader(makeZip(names.map(name => ({ name, data: text('x') })))));

  it('.eve が無くてよく、種類ごとの数を数える', async () => {
    const result = inspect(await entries(['Bitmap/Pilot/a.bmp', 'Bitmap/Unit/b.png', 'Sound/c.wav', 'Midi/d.mid', 'Data/pilot.txt']), 'resource');
    expect(result).toMatchObject({ ok: true, root: null, eve: null });
    expect(result.ok && result.manifest.media).toEqual({ image: 2, audio: 1, midi: 1, data: 1 });
  });

  it('SRC のフォルダ（Bitmap など）だけなら root にしない。ほかの 1 つのフォルダなら root にする', async () => {
    expect(inspect(await entries(['Bitmap/Pilot/a.bmp', 'Bitmap/Unit/b.bmp']), 'resource')).toMatchObject({ ok: true, root: null });
    expect(inspect(await entries(['素材集/Bitmap/Pilot/a.bmp', '素材集/Sound/b.wav']), 'resource')).toMatchObject({ ok: true, root: '素材集' });
  });

  it('シナリオは今までどおり .eve が要る。素材でも実行ファイルは弾く', async () => {
    expect(inspect(await entries(['Bitmap/Pilot/a.bmp']))).toMatchObject({ ok: false });
    expect(inspect(await entries(['Bitmap/Pilot/a.bmp', 'tool.exe']), 'resource')).toMatchObject({ ok: false });
  });
});

describe('mediaKind・findEntry', () => {
  it('拡張子で種類を決める', () => {
    expect(['a.BMP', 'b.wav', 'c.mid', 'Data/robot.txt', 'readme.txt', 'x.eve', 'y.map', 'z.lzh'].map(mediaKind))
      .toEqual(['image', 'audio', 'midi', 'data', 'document', 'event', 'map', 'other']);
  });

  it('区切りと大文字小文字を区別せずに探す', async () => {
    const list = await readEntries(reader(makeZip([{ name: 'Pack\\Bitmap\\Pilot\\Hero.BMP', data: text('BM') }])));
    expect(findEntry(list, 'pack/bitmap/pilot/hero.bmp')?.name).toBe('Pack\\Bitmap\\Pilot\\Hero.BMP');
    expect(findEntry(list, 'pack/bitmap/pilot/other.bmp')).toBeUndefined();
  });
});
