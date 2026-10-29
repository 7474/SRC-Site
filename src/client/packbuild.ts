// パックの zip を承認者のブラウザで組み、R2 に上げる（docs/resources.md の「zip への反映」）。
// scripts/assemble.sh が dist/static/packbuild.js に束ねる。public/pack-build.js が読み込む。
// 投稿の zip から、展開せずに圧縮済みの中身を Range で読んで写す。Worker の負荷を承認者のブラウザに移す
import { centralDirectory, localHeader, packZipProblem, packZipSize, type PackFile } from '../lib/packzip';

export type Plan = { revision: number; files: PackFile[] };

/** 区切りよく読む（投稿の zip を前から順に読むので、まとめて取ると要求が少ない） */
export class WindowReader {
  private start = 0;
  private data: Uint8Array = new Uint8Array(0);
  constructor(private fetchRange: (offset: number, length: number) => Promise<Uint8Array>, private window = 8 * 1024 * 1024) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < this.start || offset + length > this.start + this.data.length) {
      this.start = offset;
      this.data = await this.fetchRange(offset, Math.max(length, this.window));
      if (this.data.length < length) {
        throw new Error('投稿の zip が途中で切れています');
      }
    }
    return this.data.subarray(offset - this.start, offset - this.start + length);
  }
}

export function httpRange(url: string): (offset: number, length: number) => Promise<Uint8Array> {
  return async (offset, length) => {
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`投稿の zip を読めません（${res.status}）`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Range を使わず全体が返ったら切り出す
    return res.status === 200 ? bytes.subarray(offset, offset + length) : bytes;
  };
}

/** 投稿の zip の項目の、圧縮済みの中身（ローカルヘッダの後ろ） */
async function compressedData(reader: WindowReader, f: PackFile): Promise<Uint8Array> {
  const local = await reader.read(f.offset, 30);
  const v = new DataView(local.buffer, local.byteOffset, local.byteLength);
  if (v.getUint32(0, true) !== 0x04034b50) {
    throw new Error(`投稿の zip が壊れています: ${f.path}`);
  }
  const skip = 30 + v.getUint16(26, true) + v.getUint16(28, true);
  return reader.read(f.offset + skip, f.compressedSize);
}

export type BuildEvents = {
  /** 組んだ部分（前から順に、合計で packZipSize になる） */
  write(chunk: Uint8Array): Promise<void>;
  progress?(done: number, total: number, path: string): void;
  signal?: AbortSignal;
};

/** パックの zip を組んで、前から順に write に渡す。読み手は投稿の zip ごとに作る */
export async function buildPack(plan: Plan, events: BuildEvents, readerFor: (source: string) => WindowReader = source => new WindowReader(httpRange(source))): Promise<number> {
  const problem = packZipProblem(plan.files);
  if (problem) {
    throw new Error(problem);
  }
  const readers = new Map<string, WindowReader>();
  const offsets: number[] = [];
  let position = 0;
  for (let i = 0; i < plan.files.length; i++) {
    if (events.signal?.aborted) {
      throw new DOMException('止めました', 'AbortError');
    }
    const f = plan.files[i];
    let reader = readers.get(f.source);
    if (!reader) {
      reader = readerFor(f.source);
      readers.set(f.source, reader);
    }
    const header = localHeader(f);
    const data = await compressedData(reader, f);
    offsets.push(position);
    await events.write(header);
    await events.write(data);
    position += header.length + data.length;
    events.progress?.(i + 1, plan.files.length, f.path);
  }
  const tail = centralDirectory(plan.files, offsets);
  await events.write(tail);
  position += tail.length;
  if (position !== packZipSize(plan.files)) {
    throw new Error('組んだ大きさが合いません');
  }
  return position;
}

/** 書いたものを partSize ずつにまとめて渡す（R2 のマルチパートアップロードは最後以外のパートが同じ大きさ） */
export function partWriter(partSize: number, upload: (part: number, body: Uint8Array) => Promise<void>) {
  let buffer = new Uint8Array(partSize);
  let filled = 0;
  let part = 1;
  return {
    async write(chunk: Uint8Array) {
      let p = 0;
      while (p < chunk.length) {
        const n = Math.min(chunk.length - p, partSize - filled);
        buffer.set(chunk.subarray(p, p + n), filled);
        filled += n;
        p += n;
        if (filled === partSize) {
          await upload(part++, buffer);
          buffer = new Uint8Array(partSize);
          filled = 0;
        }
      }
    },
    async flush() {
      if (filled > 0) {
        await upload(part++, buffer.subarray(0, filled));
        filled = 0;
      }
    },
  };
}
