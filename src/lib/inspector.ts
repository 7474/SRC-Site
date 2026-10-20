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
    // 上がったパートを消す（消し損ねても R2 は完了しないマルチパートアップロードを 7 日で消す）
    if (row.upload_id) {
      await (canPresign(env)
        ? abortMultipartUpload(env, row.r2_key, row.upload_id)
        : env.FILES.resumeMultipartUpload(row.r2_key, row.upload_id).abort()).catch(() => {});
    }
    await env.FILES.delete(row.r2_key);
    await env.DB.prepare("UPDATE versions SET state = 'rejected', inspect_note = 'アップロードが完了しませんでした' WHERE id = ?").bind(row.id).run();
  }
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t).run();
}
