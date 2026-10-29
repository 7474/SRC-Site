// 運営の画面（role = 'admin'）
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { Layout } from '../views/layout';
import { AdminPage, PackReviewPage, type HiddenItem, type PendingPackSubmission, type UserItem } from '../views/admin';
import { now } from '../lib/util';
import { serveObject } from '../lib/serve';
import { requireAdmin } from './common';

export const admin = new Hono<AppEnv>();

admin.use('*', requireAdmin);

admin.get('/', async c => {
  const users = (await c.env.DB.prepare('SELECT id, handle, role, suspended, created_at FROM users ORDER BY created_at DESC LIMIT 100').all<UserItem>()).results;
  const hidden = (await c.env.DB.prepare('SELECT slug, title, hidden_reason FROM scenarios WHERE hidden = 1 ORDER BY updated_at DESC LIMIT 100').all<HiddenItem>()).results;
  const packSubmissions = (await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.title, p.source_name, p.license, p.size, p.created_at, u.handle AS submitted_by
       FROM pack_submissions p JOIN users u ON u.id = p.owner_id
      WHERE p.status = 'pending' ORDER BY p.created_at LIMIT 100`,
  ).all<PendingPackSubmission>()).results;
  c.header('Cache-Control', 'private, no-store');
  return c.html(
    <Layout title="運営" siteName={c.env.SITE_NAME} user={c.get('user')} path={c.req.path}>
      <AdminPage users={users} hidden={hidden} packSubmissions={packSubmissions} message={c.req.query('m')} />
    </Layout>,
  );
});

const back = (m: string) => `/admin?m=${encodeURIComponent(m)}`;

admin.get('/pack-submissions/:id', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.notFound();
  }
  const submission = await c.env.DB.prepare(
    'SELECT p.*, u.handle AS submitted_by FROM pack_submissions p JOIN users u ON u.id = p.owner_id WHERE p.id = ?',
  ).bind(id).first<
    PendingPackSubmission & {
      description: string | null; source_url: string | null; root: string | null; excludes_jasrac: number;
      status: string; review_note: string | null;
    }
  >();
  if (!submission) {
    return c.notFound();
  }
  c.header('Cache-Control', 'private, no-store');
  return c.html(
    <Layout title="共有パックの確認" siteName={c.env.SITE_NAME} user={c.get('user')} path={c.req.path}>
      <PackReviewPage submission={submission} />
    </Layout>,
  );
});

admin.get('/pack-submissions/:id/archive', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.notFound();
  }
  const submission = await c.env.DB.prepare(
    "SELECT slug, r2_key FROM pack_submissions WHERE id = ? AND status IN ('pending', 'approved') AND r2_key != ''",
  ).bind(id).first<{ slug: string; r2_key: string }>();
  if (!submission) {
    return c.notFound();
  }
  return serveObject(c.req.raw, c.env.FILES, submission.r2_key, {
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${submission.slug}.zip"`,
  });
});

admin.post('/pack-submissions/:id/approve', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.notFound();
  }
  const submission = await c.env.DB.prepare("SELECT slug, excludes_jasrac FROM pack_submissions WHERE id = ? AND status = 'pending'")
    .bind(id).first<{ slug: string; excludes_jasrac: number }>();
  if (!submission) {
    return c.redirect(back('申請は確認待ちではありません'));
  }
  if (!submission.excludes_jasrac) {
    return c.redirect(back('JASRAC 管理楽曲を含まないことの確認がありません'));
  }
  const duplicate = await c.env.DB.prepare('SELECT 1 FROM packs WHERE id = ?').bind(submission.slug).first();
  if (duplicate) {
    return c.redirect(back(`${submission.slug} は既に使用されているため公開できません`));
  }
  const priority = await c.env.DB.prepare('SELECT COALESCE(MAX(priority), 0) + 1 AS value FROM packs').first<{ value: number }>();
  if (!priority) {
    throw new Error('パックの優先度を取得できませんでした。');
  }
  const reviewedAt = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO packs (id, title, description, source_name, source_url, license, is_default, priority, root, version, r2_key, size, withdrawn, updated_at)
       SELECT slug, title, description, source_name, source_url, license, 0, ?, root, 'submission-' || id, r2_key, size, 0, ?
         FROM pack_submissions WHERE id = ? AND status = 'pending'`,
    ).bind(priority.value, reviewedAt, id),
    c.env.DB.prepare(
      "UPDATE pack_submissions SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending'",
    ).bind(c.get('user')!.id, reviewedAt, id),
  ]);
  const current = await c.env.DB.prepare('SELECT status FROM pack_submissions WHERE id = ?').bind(id).first<{ status: string }>();
  return c.redirect(back(current?.status === 'approved' ? `${submission.slug} を公開しました` : '申請は既に処理されています'));
});

admin.post('/pack-submissions/:id/reject', async c => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return c.notFound();
  }
  const form = await c.req.parseBody();
  const note = String(form.note ?? '').trim().slice(0, 500);
  if (!note) {
    return c.redirect(back('差し戻す理由を入れてください'));
  }
  const submission = await c.env.DB.prepare(
    "UPDATE pack_submissions SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'pending' RETURNING slug, r2_key",
  ).bind(note, c.get('user')!.id, now(), id).first<{ slug: string; r2_key: string }>();
  if (!submission) {
    return c.redirect(back('申請は確認待ちではありません'));
  }
  await c.env.FILES.delete(submission.r2_key);
  await c.env.DB.prepare("UPDATE pack_submissions SET size = 0, r2_key = '' WHERE id = ? AND status = 'rejected'")
    .bind(id).run();
  return c.redirect(back(`${submission.slug} を差し戻しました`));
});

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
