// JSON の API（カタログ・投稿）
import { Hono } from 'hono';
import type { AppEnv, User } from '../env';
import { catalog, packSettings, PLAYABLE_SELECT, type PackRow, type PlayableRow } from '../lib/catalog';
import { verifyTurnstile } from '../lib/turnstile';
import { canPresign } from '../lib/presign';
import { finishUpload, PART_SIZE, partCount, partTarget, putPart, startUpload, validPart } from '../lib/multipart';
import { now, today } from '../lib/util';
import { canEdit, getScenario, requireUser } from './common';

export const api = new Hono<AppEnv>();

export const MAX_FILE = 1024 * 1024 * 1024;

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
  const body = await c.req.json<{ size?: number; note?: string; packs?: unknown; turnstile?: string }>().catch(() => ({} as any));
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE) {
    return c.json({ error: 'zip は 1 GB までです' }, 400);
  }
  if (!(await verifyTurnstile(c.env, body.turnstile, c.req.header('CF-Connecting-IP')))) {
    return c.json({ error: '確認に失敗しました。頁を読み込み直してください' }, 400);
  }
  const over = await overQuota(c.env.DB, user, size);
  if (over) {
    return c.json({ error: over.error }, over.status);
  }
  const next = await c.env.DB.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM versions WHERE scenario_id = ?').bind(s.id).first<{ n: number }>();
  const number = next!.n;
  const key = `scenarios/${s.slug}/${number}.zip`;
  const row = await c.env.DB.prepare(
    // 中身のハッシュは計算しない。完了したときの R2 の ETag を記録する（complete）
    // 一緒に使う共有パック（requires・excludes）は前の版から引き継ぐ（公開した版があればその最新、なければ最新の版）
    `INSERT INTO versions (scenario_id, number, state, r2_key, size, etag, note, created_at, requires, excludes)
     SELECT ?1, ?2, 'uploading', ?3, ?4, '', ?5, ?6, COALESCE(p.requires, '[]'), COALESCE(p.excludes, '[]')
       FROM (SELECT 1) LEFT JOIN (
         SELECT requires, excludes FROM versions WHERE scenario_id = ?1
          ORDER BY CASE WHEN state = 'published' THEN 0 ELSE 1 END, number DESC LIMIT 1
       ) p
     RETURNING id`,
  ).bind(s.id, number, key, size, String(body.note ?? '').slice(0, 200) || null, now()).first<{ id: number }>();
  const versionId = row!.id;
  // 上げる画面で選んだパック（送られたとき）。選べるのは zip のあるパック（編集の頁に出すもの）だけ
  if (Array.isArray(body.packs)) {
    const packs = (await c.env.DB.prepare("SELECT id, is_default FROM packs WHERE withdrawn = 0 AND r2_key != ''").all<{ id: string; is_default: number }>()).results;
    const { requires, excludes } = packSettings(packs, body.packs.map(String));
    await c.env.DB.prepare('UPDATE versions SET requires = ?, excludes = ? WHERE id = ?').bind(JSON.stringify(requires), JSON.stringify(excludes), versionId).run();
  }
  const uploadId = await startUpload(c.env, key);
  await c.env.DB.prepare('UPDATE versions SET upload_id = ? WHERE id = ?').bind(uploadId, versionId).run();
  return c.json({ id: versionId, versionId, number, partSize: PART_SIZE, parts: partCount(size), partsBase: `/api/versions/${versionId}` });
});

/**
 * 投稿の回数・合計の大きさの上限（シナリオの版とパックへの投稿を合わせて数える）。超えていれば理由。運営は数えない
 */
export async function overQuota(db: D1Database, user: User, size: number): Promise<{ error: string; status: 400 | 429 } | null> {
  if (user.role === 'admin') {
    return null;
  }
  const usage = await db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS total, SUM(CASE WHEN created_at > ?1 THEN 1 ELSE 0 END) AS today FROM (
       SELECT v.size, v.created_at FROM versions v JOIN scenarios s ON s.id = v.scenario_id
        WHERE s.owner_id = ?2 AND v.state IN ('uploading', 'inspecting', 'published')
       UNION ALL
       SELECT size, created_at FROM pack_submissions WHERE user_id = ?2 AND state IN ('uploading', 'inspecting', 'pending', 'approved'))`,
  ).bind(now() - 24 * 3600 * 1000, user.id).first<{ total: number; today: number }>();
  if ((usage?.today ?? 0) >= MAX_VERSIONS_PER_DAY) {
    return { error: `投稿は 1 日 ${MAX_VERSIONS_PER_DAY} 回までです`, status: 429 };
  }
  if ((usage?.total ?? 0) + size > MAX_TOTAL_PER_USER) {
    return { error: '投稿できる合計の大きさ（5 GB）を超えます。古い版を消してください', status: 400 };
  }
  return null;
}

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
  if (!validPart(v, part)) {
    return c.json({ error: 'パートの番号が不正です' }, 400);
  }
  return { v, part };
}

// パートの上げ先。上げ直すときも取り直す（署名付き URL は 15 分で切れる）
api.get('/versions/:id/parts/:part', async c => {
  const found = await uploadingPart(c);
  if (found instanceof Response) {
    return found;
  }
  return c.json(await partTarget(c.env, found.v, found.part, `/api/versions/${found.v.id}/parts/${found.part}`));
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
  const uploaded = await putPart(c.env, found.v, found.part, c.req.raw);
  return uploaded ? c.json(uploaded) : c.json({ error: '大きさが申告と違います' }, 400);
});

// アップロードが済んだ。検査に回す
api.post('/versions/:id/complete', async c => {
  const v = await ownVersion(c, c.req.param('id'));
  if (!v) {
    return c.json({ error: '版がありません' }, 404);
  }
  if (v.state === 'uploading') {
    const done = await finishUpload(c.env, v, await c.req.json().catch(() => ({})));
    if (!done.ok) {
      return c.json({ error: done.error }, 400);
    }
    await c.env.DB.prepare("UPDATE versions SET state = 'inspecting', upload_id = NULL, etag = ? WHERE id = ?").bind(done.etag, v.id).run();
    await c.env.INSPECT.send({ versionId: v.id });
  }
  return c.json({ state: v.state === 'uploading' ? 'inspecting' : v.state });
});

api.get('/versions/:id', async c => {
  const v = await ownVersion(c, c.req.param('id'));
  if (!v) {
    return c.json({ error: '版がありません' }, 404);
  }
  return c.json({
    id: v.id, number: v.number, state: v.state, note: v.inspect_note, slug: v.slug,
    done: v.state === 'published', message: `第 ${v.number} 版を公開しました。`, href: `/my/scenarios/${encodeURIComponent(v.slug)}?saved=1`,
  });
});
