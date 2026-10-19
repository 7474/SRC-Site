// JSON の API（カタログ・投稿）
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { catalog, PLAYABLE_SELECT, type PackRow, type PlayableRow } from '../lib/catalog';
import { canPresign, presignPut, UPLOAD_CONTENT_TYPE } from '../lib/presign';
import { verifyTurnstile } from '../lib/turnstile';
import { now, today } from '../lib/util';
import { canEdit, getScenario, requireUser } from './common';

export const api = new Hono<AppEnv>();

const MAX_FILE = 1024 * 1024 * 1024;
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
  const body = await c.req.json<{ size?: number; sha256?: string; note?: string; turnstile?: string }>().catch(() => ({} as any));
  const size = Number(body.size);
  const sha256 = String(body.sha256 ?? '').toLowerCase();
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE) {
    return c.json({ error: 'zip は 1 GB までです' }, 400);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return c.json({ error: 'sha256 が不正です' }, 400);
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
    `INSERT INTO versions (scenario_id, number, state, r2_key, size, sha256, note, created_at)
     VALUES (?, ?, 'uploading', ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(s.id, number, key, size, sha256, String(body.note ?? '').slice(0, 200) || null, now()).first<{ id: number }>();
  const versionId = row!.id;
  // R2 への署名付き URL を作れれば直接上げる。作れなければ（ローカル開発など）Worker を通す（100 MB まで）
  const uploadUrl = canPresign(c.env) ? await presignPut(c.env, key) : `/api/versions/${versionId}/upload`;
  return c.json({ versionId, number, uploadUrl, contentType: UPLOAD_CONTENT_TYPE });
});

async function ownVersion(c: any, id: string) {
  const v = await c.env.DB.prepare('SELECT v.*, s.slug FROM versions v JOIN scenarios s ON s.id = v.scenario_id WHERE v.id = ?').bind(Number(id)).first();
  if (!v) {
    return null;
  }
  const s = await getScenario(c, v.slug);
  return s && canEdit(c, s) ? v : null;
}

// Worker を通すアップロード（署名付き URL を作れないとき）
api.put('/versions/:id/upload', async c => {
  const v = await ownVersion(c, c.req.param('id'));
  if (!v || v.state !== 'uploading') {
    return c.json({ error: '版がありません' }, 404);
  }
  if (c.req.header('Content-Type') !== UPLOAD_CONTENT_TYPE) {
    return c.json({ error: 'zip を上げてください' }, 415);
  }
  const length = Number(c.req.header('Content-Length'));
  if (length !== v.size || !c.req.raw.body) {
    return c.json({ error: '大きさが申告と違います' }, 400);
  }
  await c.env.FILES.put(v.r2_key, c.req.raw.body.pipeThrough(new FixedLengthStream(length)), { httpMetadata: { contentType: UPLOAD_CONTENT_TYPE } });
  return c.body(null, 200);
});

// アップロードが済んだ。検査に回す
api.post('/versions/:id/complete', async c => {
  const v = await ownVersion(c, c.req.param('id'));
  if (!v) {
    return c.json({ error: '版がありません' }, 404);
  }
  if (v.state === 'uploading') {
    await c.env.DB.prepare("UPDATE versions SET state = 'inspecting' WHERE id = ?").bind(v.id).run();
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
