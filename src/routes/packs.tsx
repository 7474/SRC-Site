// 共有パックの頁と、利用者が作るパック・パックへの投稿の画面（docs/resources.md）
import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppEnv } from '../env';
import { Layout } from '../views/layout';
import { Simple } from '../views/pages';
import { isPolicyId, ManagePackPage, NewPackPage, PackPage, PacksPage, SubmissionPage, SubmitPage, type PackDetail, type PackForm, type ReviewItem } from '../views/packs';
import { requireUser } from './common';
import { approve, canManage, canSubmit, getPack, reject, removeFiles, type Submission } from '../lib/packs';
import { policyOf } from '../lib/policy';
import { canPresign } from '../lib/presign';
import { now, SLUG_PATTERN } from '../lib/util';

export const packs = new Hono<AppEnv>();

function render(c: Context<AppEnv>, title: string, body: Child, status: 200 | 400 | 404 = 200) {
  c.header('Cache-Control', 'private, no-store');
  return c.html(<Layout title={title} siteName={c.env.SITE_NAME} user={c.get('user')} path={c.req.path}>{body}</Layout>, status);
}

function notFound(c: Context<AppEnv>) {
  return render(c, '見つかりません', <Simple title="見つかりません"><p>お探しの頁はありません。</p></Simple>, 404);
}

const ACTIVE_FILES = "(SELECT COUNT(*) FROM pack_files f WHERE f.pack_id = p.id AND f.state = 'active')";

packs.get('/packs', async c => {
  const rows = (await c.env.DB.prepare(
    `SELECT p.id, p.title, p.source_name, p.size, p.is_default, p.withdrawn, p.kind, p.policy, p.r2_key, u.handle AS owner, ${ACTIVE_FILES} AS files
       FROM packs p LEFT JOIN users u ON u.id = p.owner_id ORDER BY p.kind DESC, p.priority, p.id`,
  ).all<any>()).results;
  return render(c, '共有パック', <PacksPage packs={rows} loggedIn={Boolean(c.get('user'))} />);
});

async function managers(db: D1Database, packId: string) {
  return (await db.prepare(
    `SELECT u.handle, m.role FROM pack_managers m JOIN users u ON u.id = m.user_id WHERE m.pack_id = ? ORDER BY m.role DESC, m.created_at`,
  ).bind(packId).all<{ handle: string; role: string }>()).results;
}

packs.get('/packs/:id', async c => {
  const p = await c.env.DB.prepare('SELECT * FROM packs WHERE id = ?').bind(c.req.param('id')).first<PackDetail>();
  if (!p) {
    return notFound(c);
  }
  const takedowns = (await c.env.DB.prepare("SELECT target_id, reason, created_at FROM takedowns WHERE (target_type = 'pack' AND target_id = ?1) OR (target_type = 'pack_file' AND target_id LIKE ?1 || ':%') ORDER BY created_at DESC")
    .bind(p.id).all<any>()).results;
  const submissions = (await c.env.DB.prepare(
    `SELECT s.id, s.title, s.author, s.license, u.handle, s.created_at, s.reviewed_at,
            (SELECT COUNT(*) FROM pack_files f WHERE f.submission_id = s.id AND f.state = 'active') AS files
       FROM pack_submissions s JOIN users u ON u.id = s.user_id
      WHERE s.pack_id = ? AND s.state = 'approved' ORDER BY s.reviewed_at DESC`,
  ).bind(p.id).all<any>()).results;
  const files = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM pack_files WHERE pack_id = ? AND state = 'active'").bind(p.id).first<{ n: number }>())!.n;
  const user = c.get('user');
  const manage = await canManage(c.env.DB, user, p as any);
  const pending = manage
    ? (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM pack_submissions WHERE pack_id = ? AND state = 'pending'").bind(p.id).first<{ n: number }>())!.n
    : 0;
  return render(c, p.title, (
    <PackPage p={p} takedowns={takedowns} submissions={submissions} managers={await managers(c.env.DB, p.id)} files={files}
      canSubmit={await canSubmit(c.env.DB, user, p as any)} canManage={manage} pending={pending} />
  ));
});

// ── パックを作る・管理する ──

const EMPTY_PACK: PackForm = { id: '', title: '', description: '', policy: '', accepts: 'anyone' };

function readPackForm(form: Record<string, unknown>): PackForm {
  const text = (key: string, max: number) => String(form[key] ?? '').trim().slice(0, max);
  return {
    id: text('id', 40).toLowerCase(),
    title: text('title', 100),
    description: text('description', 5000),
    policy: text('policy', 20),
    accepts: form.accepts === 'managers' ? 'managers' : 'anyone',
  };
}

packs.get('/my/packs/new', requireUser, c => {
  if (!c.get('user')!.terms_accepted_at) {
    return c.redirect('/my');
  }
  return render(c, 'パックを作る', <NewPackPage v={EMPTY_PACK} />);
});

packs.post('/my/packs/new', requireUser, async c => {
  const user = c.get('user')!;
  if (!user.terms_accepted_at) {
    return c.redirect('/my');
  }
  const v = readPackForm(await c.req.parseBody());
  const fail = (error: string) => render(c, 'パックを作る', <NewPackPage v={v} error={error} />, 400);
  if (!SLUG_PATTERN.test(v.id)) {
    return fail('ID は英小文字・数字・- の 3〜40 文字にしてください（先頭と末尾は英数字）。');
  }
  if (!v.title) {
    return fail('名前を入れてください。');
  }
  if (!isPolicyId(v.policy)) {
    return fail('管理ポリシーを選んでください。');
  }
  if (await c.env.DB.prepare('SELECT 1 FROM packs WHERE id = ?').bind(v.id).first()) {
    return fail('その ID は使われています。');
  }
  const t = now();
  // 利用者のパックはサイトのパックより後に重ねる（同じ名前のファイルは利用者のパックが勝つ）
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO packs (id, title, description, source_name, license, is_default, priority, version, r2_key, size, withdrawn, updated_at, kind, policy, owner_id, accepts)
       VALUES (?, ?, ?, ?, ?, 0, 200, '', '', 0, 0, ?, 'community', ?, ?, ?)`,
    ).bind(v.id, v.title, v.description || null, `${user.handle} さんのパック`, policyOf(v.policy)!.license, t, v.policy, user.id, v.accepts),
    c.env.DB.prepare("INSERT INTO pack_managers (pack_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(v.id, user.id, t),
  ]);
  return c.redirect(`/my/packs/${v.id}`);
});

async function managedPack(c: Context<AppEnv>) {
  const p = await getPack(c.env.DB, c.req.param('id')!);
  return p && p.kind === 'community' && (await canManage(c.env.DB, c.get('user'), p)) ? p : null;
}

async function managePage(c: Context<AppEnv>, extra: { error?: string; saved?: boolean; form?: PackForm } = {}) {
  const p = await managedPack(c);
  if (!p) {
    return notFound(c);
  }
  const list = async (state: string, filesState: string) => (await c.env.DB.prepare(
    `SELECT s.id, s.title, u.handle, s.state, s.size, s.created_at,
            (SELECT COUNT(*) FROM pack_files f WHERE f.submission_id = s.id AND f.state = ?2) AS files
       FROM pack_submissions s JOIN users u ON u.id = s.user_id WHERE s.pack_id = ?1 AND s.state = ?3 ORDER BY s.created_at`,
  ).bind(p.id, filesState, state).all<ReviewItem>()).results;
  const files = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM pack_files WHERE pack_id = ? AND state = 'active'").bind(p.id).first<{ n: number }>())!.n;
  const form = extra.form ?? { id: p.id, title: p.title, description: p.description ?? '', policy: p.policy ?? '', accepts: p.accepts };
  return render(c, `${p.title} の管理`, (
    <ManagePackPage p={p as unknown as PackDetail} v={form} pending={await list('pending', 'pending')} approved={(await list('approved', 'active')).filter(s => s.files > 0)}
      managers={await managers(c.env.DB, p.id)} files={files} error={extra.error} saved={extra.saved}
      build={c.req.query('build') === '1'} directUpload={canPresign(c.env)} />
  ), extra.error ? 400 : 200);
}

packs.get('/my/packs/:id', requireUser, c => managePage(c, { saved: c.req.query('saved') === '1' }));

packs.post('/my/packs/:id', requireUser, async c => {
  const p = await managedPack(c);
  if (!p) {
    return notFound(c);
  }
  const v = readPackForm(await c.req.parseBody());
  if (!v.title) {
    return managePage(c, { error: '名前を入れてください。', form: { ...v, id: p.id, policy: p.policy ?? '' } });
  }
  await c.env.DB.prepare('UPDATE packs SET title = ?, description = ?, accepts = ?, updated_at = ? WHERE id = ?')
    .bind(v.title, v.description || null, v.accepts, now(), p.id).run();
  return c.redirect(`/my/packs/${p.id}?saved=1`);
});

packs.post('/my/packs/:id/files/remove', requireUser, async c => {
  const p = await managedPack(c);
  if (!p) {
    return notFound(c);
  }
  const path = String((await c.req.parseBody()).path ?? '').trim().replace(/\\/g, '/');
  const n = path ? await removeFiles(c.env.DB, p.id, { path }) : 0;
  return n ? c.redirect(`/my/packs/${p.id}?build=1`) : managePage(c, { error: `パックに ${path} はありません。` });
});

// ── 投稿 ──

packs.get('/my/packs/:id/submit', requireUser, async c => {
  const user = c.get('user')!;
  if (!user.terms_accepted_at) {
    return c.redirect('/my');
  }
  const p = await getPack(c.env.DB, c.req.param('id'));
  if (!p || !(await canSubmit(c.env.DB, user, p))) {
    return notFound(c);
  }
  return render(c, `${p.title} に投稿する`, <SubmitPage p={p as unknown as PackDetail} turnstileKey={c.env.TURNSTILE_SITE_KEY} directUpload={canPresign(c.env)} />);
});

async function submissionFor(c: Context<AppEnv>) {
  const s = await c.env.DB.prepare('SELECT s.*, u.handle FROM pack_submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ?')
    .bind(Number(c.req.param('id'))).first<Submission & { handle: string }>();
  if (!s) {
    return null;
  }
  const pack = await getPack(c.env.DB, s.pack_id);
  const user = c.get('user')!;
  const manage = Boolean(pack) && (await canManage(c.env.DB, user, pack!));
  return manage || s.user_id === user.id ? { s, pack: pack!, manage } : null;
}

packs.get('/my/submissions/:id', requireUser, async c => {
  const found = await submissionFor(c);
  if (!found) {
    return notFound(c);
  }
  const { s, pack, manage } = found;
  // 同じ道（大文字小文字を区別しない）のファイルが、ほかの投稿からパックに入っているか
  const files = (await c.env.DB.prepare(
    `SELECT f.path, f.size, f.state,
            EXISTS (SELECT 1 FROM pack_files o WHERE o.pack_id = f.pack_id AND o.state = 'active' AND o.submission_id != f.submission_id AND lower(o.path) = lower(f.path)) AS conflict
       FROM pack_files f WHERE f.submission_id = ? ORDER BY f.path`,
  ).bind(s.id).all<any>()).results;
  return render(c, s.title, <SubmissionPage s={s} p={pack} files={files} canReview={manage} isSubmitter={s.user_id === c.get('user')!.id} />);
});

packs.post('/my/submissions/:id/approve', requireUser, async c => {
  const found = await submissionFor(c);
  if (!found || !found.manage || found.s.state !== 'pending') {
    return notFound(c);
  }
  await approve(c.env.DB, found.s, c.get('user')!);
  // 承認者のブラウザで zip に反映する（管理の頁が開いたらすぐ始める）
  return c.redirect(`/my/packs/${found.s.pack_id}?build=1`);
});

packs.post('/my/submissions/:id/reject', requireUser, async c => {
  const found = await submissionFor(c);
  if (!found || !found.manage || found.s.state !== 'pending') {
    return notFound(c);
  }
  const note = String((await c.req.parseBody()).note ?? '').trim().slice(0, 500) || null;
  await reject(c.env, found.s, c.get('user')!, note);
  return c.redirect(`/my/packs/${found.s.pack_id}`);
});

packs.post('/my/submissions/:id/withdraw', requireUser, async c => {
  const found = await submissionFor(c);
  if (!found || found.s.user_id !== c.get('user')!.id || found.s.state !== 'pending') {
    return notFound(c);
  }
  await reject(c.env, found.s, null, null, 'withdrawn');
  return c.redirect('/my');
});

packs.post('/my/submissions/:id/remove', requireUser, async c => {
  const found = await submissionFor(c);
  if (!found || !found.manage) {
    return notFound(c);
  }
  await removeFiles(c.env.DB, found.s.pack_id, { submissionId: found.s.id });
  return c.redirect(`/my/packs/${found.s.pack_id}?build=1`);
});
