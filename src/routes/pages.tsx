// ポータルの画面
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { Layout, Notice } from '../views/layout';
import { EditPage, Home, MePage, NewScenarioPage, ScenarioPage, Simple, UserPage, type ListItem, type MyPack, type MySubmission, type ScenarioForm } from '../views/pages';
import { Rights, Terms } from '../views/about';
import { CheckPage, type CheckPack } from '../views/check';
import { canEdit, canView, getScenario, LIST_SELECT, requireUser } from './common';
import { verifyTurnstile } from '../lib/turnstile';
import { canPresign } from '../lib/presign';
import { choosePacks, USABLE_PACK_SQL } from '../lib/catalog';
import { HANDLE_PATTERN, now, parseJsonArray, reportUrl, SLUG_PATTERN } from '../lib/util';
import type { Child } from 'hono/jsx';

export const pages = new Hono<AppEnv>();

function render(c: Context<AppEnv>, title: string, body: Child, status: 200 | 400 | 403 | 404 = 200) {
  c.header('Cache-Control', 'private, no-store');
  return c.html(<Layout title={title} siteName={c.env.SITE_NAME} user={c.get('user')} path={c.req.path}>{body}</Layout>, status);
}

function notFound(c: Context<AppEnv>) {
  return render(c, '見つかりません', <Simple title="見つかりません"><p>お探しの頁はありません。</p></Simple>, 404);
}

pages.get('/', async c => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 50);
  const base = `${LIST_SELECT} WHERE s.hidden = 0 AND s.visibility = 'public' AND s.latest_version IS NOT NULL`;
  let latest: ListItem[];
  let popular: ListItem[] = [];
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    latest = (await c.env.DB.prepare(`${base} AND (s.title LIKE ?1 OR s.author LIKE ?1 OR s.tags LIKE ?1 OR u.handle LIKE ?1) ORDER BY s.updated_at DESC LIMIT 50`)
      .bind(like).all<ListItem>()).results;
  } else {
    latest = (await c.env.DB.prepare(`${base} ORDER BY s.updated_at DESC LIMIT 30`).all<ListItem>()).results;
    popular = (await c.env.DB.prepare(`${base} AND plays > 0 ORDER BY plays DESC LIMIT 10`).all<ListItem>()).results;
  }
  return render(c, c.env.SITE_NAME, <Home q={q} latest={latest} popular={popular} />);
});

pages.get('/my/scenarios/new', requireUser, c => {
  if (!c.get('user')!.terms_accepted_at) {
    return c.redirect('/my');
  }
  return render(c, '投稿', <NewScenarioPage v={EMPTY_FORM} />);
});

pages.post('/my/scenarios/new', requireUser, async c => {
  const user = c.get('user')!;
  if (!user.terms_accepted_at) {
    return c.redirect('/my');
  }
  const v = readScenarioForm(await c.req.parseBody());
  const fail = (error: string) => render(c, '投稿', <NewScenarioPage v={v} error={error} />, 400);
  if (!SLUG_PATTERN.test(v.slug)) {
    return fail('ID は英小文字・数字・- の 3〜40 文字にしてください（先頭と末尾は英数字）。');
  }
  if (!v.title) {
    return fail('題名を入れてください。');
  }
  if (await c.env.DB.prepare('SELECT 1 FROM scenarios WHERE slug = ?').bind(v.slug).first()) {
    return fail('その ID は使われています。');
  }
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO scenarios (slug, owner_id, title, author, description, license, tags, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(v.slug, user.id, v.title, v.author || null, v.description || null, v.license || null, tagsJson(v.tags), v.visibility, t, t).run();
  return c.redirect(`/my/scenarios/${v.slug}`);
});

pages.get('/scenarios/:slug', async c => {
  const s = await getScenario(c, c.req.param('slug'));
  if (!s || !canView(c, s)) {
    return notFound(c);
  }
  const versions = (await c.env.DB.prepare(
    'SELECT id, number, state, size, created_at, published_at, note, inspect_note, root, eve, manifest, requires, excludes FROM versions WHERE scenario_id = ? ORDER BY number DESC',
  ).bind(s.id).all<any>()).results;
  const latestRow = versions.find(v => v.id === s.latest_version) ?? null;
  const latest = latestRow ? { ...latestRow, manifest: latestRow.manifest ? JSON.parse(latestRow.manifest) : null } : null;
  const { resolveRequires } = await import('../lib/catalog');
  const allPacks = (await c.env.DB.prepare('SELECT * FROM packs').all<any>()).results;
  const ids = latest ? resolveRequires(allPacks, parseJsonArray(latest.requires), parseJsonArray(latest.excludes)) : [];
  const packs = ids.map(id => allPacks.find(p => p.id === id)!);
  return render(c, s.title, (
    <ScenarioPage
      s={{ ...s, tags: parseJsonArray(s.tags) }}
      latest={latest}
      versions={versions}
      packs={packs}
      canEdit={canEdit(c, s)}
      isAdmin={c.get('user')?.role === 'admin'}
      reportUrl={reportUrl(c.env.REPORT_FORM_URL, { url: new URL(`/scenarios/${s.slug}`, c.req.url).toString(), title: s.title })}
    />
  ));
});

pages.get('/users/:handle', async c => {
  const handle = c.req.param('handle');
  const items = (await c.env.DB.prepare(`${LIST_SELECT} WHERE u.handle = ? AND s.hidden = 0 AND s.visibility = 'public' AND s.latest_version IS NOT NULL ORDER BY s.updated_at DESC LIMIT 100`)
    .bind(handle).all<ListItem>()).results;
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE handle = ?').bind(handle).first();
  if (!exists) {
    return notFound(c);
  }
  return render(c, handle, <UserPage handle={handle} items={items} />);
});

// データ・シナリオのチェッカー（ログインは要らない）。汎用データは公開しているパックから選ぶ
pages.get('/check', async c => {
  const packs = (await c.env.DB.prepare(`SELECT id, title, is_default, version FROM packs WHERE ${USABLE_PACK_SQL} ORDER BY priority, id`).all<CheckPack>()).results;
  return render(c, 'データ・シナリオのチェック', <CheckPage packs={packs} />);
});

pages.get('/about/terms', c => render(c, '利用規約', <Terms />));
pages.get('/about/rights', c => render(c, '権利者の方へ', <Rights reportUrl={reportUrl(c.env.REPORT_FORM_URL)} />));

// ── ログインが要る頁 ──

pages.get('/my', requireUser, async c => {
  const user = c.get('user')!;
  const items = (await c.env.DB.prepare(`${LIST_SELECT} WHERE s.owner_id = ? ORDER BY s.updated_at DESC`).bind(user.id).all<any>()).results;
  const [packs, submissions] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT p.id, p.title, m.role, p.revision != p.built_revision AS dirty,
              (SELECT COUNT(*) FROM pack_submissions s WHERE s.pack_id = p.id AND s.state = 'pending') AS pending
         FROM pack_managers m JOIN packs p ON p.id = m.pack_id WHERE m.user_id = ? ORDER BY p.title`,
    ).bind(user.id),
    c.env.DB.prepare(
      `SELECT s.id, s.pack_id, p.title AS pack_title, s.title, s.state, s.created_at, s.reviewed_at, s.review_note, s.inspect_note,
              p.revision = p.built_revision AND p.r2_key != '' AS reflected
         FROM pack_submissions s JOIN packs p ON p.id = s.pack_id WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 100`,
    ).bind(user.id),
  ]);
  return render(c, '設定', (
    <MePage handle={user.handle} termsAccepted={Boolean(user.terms_accepted_at)} items={items} saved={c.req.query('saved') === '1'}
      packs={packs.results as MyPack[]} submissions={submissions.results as MySubmission[]} />
  ));
});

pages.post('/my', requireUser, async c => {
  const user = c.get('user')!;
  const form = await c.req.parseBody();
  const handle = String(form.handle ?? '').trim();
  const items = (await c.env.DB.prepare(`${LIST_SELECT} WHERE s.owner_id = ? ORDER BY s.updated_at DESC`).bind(user.id).all<any>()).results;
  const fail = (error: string) => render(c, '設定', <MePage handle={handle} termsAccepted={Boolean(user.terms_accepted_at)} items={items} error={error} />, 400);
  if (!HANDLE_PATTERN.test(handle)) {
    return fail('表示名は英数字・_・- の 3〜24 文字にしてください。');
  }
  const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE handle = ? AND id != ?').bind(handle, user.id).first();
  if (taken) {
    return fail('その表示名は使われています。');
  }
  const terms = form.terms === '1' || Boolean(user.terms_accepted_at);
  await c.env.DB.prepare('UPDATE users SET handle = ?, terms_accepted_at = COALESCE(terms_accepted_at, ?) WHERE id = ?')
    .bind(handle, terms ? now() : null, user.id).run();
  return c.redirect('/my?saved=1');
});

const EMPTY_FORM: ScenarioForm = { slug: '', title: '', author: '', description: '', license: '', tags: '', visibility: 'public' };

function readScenarioForm(form: Record<string, unknown>): ScenarioForm {
  const text = (key: string, max: number) => String(form[key] ?? '').trim().slice(0, max);
  return {
    slug: text('slug', 40).toLowerCase(),
    title: text('title', 100),
    author: text('author', 100),
    description: text('description', 5000),
    license: text('license', 5000),
    tags: text('tags', 200),
    visibility: ['public', 'unlisted', 'private'].includes(form.visibility as string) ? form.visibility as string : 'public',
  };
}

function tagsJson(tags: string): string {
  return JSON.stringify([...new Set(tags.split(/\s+/).filter(Boolean).map(t => t.slice(0, 30)))].slice(0, 10));
}

async function editPage(c: Context<AppEnv>, slug: string, extra: { error?: string; saved?: boolean; form?: ScenarioForm } = {}) {
  const s = await getScenario(c, slug);
  if (!s || !canEdit(c, s)) {
    return notFound(c);
  }
  const versions = (await c.env.DB.prepare('SELECT id, number, state, size, created_at, published_at, note, inspect_note, root, eve, requires, excludes FROM versions WHERE scenario_id = ? ORDER BY number DESC')
    .bind(s.id).all<any>()).results;
  // まだ zip の無いパック（利用者が作り、一度も反映していないもの）は選べない
  const packs = (await c.env.DB.prepare(`SELECT id, title, is_default, priority, withdrawn, version, r2_key FROM packs WHERE ${USABLE_PACK_SQL} ORDER BY priority, id`).all<any>()).results;
  const form = extra.form ?? {
    slug: s.slug, title: s.title, author: s.author ?? '', description: s.description ?? '', license: s.license ?? '',
    tags: parseJsonArray(s.tags).join(' '), visibility: s.visibility,
  };
  return render(c, `${s.title} の編集`, (
    <EditPage slug={s.slug} v={form} versions={versions} packs={packs} error={extra.error} saved={extra.saved}
      turnstileKey={c.env.TURNSTILE_SITE_KEY} directUpload={canPresign(c.env)} />
  ), extra.error ? 400 : 200);
}

pages.get('/my/scenarios/:slug', requireUser, c => editPage(c, c.req.param('slug'), { saved: c.req.query('saved') === '1' }));

pages.post('/my/scenarios/:slug', requireUser, async c => {
  const s = await getScenario(c, c.req.param('slug'));
  if (!s || !canEdit(c, s)) {
    return notFound(c);
  }
  const v = readScenarioForm(await c.req.parseBody());
  v.slug = s.slug;
  if (!v.title) {
    return editPage(c, s.slug, { error: '題名を入れてください。', form: v });
  }
  await c.env.DB.prepare(
    'UPDATE scenarios SET title = ?, author = ?, description = ?, license = ?, tags = ?, visibility = ?, updated_at = ? WHERE id = ?',
  ).bind(v.title, v.author || null, v.description || null, v.license || null, tagsJson(v.tags), v.visibility, now(), s.id).run();
  return c.redirect(`/my/scenarios/${s.slug}?saved=1`);
});

pages.post('/my/scenarios/:slug/delete', requireUser, async c => {
  const s = await getScenario(c, c.req.param('slug'));
  if (!s || !canEdit(c, s)) {
    return notFound(c);
  }
  const keys = (await c.env.DB.prepare('SELECT r2_key FROM versions WHERE scenario_id = ?').bind(s.id).all<{ r2_key: string }>()).results;
  for (const k of keys) {
    await c.env.FILES.delete(k.r2_key);
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM versions WHERE scenario_id = ?').bind(s.id),
    c.env.DB.prepare('DELETE FROM counters WHERE scenario_id = ?').bind(s.id),
    c.env.DB.prepare('DELETE FROM scenarios WHERE id = ?').bind(s.id),
  ]);
  return c.redirect('/my');
});

async function versionForEdit(c: Context<AppEnv>, id: string) {
  const v = await c.env.DB.prepare('SELECT v.*, s.slug FROM versions v JOIN scenarios s ON s.id = v.scenario_id WHERE v.id = ?').bind(Number(id)).first<any>();
  if (!v) {
    return null;
  }
  const s = await getScenario(c, v.slug);
  return s && canEdit(c, s) ? { v, s } : null;
}

pages.post('/my/versions/:id/settings', requireUser, async c => {
  const found = await versionForEdit(c, c.req.param('id'));
  if (!found) {
    return notFound(c);
  }
  const form = await c.req.parseBody();
  const clean = (x: unknown) => String(x ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').slice(0, 200) || null;
  const root = clean(form.root);
  const eve = clean(form.eve);
  if ((root && root.split('/').includes('..')) || (eve && eve.split('/').includes('..'))) {
    return editPage(c, found.s.slug, { error: 'パスに .. は使えません。' });
  }
  await c.env.DB.prepare('UPDATE versions SET root = ?, eve = ? WHERE id = ?').bind(root, eve, found.v.id).run();
  return c.redirect(`/my/scenarios/${found.s.slug}?saved=1`);
});

pages.post('/my/versions/:id/packs', requireUser, async c => {
  const found = await versionForEdit(c, c.req.param('id'));
  if (!found) {
    return notFound(c);
  }
  const form = await c.req.parseBody({ all: true });
  const chosen = new Set((Array.isArray(form.pack) ? form.pack : form.pack ? [form.pack] : []).map(String));
  // 選べるのは編集の頁に出すパック（zip があり、取り下げていないもの）だけ。上げる画面（/api/scenarios/:slug/versions）と同じ
  const { requires, excludes } = await choosePacks(c.env.DB, chosen);
  await c.env.DB.prepare('UPDATE versions SET requires = ?, excludes = ? WHERE id = ?').bind(JSON.stringify(requires), JSON.stringify(excludes), found.v.id).run();
  return c.redirect(`/my/scenarios/${found.s.slug}?saved=1`);
});

pages.post('/my/versions/:id/delete', requireUser, async c => {
  const found = await versionForEdit(c, c.req.param('id'));
  if (!found) {
    return notFound(c);
  }
  await c.env.FILES.delete(found.v.r2_key);
  await c.env.DB.prepare('DELETE FROM versions WHERE id = ?').bind(found.v.id).run();
  // 最新の版を消したら、残りの公開した版のうち最も新しいものにする
  await c.env.DB.prepare(
    `UPDATE scenarios SET latest_version = (SELECT id FROM versions WHERE scenario_id = ?1 AND state = 'published' ORDER BY number DESC LIMIT 1), updated_at = ?2 WHERE id = ?1`,
  ).bind(found.s.id, now()).run();
  return c.redirect(`/my/scenarios/${found.s.slug}?saved=1`);
});
