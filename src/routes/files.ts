// シナリオ・共有パックの zip の配信
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { serveObject } from '../lib/serve';
import { entryContentType, extractFile, findArchive, type ArchiveType } from '../lib/archives';
import { count } from './api';

export const files = new Hono<AppEnv>();

const IMMUTABLE = { 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'same-origin' };

// シナリオと投稿した素材の版の zip（素材は /files/resources/ の下）
files.on(['GET', 'HEAD'], '/files/:type{scenarios|resources}/:slug/:file', async c => {
  const m = /^(\d+)\.zip$/.exec(c.req.param('file'));
  if (!m) {
    return c.notFound();
  }
  const v = await findArchive(c.env.DB, c.req.param('type') as ArchiveType, c.req.param('slug'), m[1]);
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

// zip の中のファイルを 1 つ返す（データビューアが画像・音・データを読む）。/files/<種類>/<ID>/<版>/<zip の中の道>
// zip の URL と同じく版を含めて不変なので、取り出したものを Cache API に置く（https://developers.cloudflare.com/workers/runtime-apis/cache/）
files.on(['GET', 'HEAD'], '/files/:type{scenarios|resources|packs}/:id/:version/*', async c => {
  const segments = new URL(c.req.url).pathname.split('/').slice(5);
  let path: string;
  try {
    path = segments.map(decodeURIComponent).join('/');
  } catch {
    return c.notFound();
  }
  if (!path || path.split('/').includes('..')) {
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
    const found = await extractFile(c.env.FILES, a, path);
    if (!found.ok) {
      return c.text(found.status === 413 ? '大きすぎるため取り出せません。zip をダウンロードしてください。' : 'Not Found', found.status);
    }
    full = new Response(found.body, {
      headers: {
        ...IMMUTABLE,
        'Content-Type': entryContentType(found.name),
        // 画像・音のほか（テキスト・HTML など）は頁として開かせない
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
    if (cache) {
      c.executionCtx.waitUntil(cache.put(key, full.clone()));
    }
  }
  return withRange(c.req.raw, full);
});

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
