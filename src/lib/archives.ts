// 公開している zip（シナリオ・共有パック）とパックへの投稿の中のファイルを、1 つずつ返す（データビューア・投稿のプレビューが読む。docs/resources.md）
import { findEntry, extractEntry, r2Reader, readEntries, ZipError, type ZipEntry } from './zip';

/** 道の種類。scenarios はシナリオの版、packs は共有パック（サイトのもの・利用者が作ったもの） */
export type ArchiveType = 'scenarios' | 'packs';

export type ArchiveObject = { r2_key: string; size: number };

/**
 * 公開している zip を探す。シナリオは版の番号、パックは版（packs.version）で指す。
 * 見せないもの（非公開・運営が止めた・取り下げた・検査前）は null
 */
export async function findArchive(db: D1Database, type: ArchiveType, id: string, version: string): Promise<ArchiveObject | null> {
  if (type === 'packs') {
    return db.prepare("SELECT r2_key, size FROM packs WHERE id = ? AND version = ? AND withdrawn = 0 AND r2_key != ''")
      .bind(id, version).first<ArchiveObject>();
  }
  if (!/^\d+$/.test(version)) {
    return null;
  }
  return db.prepare(
    `SELECT v.r2_key, v.size FROM versions v JOIN scenarios s ON s.id = v.scenario_id
      WHERE s.slug = ? AND v.number = ? AND v.state = 'published' AND s.hidden = 0 AND s.visibility != 'private'`,
  ).bind(id, Number(version)).first<ArchiveObject>();
}

export async function listEntries(bucket: R2Bucket, a: ArchiveObject): Promise<ZipEntry[]> {
  return readEntries(r2Reader(bucket, a.r2_key, a.size));
}

// 取り出すファイルの大きさの上限（Worker のメモリ 128 MB の中で展開する）
export const MAX_EXTRACT = 32 * 1024 * 1024;

// 返してよい種類。ほかは application/octet-stream で、ブラウザに中身を解釈させない（投稿された HTML・SVG を同じオリジンで動かさない）
const MEDIA_TYPES: Record<string, string> = {
  '.bmp': 'image/bmp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mid': 'audio/midi', '.midi': 'audio/midi',
};

export function entryContentType(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return MEDIA_TYPES[ext] ?? 'application/octet-stream';
}

export type Extracted = { ok: true; body: Uint8Array; name: string } | { ok: false; status: 404 | 413 };

export async function extractFile(bucket: R2Bucket, a: ArchiveObject, path: string): Promise<Extracted> {
  const reader = r2Reader(bucket, a.r2_key, a.size);
  const entry = findEntry(await readEntries(reader), path);
  if (!entry || entry.encrypted) {
    return { ok: false, status: 404 };
  }
  if (entry.size > MAX_EXTRACT) {
    return { ok: false, status: 413 };
  }
  try {
    return { ok: true, body: await extractEntry(reader, entry), name: entry.name };
  } catch (e) {
    if (e instanceof ZipError) {
      return { ok: false, status: 404 };
    }
    throw e;
  }
}
