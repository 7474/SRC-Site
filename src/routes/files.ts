// シナリオ・共有パック・パックへの投稿の zip と、その中のファイルの配信
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { serveObject } from '../lib/serve';
import { entryContentType, extractFile, findArchive, type ArchiveObject, type ArchiveType } from '../lib/archives';
import { canManage, getPack, type Submission } from '../lib/packs';
import { count } from './api';

export const files = new Hono<AppEnv>();

const IMMUTABLE = { 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'same-origin' };

files.on(['GET', 'HEAD'], '/files/scenarios/:slug/:file', async c => {
  const m = /^(\d+)\.zip$/.exec(c.req.param('file'));
  if (!m) {
    return c.notFound();
  }
  const v = await findArchive(c.env.DB, 'scenarios', c.req.param('slug'), m[1]);
  if (!v) {
    return c.notFound();
  }
  return serveObject(c.req.raw, c.env.FILES, v.r2_key, IMMUTABLE);
});

files.on(['GET', 'HEAD'], '/files/packs/:id/:file', async c => {
  const p = await findArchive(c.env.DB, 'packs', c.req.param('id'), c.req.param('file').replace(/\.zip$/, ''));
  if (!p) {
    return c.notFound();
  }
  return serveObject(c.req.raw, c.env.FILES, p.r2_key, IMMUTABLE);
});

// パックへの投稿の zip（投稿した人とパックの管理者だけ。承認者のブラウザが組み直しに読む）と、その中のファイル（プレビュー）
const PRIVATE = { 'Cache-Control': 'private, max-age=0', 'Cross-Origin-Resource-Policy': 'same-origin' };

/** 投稿を見てよいか（投稿した人と、パックの管理者・運営）。検査に通ったものだけ */
export async function visibleSubmission(c: Context<AppEnv>, id: string): Promise<Submission | null> {
  const user = c.get('user');
  const s = await c.env.DB.prepare('SELECT * FROM pack_submissions WHERE id = ?').bind(Number(id)).first<Submission>();
  if (!user || !s || !['pending', 'approved'].includes(s.state)) {
    return null;
  }
  if (s.user_id === user.id) {
    return s;
  }
  const pack = await getPack(c.env.DB, s.pack_id);
  return pack && (await canManage(c.env.DB, user, pack)) ? s : null;
}

files.on(['GET', 'HEAD'], '/files/pack-submissions/:file', async c => {
  const m = /^(\d+)\.zip$/.exec(c.req.param('file'));
  const s = m ? await visibleSubmission(c, m[1]) : null;
  if (!s) {
    return c.notFound();
  }
  return serveObject(c.req.raw, c.env.FILES, s.r2_key, PRIVATE);
});

files.on(['GET', 'HEAD'], '/files/pack-submissions/:id/*', async c => {
  const path = innerPath(c, 4);
  const s = path ? await visibleSubmission(c, c.req.param('id')) : null;
  if (!s) {
    return c.notFound();
  }
  // 投稿の root の下の道で指す（パックの中の道と同じ）
  const response = await extracted(c, s, s.root ? `${s.root}/${path}` : path!, PRIVATE);
  return response.status !== 200 ? response : withRange(c.req.raw, response);
});

// zip の中のファイルを 1 つ返す（データビューアが画像・音・データを読む）。/files/<種類>/<ID>/<版>/<zip の中の道>
// zip の URL と同じく版を含めて不変なので、取り出したものを Cache API に置く（https://developers.cloudflare.com/workers/runtime-apis/cache/）
files.on(['GET', 'HEAD'], '/files/:type{scenarios|packs}/:id/:version/*', async c => {
  const path = innerPath(c, 5);
  if (!path) {
    return c.notFound();
  }
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const key = new Request(c.req.url, { method: 'GET' });
  let full = await cache?.match(key);
  if (!full) {
    const a = await findArchive(c.env.DB, c.req.param('type') as ArchiveType, c.req.param('id'), c.req.param('version'));
    if (!a) {
      return c.notFound();
    }
    full = await extracted(c, a, path, IMMUTABLE);
    if (full.status !== 200) {
      return full;
    }
    if (cache) {
      c.executionCtx.waitUntil(cache.put(key, full.clone()));
    }
  }
  return withRange(c.req.raw, full);
});

/** 道の skip 段目から後ろ（URL デコードしたもの）。不正なら null */
function innerPath(c: Context<AppEnv>, skip: number): string | null {
  try {
    const path = new URL(c.req.url).pathname.split('/').slice(skip).map(decodeURIComponent).join('/');
    return path && !path.split('/').includes('..') ? path : null;
  } catch {
    return null;
  }
}

async function extracted(c: Context<AppEnv>, a: ArchiveObject, path: string, headers: Record<string, string>): Promise<Response> {
  const found = await extractFile(c.env.FILES, a, path);
  if (!found.ok) {
    return c.text(found.status === 413 ? '大きすぎるため取り出せません。zip をダウンロードしてください。' : 'Not Found', found.status);
  }
  return new Response(found.body, {
    headers: {
      ...headers,
      'Content-Type': entryContentType(found.name),
      // 画像・音のほか（テキスト・HTML など）は頁として開かせない
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

/** Range 要求に応える（Safari は音を Range で読む）。全体の応答から切り出す */
async function withRange(request: Request, full: Response): Promise<Response> {
  const body = new Uint8Array(await full.arrayBuffer());
  const headers = new Headers(full.headers);
  headers.set('Accept-Ranges', 'bytes');
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '');
  const ranged = Boolean(m && (m[1] || m[2]));
  let start = 0;
  let end = body.length - 1;
  if (m && ranged) {
    start = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    if (start > end || start >= body.length) {
      headers.set('Content-Range', `bytes */${body.length}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${body.length}`);
  }
  headers.set('Content-Length', String(end - start + 1));
  return new Response(request.method === 'HEAD' ? null : body.subarray(start, end + 1), { status: ranged ? 206 : 200, headers });
}

// 最新の版のダウンロード
files.get('/scenarios/:slug/download', async c => {
  const slug = c.req.param('slug');
  const v = await c.env.DB.prepare(
    `SELECT v.r2_key, v.number FROM scenarios s JOIN versions v ON v.id = s.latest_version
      WHERE s.slug = ? AND v.state = 'published' AND s.hidden = 0 AND s.visibility != 'private'`,
  ).bind(slug).first<{ r2_key: string; number: number }>();
  if (!v) {
    return c.notFound();
  }
  c.executionCtx.waitUntil(count(c.env.DB, slug, 'downloads'));
  return serveObject(c.req.raw, c.env.FILES, v.r2_key, {
    'Content-Disposition': `attachment; filename="${slug}-${v.number}.zip"`,
    'Cache-Control': 'private, max-age=0',
  });
});
