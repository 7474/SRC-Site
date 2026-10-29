// 利用者が作る共有パック（packs.kind = 'community'）と、パックへの投稿（docs/resources.md）
import type { Bindings, User } from '../env';
import type { PackFile } from './packzip';
import { now } from './util';

export type CommunityPack = {
  id: string; title: string; description: string | null; license: string; policy: string | null; kind: string;
  owner_id: number | null; accepts: string; revision: number; built_revision: number;
  version: string; r2_key: string; size: number; withdrawn: number; is_default: number; priority: number; updated_at: number;
  source_name: string; source_url: string | null;
};

export type Submission = {
  id: number; pack_id: string; user_id: number; title: string; author: string | null; license: string | null; state: string;
  r2_key: string; size: number; etag: string | null; upload_id: string | null; root: string | null; manifest: string | null;
  inspect_note: string | null; review_note: string | null; reviewed_by: number | null; reviewed_at: number | null; created_at: number;
};

export async function getPack(db: D1Database, id: string): Promise<CommunityPack | null> {
  return db.prepare('SELECT * FROM packs WHERE id = ?').bind(id).first<CommunityPack>();
}

/** パックを管理できるか（運営、またはパックの管理者。利用者が作ったパックだけ） */
export async function canManage(db: D1Database, user: User | null, pack: Pick<CommunityPack, 'id' | 'kind'>): Promise<boolean> {
  if (!user || user.suspended) {
    return false;
  }
  if (user.role === 'admin') {
    return true;
  }
  if (pack.kind !== 'community') {
    return false;
  }
  return Boolean(await db.prepare('SELECT 1 FROM pack_managers WHERE pack_id = ? AND user_id = ?').bind(pack.id, user.id).first());
}

/** パックに投稿できるか（accepts = 'managers' なら管理者だけ） */
export async function canSubmit(db: D1Database, user: User | null, pack: CommunityPack): Promise<boolean> {
  if (!user || user.suspended || !user.terms_accepted_at || pack.kind !== 'community' || pack.withdrawn) {
    return false;
  }
  return pack.accepts === 'anyone' || canManage(db, user, pack);
}

/** 投稿の zip の URL（承認者のブラウザが組み直しに読む） */
export const submissionZipUrl = (id: number) => `/files/pack-submissions/${id}.zip`;

/** パックに入れるファイル（承認したもの）。投稿の zip の中の並び順に */
export async function activeFiles(db: D1Database, packId: string): Promise<PackFile[]> {
  const rows = (await db.prepare(
    `SELECT submission_id, path, size, compressed_size, crc32, method, offset FROM pack_files
      WHERE pack_id = ? AND state = 'active' ORDER BY submission_id, offset`,
  ).bind(packId).all<{ submission_id: number; path: string; size: number; compressed_size: number; crc32: number; method: number; offset: number }>()).results;
  return rows.map(r => ({
    path: r.path, size: r.size, compressedSize: r.compressed_size, crc32: r.crc32, method: r.method, offset: r.offset, source: submissionZipUrl(r.submission_id),
  }));
}

/**
 * 承認する。この投稿のファイルを active にし、同じ道（大文字小文字を区別しない）の前のファイルは replaced にする。
 * パックの revision を上げる（zip には承認者のブラウザが反映する）
 */
export async function approve(db: D1Database, s: Submission, reviewer: User): Promise<void> {
  await db.batch([
    db.prepare(
      `UPDATE pack_files SET state = 'replaced'
        WHERE pack_id = ?1 AND state = 'active' AND lower(path) IN (SELECT lower(path) FROM pack_files WHERE submission_id = ?2)`,
    ).bind(s.pack_id, s.id),
    db.prepare("UPDATE pack_files SET state = 'active' WHERE submission_id = ? AND state = 'pending'").bind(s.id),
    db.prepare("UPDATE pack_submissions SET state = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(reviewer.id, now(), s.id),
    db.prepare('UPDATE packs SET revision = revision + 1, updated_at = ? WHERE id = ?').bind(now(), s.pack_id),
  ]);
}

/** 却下する（承認待ちだけ）。投稿の zip は消す */
export async function reject(env: Bindings, s: Submission, reviewer: User | null, note: string | null, state: 'rejected' | 'withdrawn' = 'rejected'): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE pack_files SET state = 'rejected' WHERE submission_id = ?").bind(s.id),
    env.DB.prepare('UPDATE pack_submissions SET state = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
      .bind(state, note, reviewer?.id ?? null, now(), s.id),
  ]);
  await env.FILES.delete(s.r2_key);
}

/** パックからファイルを外す（道を指定、または投稿ごと） */
export async function removeFiles(db: D1Database, packId: string, target: { path: string } | { submissionId: number }): Promise<number> {
  const result = 'path' in target
    ? await db.prepare("UPDATE pack_files SET state = 'removed' WHERE pack_id = ? AND state = 'active' AND lower(path) = lower(?)").bind(packId, target.path).run()
    : await db.prepare("UPDATE pack_files SET state = 'removed' WHERE pack_id = ? AND state = 'active' AND submission_id = ?").bind(packId, target.submissionId).run();
  const changed = result.meta.changes ?? 0;
  if (changed > 0) {
    await db.prepare('UPDATE packs SET revision = revision + 1, updated_at = ? WHERE id = ?').bind(now(), packId).run();
  }
  return changed;
}

/** パックの zip に反映した後、ファイルが 1 つも残っていない投稿の zip を消す（組み直しに要らない） */
export async function retireSubmissions(env: Bindings, packId: string): Promise<void> {
  const rows = (await env.DB.prepare(
    `SELECT id, r2_key FROM pack_submissions s
      WHERE pack_id = ? AND state = 'approved'
        AND NOT EXISTS (SELECT 1 FROM pack_files f WHERE f.submission_id = s.id AND f.state = 'active')`,
  ).bind(packId).all<{ id: number; r2_key: string }>()).results;
  for (const row of rows) {
    await env.FILES.delete(row.r2_key);
    await env.DB.prepare("UPDATE pack_submissions SET state = 'retired' WHERE id = ?").bind(row.id).run();
  }
}
