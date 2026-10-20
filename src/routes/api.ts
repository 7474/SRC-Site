// JSON の API（カタログ・投稿）
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { catalog, PLAYABLE_SELECT, type PackRow, type PlayableRow } from '../lib/catalog';
import { verifyTurnstile } from '../lib/turnstile';
import { canPresign, completeMultipartUpload, createMultipartUpload, presignUploadPart, UPLOAD_CONTENT_TYPE } from '../lib/presign';
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
