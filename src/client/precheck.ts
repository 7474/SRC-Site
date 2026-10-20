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
