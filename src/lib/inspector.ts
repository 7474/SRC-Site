// 投稿された版の検査（Queues の consumer と、取りこぼしを拾う cron から呼ぶ）
import type { Bindings } from '../env';
import { inspect, r2Reader, readEntries, ZipError } from './zip';
import { abortMultipartUpload, canPresign } from './presign';
import { now } from './util';

type VersionRow = { id: number; scenario_id: number; number: number; state: string; r2_key: string; size: number };

export async function inspectVersion(env: Bindings, versionId: number): Promise<void> {
  const v = await env.DB.prepare('SELECT id, scenario_id, number, state, r2_key, size FROM versions WHERE id = ?')
    .bind(versionId).first<VersionRow>();
  if (!v || v.state !== 'inspecting') {
    return;
  }
  const reject = async (reason: string) => {
    await env.DB.prepare("UPDATE versions SET state = 'rejected', inspect_note = ? WHERE id = ?").bind(reason, v.id).run();
    await env.FILES.delete(v.r2_key);
  };
  const head = await env.FILES.head(v.r2_key);
  if (!head) {
    await reject('ファイルが届いていません');
    return;
  }
  if (head.size !== v.size) {
    await reject(`大きさが申告（${v.size}）と違います（${head.size}）`);
    return;
  }
  let result;
  try {
    result = inspect(await readEntries(r2Reader(env.FILES, v.r2_key, head.size)));
  } catch (e) {
    if (e instanceof ZipError) {
      await reject(e.message);
      return;
    }
    throw e;
  }
  if (!result.ok) {
    await reject(result.reason);
    return;
  }
  const t = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE versions SET state = 'published', manifest = ?, published_at = ?,
              root = COALESCE(root, ?), eve = COALESCE(eve, ?), inspect_note = NULL
        WHERE id = ?`,
    ).bind(JSON.stringify(result.manifest), t, result.root, result.eve, v.id),
    // 公開した最新の版にする（あとから古い版の検査が済んでも戻さない）
    env.DB.prepare(
      `UPDATE scenarios SET latest_version = ?, updated_at = ?
        WHERE id = ? AND (latest_version IS NULL
              OR (SELECT number FROM versions WHERE id = scenarios.latest_version) < ?)`,
    ).bind(v.id, t, v.scenario_id, v.number),
  ]);
}

type SubmissionRow = { id: number; pack_id: string; state: string; r2_key: string; size: number };

/** パックへの投稿の検査。合格したら目次からファイルの行（pack_files）を作り、承認待ちにする */
export async function inspectSubmission(env: Bindings, submissionId: number): Promise<void> {
  const s = await env.DB.prepare('SELECT id, pack_id, state, r2_key, size FROM pack_submissions WHERE id = ?').bind(submissionId).first<SubmissionRow>();
  if (!s || s.state !== 'inspecting') {
    return;
  }
  const reject = async (reason: string) => {
    await env.DB.prepare("UPDATE pack_submissions SET state = 'rejected', inspect_note = ? WHERE id = ?").bind(reason, s.id).run();
    await env.FILES.delete(s.r2_key);
  };
  const head = await env.FILES.head(s.r2_key);
  if (!head || head.size !== s.size) {
    await reject('ファイルが届いていないか、大きさが申告と違います');
    return;
  }
  let entries;
  let result;
  try {
    entries = await readEntries(r2Reader(env.FILES, s.r2_key, head.size));
    result = inspect(entries, 'resource');
  } catch (e) {
    if (e instanceof ZipError) {
      await reject(e.message);
      return;
    }
    throw e;
  }
  if (!result.ok) {
    await reject(result.reason);
    return;
  }
  const root = result.root;
  const files = entries.filter(e => !e.directory).map(e => {
    const name = e.name.replace(/\\/g, '/');
    return { ...e, path: root ? name.slice(root.length + 1) : name };
  });
  const seen = new Set<string>();
  const duplicate = files.find(f => seen.size === seen.add(f.path.toLowerCase()).size);
  if (duplicate) {
    return reject(`同じ名前のファイルが 2 つあります（大文字小文字を区別しない）: ${duplicate.path}`);
  }
  if (files.some(f => f.method !== 0 && f.method !== 8)) {
    await reject('対応していない圧縮方式のファイルがあります（無圧縮か deflate にしてください）');
    return;
  }
  // D1 の 1 文の変数は 100 個まで。8 列 × 12 行ずつ入れる（再試行に備えて先に消す）
  const statements = [env.DB.prepare('DELETE FROM pack_files WHERE submission_id = ?').bind(s.id)];
  for (let i = 0; i < files.length; i += 12) {
    const rows = files.slice(i, i + 12);
    statements.push(env.DB.prepare(
      `INSERT INTO pack_files (pack_id, submission_id, path, size, compressed_size, crc32, method, offset) VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    ).bind(...rows.flatMap(f => [s.pack_id, s.id, f.path, f.size, f.compressedSize, f.crc32, f.method, f.offset])));
  }
  statements.push(env.DB.prepare("UPDATE pack_submissions SET state = 'pending', root = ?, manifest = ?, inspect_note = NULL WHERE id = ?")
    .bind(root, JSON.stringify(result.manifest), s.id));
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
}

/** cron: 検査の取りこぼし（5 分以上 inspecting のもの）を拾い、届かなかった版（1 日以上 uploading）を片付ける */
export async function sweep(env: Bindings): Promise<void> {
  const t = now();
  const stuck = await env.DB.prepare("SELECT id FROM versions WHERE state = 'inspecting' AND created_at < ? LIMIT 20")
    .bind(t - 5 * 60 * 1000).all<{ id: number }>();
  for (const row of stuck.results) {
    await env.INSPECT.send({ versionId: row.id });
  }
  const abandoned = await env.DB.prepare("SELECT id, r2_key, upload_id FROM versions WHERE state = 'uploading' AND created_at < ? LIMIT 100")
    .bind(t - 24 * 3600 * 1000).all<{ id: number; r2_key: string; upload_id: string | null }>();
  for (const row of abandoned.results) {
    await abort(env, row.r2_key, row.upload_id);
    await env.DB.prepare("UPDATE versions SET state = 'rejected', inspect_note = 'アップロードが完了しませんでした' WHERE id = ?").bind(row.id).run();
  }
  const stuckSubmissions = await env.DB.prepare("SELECT id FROM pack_submissions WHERE state = 'inspecting' AND created_at < ? LIMIT 20")
    .bind(t - 5 * 60 * 1000).all<{ id: number }>();
  for (const row of stuckSubmissions.results) {
    await env.INSPECT.send({ submissionId: row.id });
  }
  // 届かなかった投稿・組み直し
  for (const table of ['pack_submissions', 'pack_builds'] as const) {
    const rows = await env.DB.prepare(`SELECT id, r2_key, upload_id FROM ${table} WHERE state = 'uploading' AND created_at < ? LIMIT 100`)
      .bind(t - 24 * 3600 * 1000).all<{ id: number; r2_key: string; upload_id: string | null }>();
    for (const row of rows.results) {
      await abort(env, row.r2_key, row.upload_id);
      await env.DB.prepare(`UPDATE ${table} SET state = 'rejected', upload_id = NULL WHERE id = ?`).bind(row.id).run();
    }
  }
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t).run();
}

/** 上がったパートと、届いたものを消す（消し損ねても R2 は完了しないマルチパートアップロードを 7 日で消す） */
async function abort(env: Bindings, key: string, uploadId: string | null) {
  if (uploadId) {
    await (canPresign(env)
      ? abortMultipartUpload(env, key, uploadId)
      : env.FILES.resumeMultipartUpload(key, uploadId).abort()).catch(() => {});
  }
  await env.FILES.delete(key);
}
