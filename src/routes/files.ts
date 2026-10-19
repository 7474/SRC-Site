// シナリオ・共有パックの zip の配信
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { serveObject } from '../lib/serve';
import { count } from './api';

export const files = new Hono<AppEnv>();

const IMMUTABLE = { 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'same-origin' };

files.on(['GET', 'HEAD'], '/files/scenarios/:slug/:file', async c => {
  const m = /^(\d+)\.zip$/.exec(c.req.param('file'));
  if (!m) {
    return c.notFound();
  }
  const v = await c.env.DB.prepare(
    `SELECT v.r2_key FROM versions v JOIN scenarios s ON s.id = v.scenario_id
      WHERE s.slug = ? AND v.number = ? AND v.state = 'published' AND s.hidden = 0 AND s.visibility != 'private'`,
  ).bind(c.req.param('slug'), Number(m[1])).first<{ r2_key: string }>();
  if (!v) {
    return c.notFound();
  }
  return serveObject(c.req.raw, c.env.FILES, v.r2_key, IMMUTABLE);
});

files.on(['GET', 'HEAD'], '/files/packs/:id/:file', async c => {
  const version = c.req.param('file').replace(/\.zip$/, '');
  const p = await c.env.DB.prepare('SELECT r2_key FROM packs WHERE id = ? AND version = ? AND withdrawn = 0')
    .bind(c.req.param('id'), version).first<{ r2_key: string }>();
  if (!p) {
    return c.notFound();
  }
  return serveObject(c.req.raw, c.env.FILES, p.r2_key, IMMUTABLE);
});

// 最新の版のダウンロード
files.get('/dl/:slug', async c => {
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
