// 運営の画面（role = 'admin'）
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { Layout } from '../views/layout';
import { AdminPage, type HiddenItem, type UserItem } from '../views/admin';
import { now } from '../lib/util';
import { requireAdmin } from './common';

export const admin = new Hono<AppEnv>();

admin.use('*', requireAdmin);

admin.get('/', async c => {
  const users = (await c.env.DB.prepare('SELECT id, handle, role, suspended, created_at FROM users ORDER BY created_at DESC LIMIT 100').all<UserItem>()).results;
  const hidden = (await c.env.DB.prepare('SELECT slug, title, hidden_reason FROM scenarios WHERE hidden = 1 ORDER BY updated_at DESC LIMIT 100').all<HiddenItem>()).results;
  c.header('Cache-Control', 'private, no-store');
  return c.html(
    <Layout title="運営" siteName={c.env.SITE_NAME} user={c.get('user')} path={c.req.path}>
      <AdminPage users={users} hidden={hidden} message={c.req.query('m')} />
    </Layout>,
  );
});

const back = (m: string) => `/admin?m=${encodeURIComponent(m)}`;

admin.post('/scenarios/:slug/hide', async c => {
  const form = await c.req.parseBody();
  const reason = String(form.reason ?? '').slice(0, 200) || '権利者からの申し出・通報により確認中です。';
  const slug = c.req.param('slug');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE scenarios SET hidden = 1, hidden_reason = ? WHERE slug = ?').bind(reason, slug),
    c.env.DB.prepare("INSERT INTO takedowns (target_type, target_id, reason, created_at) VALUES ('scenario', ?, ?, ?)").bind(slug, reason, now()),
  ]);
  return c.redirect(back(`${slug} の公開を止めました`));
});

admin.post('/scenarios/:slug/unhide', async c => {
  const slug = c.req.param('slug');
  await c.env.DB.prepare('UPDATE scenarios SET hidden = 0, hidden_reason = NULL WHERE slug = ?').bind(slug).run();
  return c.redirect(back(`${slug} の公開を再開しました`));
});

admin.post('/takedowns', async c => {
  const form = await c.req.parseBody();
  const pack = String(form.pack ?? '').trim();
  const path = String(form.path ?? '').trim();
  const reason = String(form.reason ?? '').trim().slice(0, 500);
  if (!pack || !reason) {
    return c.redirect(back('パックの ID と理由を入れてください'));
  }
  const stmts = [
    c.env.DB.prepare('INSERT INTO takedowns (target_type, target_id, reason, requested_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(path ? 'pack_file' : 'pack', path ? `${pack}:${path}` : pack, reason, String(form.requested_by ?? '').slice(0, 200) || null, now()),
  ];
  if (!path) {
    stmts.push(c.env.DB.prepare('UPDATE packs SET withdrawn = 1, updated_at = ? WHERE id = ?').bind(now(), pack));
  }
  await c.env.DB.batch(stmts);
  return c.redirect(back(path ? `${pack} の ${path} を取り下げに記録しました。packs ワークフローを流し直してください` : `${pack} の配布を止めました`));
});

admin.post('/users/:id/:action', async c => {
  const action = c.req.param('action');
  if (action !== 'suspend' && action !== 'unsuspend') {
    return c.notFound();
  }
  const id = Number(c.req.param('id'));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET suspended = ? WHERE id = ? AND role != 'admin'").bind(action === 'suspend' ? 1 : 0, id),
    ...(action === 'suspend' ? [c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id)] : []),
  ]);
  return c.redirect(back(action === 'suspend' ? '停止しました' : '停止を解きました'));
});
