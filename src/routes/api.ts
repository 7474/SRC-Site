// JSON の API（カタログ・投稿）
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { catalog, packCatalog, PLAYABLE_SELECT, type PackRow, type PlayableRow } from '../lib/catalog';
import { verifyTurnstile } from '../lib/turnstile';
import { abortMultipartUpload, canPresign, completeMultipartUpload, createMultipartUpload, presignUploadPart, UPLOAD_CONTENT_TYPE } from '../lib/presign';
import { parsePackSubmissionInput, type PackSubmissionRow } from '../lib/pack-submissions';
import { now, today } from '../lib/util';
import { canEdit, getScenario, requireUser } from './common';

export const api = new Hono<AppEnv>();

const MAX_FILE = 1024 * 1024 * 1024;
// zip はこの大きさずつ R2 のマルチパートアップロードで上げる。通信が切れたらそのパートだけ上げ直す。
// R2 は最後以外のパートが同じ大きさであることを求める（https://developers.cloudflare.com/r2/objects/multipart-objects/）
// - R2 の S3 互換 API の鍵があれば、ブラウザからパートの署名付き URL へ直接上げる（Worker を通さない）
// - 無ければ（ローカル開発など）Worker を通して上げる（Worker の要求の本体は 100 MB まで）
export const PART_SIZE = 32 * 1024 * 1024;

export function partCount(size: number): number {
  return Math.ceil(size / PART_SIZE);
}

export function partLength(size: number, partNumber: number): number {
  return partNumber < partCount(size) ? PART_SIZE : size - PART_SIZE * (partCount(size) - 1);
}

const MAX_TOTAL_PER_USER = 5 * 1024 * 1024 * 1024;
const MAX_VERSIONS_PER_DAY = 10;

async function packs(db: D1Database): Promise<PackRow[]> {
  return (await db.prepare('SELECT * FROM packs').all<PackRow>()).results;
}

function catalogHeaders(c: { header: (k: string, v: string) => void }) {
  c.header('Cache-Control', 'public, max-age=60');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
}

// SRC#Web が読むカタログ（一覧に出す公開のシナリオ）
api.get('/catalog.json', async c => {
  const rows = (await c.env.DB.prepare(`${PLAYABLE_SELECT} AND s.visibility = 'public' ORDER BY s.updated_at DESC`).all<PlayableRow>()).results;
  catalogHeaders(c);
  return c.json(catalog(c.env.SITE_NAME, rows, await packs(c.env.DB)));
});

// Shared packs available as SRC#Web asset archives.
api.get('/packs.json', async c => {
  const rows = await packs(c.env.DB);
  catalogHeaders(c);
  return c.json(packCatalog(c.env.SITE_NAME, rows));
});

// 1 本だけのカタログ（SRC#Web の ?play= で開くとき。限定公開も含む）
api.get('/catalog/:file', async c => {
  const file = c.req.param('file');
  if (!file.endsWith('.json')) {
    return c.notFound();
  }
  const slug = file.slice(0, -5);
  const row = await c.env.DB.prepare(`${PLAYABLE_SELECT} AND s.visibility != 'private' AND s.slug = ?`).bind(slug).first<PlayableRow>();
  if (!row) {
    return c.json({ error: 'not found' }, 404);
  }
  c.executionCtx.waitUntil(count(c.env.DB, slug, 'plays'));
  catalogHeaders(c);
  c.header('Cache-Control', 'private, max-age=0');
  return c.json(catalog(c.env.SITE_NAME, [row], await packs(c.env.DB)));
});

export async function count(db: D1Database, slug: string, column: 'plays' | 'downloads') {
  await db.prepare(
    `INSERT INTO counters (scenario_id, day, ${column}) SELECT id, ?, 1 FROM scenarios WHERE slug = ?
     ON CONFLICT (scenario_id, day) DO UPDATE SET ${column} = ${column} + 1`,
  ).bind(today(), slug).run();
}

// ── 投稿 ──

api.use('/scenarios/*', requireUser);
api.use('/versions/*', requireUser);
api.use('/pack-submissions', requireUser);
api.use('/pack-submissions/*', requireUser);

api.post('/pack-submissions', async c => {
  const user = c.get('user')!;
  if (!user.terms_accepted_at) {
    return c.json({ error: '利用規約に同意してください（設定の頁）' }, 403);
  }
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: '入力を読み取れません。' }, 400);
  }
  const parsed = parsePackSubmissionInput(body);
  if ('error' in parsed) {
    return c.json({ error: parsed.error }, 400);
  }
  const { input } = parsed;
  const turnstile = (body as Record<string, unknown>).turnstile;
  if (!(await verifyTurnstile(c.env, typeof turnstile === 'string' ? turnstile : undefined, c.req.header('CF-Connecting-IP')))) {
    return c.json({ error: '確認に失敗しました。頁を読み込み直してください' }, 400);
  }
  const unfinished = await c.env.DB.prepare(
    "SELECT id, size FROM pack_submissions WHERE slug = ? AND owner_id = ? AND status = 'uploading'",
  ).bind(input.slug, user.id).first<{ id: number; size: number }>();
  if (unfinished) {
    if (unfinished.size !== input.size) {
      return c.json({ error: '同じ ID のアップロードが残っています。元の zip を選ぶか、時間をおいてください。' }, 409);
    }
    await c.env.DB.prepare(
      `UPDATE pack_submissions SET title = ?, description = ?, source_name = ?, source_url = ?, license = ?, root = ?, excludes_jasrac = 1
        WHERE id = ? AND status = 'uploading'`,
    ).bind(
      input.title, input.description || null, input.sourceName, input.sourceUrl || null,
      input.license, input.root || null, unfinished.id,
    ).run();
    return c.json({ submissionId: unfinished.id, partSize: PART_SIZE, parts: partCount(input.size) });
  }
  const duplicate = await c.env.DB.prepare(
    `SELECT id FROM packs WHERE id = ?
     UNION ALL SELECT id FROM pack_submissions WHERE slug = ? AND status IN ('uploading', 'pending', 'approved') LIMIT 1`,
  ).bind(input.slug, input.slug).first<{ id: number }>();
  if (duplicate) {
    return c.json({ error: 'その ID は使用中か、確認中です。' }, 400);
  }
  const usage = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN r2_key != '' THEN size ELSE 0 END), 0) AS total,
            SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS today
       FROM pack_submissions WHERE owner_id = ?`,
  ).bind(now() - 24 * 3600 * 1000, user.id).first<{ total: number; today: number }>();
  if (user.role !== 'admin') {
    if ((usage?.today ?? 0) >= MAX_VERSIONS_PER_DAY) {
      return c.json({ error: `パックの投稿は 1 日 ${MAX_VERSIONS_PER_DAY} 回までです` }, 429);
    }
    if ((usage?.total ?? 0) + input.size > MAX_TOTAL_PER_USER) {
      return c.json({ error: '投稿できる合計の大きさ（5 GB）を超えます。' }, 400);
    }
  }

  const key = `pack-submissions/${input.slug}/${crypto.randomUUID()}.zip`;
  const uploadId = canPresign(c.env)
    ? await createMultipartUpload(c.env, key)
    : (await c.env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: UPLOAD_CONTENT_TYPE } })).uploadId;
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO pack_submissions
         (slug, owner_id, title, description, source_name, source_url, license, root, excludes_jasrac, size, r2_key, upload_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?) RETURNING id`,
    ).bind(
      input.slug, user.id, input.title, input.description || null, input.sourceName,
      input.sourceUrl || null, input.license, input.root || null, input.size, key, uploadId, now(),
    ).first<{ id: number }>();
    if (!row) {
      throw new Error('パック申請を保存できませんでした。');
    }
    return c.json({ submissionId: row.id, partSize: PART_SIZE, parts: partCount(input.size) });
  } catch (error) {
    try {
      if (canPresign(c.env)) {
        await abortMultipartUpload(c.env, key, uploadId);
      } else {
        await c.env.FILES.resumeMultipartUpload(key, uploadId).abort();
      }
    } catch (cleanupError) {
      console.error('pack submission upload cleanup failed', cleanupError);
    }
    throw error;
  }
});

async function ownPackSubmission(c: Context<AppEnv>, id: string): Promise<PackSubmissionRow | null> {
  const submissionId = Number(id);
  if (!Number.isInteger(submissionId) || submissionId <= 0) {
    return null;
  }
  return c.env.DB.prepare('SELECT * FROM pack_submissions WHERE id = ? AND owner_id = ?')
    .bind(submissionId, c.get('user')!.id).first<PackSubmissionRow>();
}

async function uploadingPackPart(c: Context<AppEnv>): Promise<{ submission: PackSubmissionRow; uploadId: string; part: number } | Response> {
  const submission = await ownPackSubmission(c, c.req.param('id'));
  const uploadId = submission?.upload_id;
  if (!submission || submission.status !== 'uploading' || !uploadId) {
    return c.json({ error: 'パック申請がありません' }, 404);
  }
  const part = Number(c.req.param('part'));
  if (!Number.isInteger(part) || part < 1 || part > partCount(submission.size)) {
    return c.json({ error: 'パートの番号が不正です' }, 400);
  }
  return { submission, uploadId, part };
}

api.get('/pack-submissions/:id/parts/:part', async c => {
  const found = await uploadingPackPart(c);
  if (found instanceof Response) {
    return found;
  }
  const { submission, uploadId, part } = found;
  if (canPresign(c.env)) {
    return c.json({
      url: await presignUploadPart(c.env, submission.r2_key, uploadId, part),
      direct: true,
      length: partLength(submission.size, part),
    });
  }
  return c.json({
    url: `/api/pack-submissions/${submission.id}/parts/${part}`,
    direct: false,
    length: partLength(submission.size, part),
  });
});

api.put('/pack-submissions/:id/parts/:part', async c => {
  if (canPresign(c.env)) {
    return c.json({ error: 'パートは R2 へ直接上げてください' }, 400);
  }
  const found = await uploadingPackPart(c);
  if (found instanceof Response) {
    return found;
  }
  const { submission, uploadId, part } = found;
  const length = Number(c.req.header('Content-Length'));
  if (length !== partLength(submission.size, part) || !c.req.raw.body) {
    return c.json({ error: '大きさが申告と違います' }, 400);
  }
  const upload = c.env.FILES.resumeMultipartUpload(submission.r2_key, uploadId);
  const uploaded = await upload.uploadPart(part, c.req.raw.body.pipeThrough(new FixedLengthStream(length)));
  return c.json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
});

api.post('/pack-submissions/:id/complete', async c => {
  const submission = await ownPackSubmission(c, c.req.param('id'));
  if (!submission) {
    return c.json({ error: 'パック申請がありません' }, 404);
  }
  if (submission.status !== 'uploading') {
    return c.json({ state: submission.status });
  }
  if (!submission.upload_id) {
    return c.json({ error: 'アップロードを再開できません。' }, 409);
  }
  const body: { parts?: { partNumber: number; etag: string }[] } = await c.req.json<{ parts?: { partNumber: number; etag: string }[] }>()
    .catch((): { parts?: { partNumber: number; etag: string }[] } => ({}));
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (parts.length !== partCount(submission.size) || parts.some((p, i) =>
    !p || p.partNumber !== i + 1 || typeof p.etag !== 'string')) {
    return c.json({ error: 'パートが揃っていません' }, 400);
  }
  try {
    if (canPresign(c.env)) {
      await completeMultipartUpload(c.env, submission.r2_key, submission.upload_id, parts);
    } else {
      await c.env.FILES.resumeMultipartUpload(submission.r2_key, submission.upload_id).complete(parts);
    }
  } catch (error) {
    return c.json({ error: `アップロードを完了できません（${String((error as Error).message ?? error)}）` }, 400);
  }
  const head = await c.env.FILES.head(submission.r2_key);
  if (!head || head.size !== submission.size) {
    return c.json({ error: '大きさが申告と違います' }, 400);
  }
  const partsInEtag = head.etag.match(/-(\d+)$/)?.[1];
  if (partsInEtag && Number(partsInEtag) !== parts.length) {
    return c.json({ error: 'パートの数が合いません' }, 400);
  }
  await c.env.DB.prepare(
    "UPDATE pack_submissions SET status = 'pending', upload_id = NULL WHERE id = ? AND status = 'uploading'",
  ).bind(submission.id).run();
  return c.json({ state: 'pending' });
});

api.get('/pack-submissions/:id', async c => {
  const submission = await ownPackSubmission(c, c.req.param('id'));
  if (!submission) {
    return c.json({ error: 'パック申請がありません' }, 404);
  }
  return c.json({ id: submission.id, slug: submission.slug, status: submission.status, reviewNote: submission.review_note });
});

// 版を作り、アップロード先を返す
api.post('/scenarios/:slug/versions', async c => {
  const user = c.get('user')!;
  const s = await getScenario(c, c.req.param('slug'));
  if (!s || !canEdit(c, s)) {
    return c.json({ error: 'シナリオがありません' }, 404);
  }
  if (!user.terms_accepted_at) {
    return c.json({ error: '利用規約に同意してください（設定の頁）' }, 403);
  }
  const body = await c.req.json<{ size?: number; note?: string; turnstile?: string }>().catch(() => ({} as any));
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE) {
    return c.json({ error: 'zip は 1 GB までです' }, 400);
  }
  if (!(await verifyTurnstile(c.env, body.turnstile, c.req.header('CF-Connecting-IP')))) {
    return c.json({ error: '確認に失敗しました。頁を読み込み直してください' }, 400);
  }
  const usage = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(v.size), 0) AS total,
            SUM(CASE WHEN v.created_at > ? THEN 1 ELSE 0 END) AS today
       FROM versions v JOIN scenarios s ON s.id = v.scenario_id
      WHERE s.owner_id = ? AND v.state IN ('uploading', 'inspecting', 'published')`,
  ).bind(now() - 24 * 3600 * 1000, user.id).first<{ total: number; today: number }>();
  if (user.role !== 'admin') {
    if ((usage?.today ?? 0) >= MAX_VERSIONS_PER_DAY) {
      return c.json({ error: `版の作成は 1 日 ${MAX_VERSIONS_PER_DAY} 回までです` }, 429);
    }
    if ((usage?.total ?? 0) + size > MAX_TOTAL_PER_USER) {
      return c.json({ error: '投稿できる合計の大きさ（5 GB）を超えます。古い版を消してください' }, 400);
    }
  }
  const next = await c.env.DB.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM versions WHERE scenario_id = ?').bind(s.id).first<{ n: number }>();
  const number = next!.n;
  const key = `scenarios/${s.slug}/${number}.zip`;
  const row = await c.env.DB.prepare(
    // 中身のハッシュは計算しない。完了したときの R2 の ETag を記録する（complete）
    `INSERT INTO versions (scenario_id, number, state, r2_key, size, etag, note, created_at)
     VALUES (?, ?, 'uploading', ?, ?, '', ?, ?) RETURNING id`,
  ).bind(s.id, number, key, size, String(body.note ?? '').slice(0, 200) || null, now()).first<{ id: number }>();
  const versionId = row!.id;
  // https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/
  const uploadId = canPresign(c.env)
    ? await createMultipartUpload(c.env, key)
    : (await c.env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: UPLOAD_CONTENT_TYPE } })).uploadId;
  await c.env.DB.prepare('UPDATE versions SET upload_id = ? WHERE id = ?').bind(uploadId, versionId).run();
  return c.json({ versionId, number, partSize: PART_SIZE, parts: partCount(size) });
});

async function ownVersion(c: any, id: string) {
  const v = await c.env.DB.prepare('SELECT v.*, s.slug FROM versions v JOIN scenarios s ON s.id = v.scenario_id WHERE v.id = ?').bind(Number(id)).first();
  if (!v) {
    return null;
  }
  const s = await getScenario(c, v.slug);
  return s && canEdit(c, s) ? v : null;
}

async function uploadingPart(c: any): Promise<{ v: any; part: number } | Response> {
  const v = await ownVersion(c, c.req.param('id'));
  if (!v || v.state !== 'uploading' || !v.upload_id) {
    return c.json({ error: '版がありません' }, 404);
  }
  const part = Number(c.req.param('part'));
  if (!Number.isInteger(part) || part < 1 || part > partCount(v.size)) {
    return c.json({ error: 'パートの番号が不正です' }, 400);
  }
  return { v, part };
}

// パートの上げ先。応答: url（PUT する先）、direct（R2 へ直接か。直接なら応答の ETag ヘッダを、Worker を通すなら応答の JSON の etag を完了に渡す）
// 上げ直すときも取り直す（署名付き URL は 15 分で切れる）
api.get('/versions/:id/parts/:part', async c => {
  const found = await uploadingPart(c);
  if (found instanceof Response) {
    return found;
  }
  const { v, part } = found;
  if (canPresign(c.env)) {
    return c.json({ url: await presignUploadPart(c.env, v.r2_key, v.upload_id, part), direct: true, length: partLength(v.size, part) });
  }
  return c.json({ url: `/api/versions/${v.id}/parts/${part}`, direct: false, length: partLength(v.size, part) });
});

// Worker を通してパートを 1 つ上げる（R2 の S3 互換 API の鍵が無いとき）。同じパートを上げ直してもよい
api.put('/versions/:id/parts/:part', async c => {
  if (canPresign(c.env)) {
    return c.json({ error: 'パートは R2 へ直接上げてください' }, 400);
  }
  const found = await uploadingPart(c);
  if (found instanceof Response) {
    return found;
  }
  const { v, part } = found;
  const length = Number(c.req.header('Content-Length'));
  if (length !== partLength(v.size, part) || !c.req.raw.body) {
    return c.json({ error: '大きさが申告と違います' }, 400);
  }
  const upload = c.env.FILES.resumeMultipartUpload(v.r2_key, v.upload_id);
  const uploaded = await upload.uploadPart(part, c.req.raw.body.pipeThrough(new FixedLengthStream(length)));
  return c.json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
});

// アップロードが済んだ。検査に回す
api.post('/versions/:id/complete', async c => {
  const v = await ownVersion(c, c.req.param('id'));
  if (!v) {
    return c.json({ error: '版がありません' }, 404);
  }
  if (v.state === 'uploading') {
    const body = await c.req.json<{ parts?: { partNumber: number; etag: string }[] }>().catch(() => ({} as any));
    const parts = Array.isArray(body.parts) ? body.parts : [];
    if (parts.length !== partCount(v.size) || parts.some((p: any, i: number) => p?.partNumber !== i + 1 || typeof p?.etag !== 'string')) {
      return c.json({ error: 'パートが揃っていません' }, 400);
    }
    try {
      if (canPresign(c.env)) {
        await completeMultipartUpload(c.env, v.r2_key, v.upload_id, parts);
      } else {
        await c.env.FILES.resumeMultipartUpload(v.r2_key, v.upload_id).complete(parts);
      }
    } catch (e) {
      return c.json({ error: `アップロードを完了できません（${String((e as Error).message ?? e)}）` }, 400);
    }
    // 軽い確かめ: 大きさが申告どおりか、ETag の末尾のパートの数（マルチパートの ETag は「…-パートの数」）が合うか
    const head = await c.env.FILES.head(v.r2_key);
    if (!head || head.size !== v.size) {
      return c.json({ error: '大きさが申告と違います' }, 400);
    }
    const partsInEtag = head.etag.match(/-(\d+)$/)?.[1];
    if (partsInEtag && Number(partsInEtag) !== parts.length) {
      return c.json({ error: 'パートの数が合いません' }, 400);
    }
    await c.env.DB.prepare("UPDATE versions SET state = 'inspecting', upload_id = NULL, etag = ? WHERE id = ?").bind(head.etag, v.id).run();
    await c.env.INSPECT.send({ versionId: v.id });
  }
  return c.json({ state: v.state === 'uploading' ? 'inspecting' : v.state });
});

api.get('/versions/:id', async c => {
  const v = await ownVersion(c, c.req.param('id'));
  if (!v) {
    return c.json({ error: '版がありません' }, 404);
  }
  return c.json({ id: v.id, number: v.number, state: v.state, note: v.inspect_note, slug: v.slug });
});
