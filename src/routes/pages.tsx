// ポータルの画面
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { Layout, Notice } from '../views/layout';
import { EditPage, Home, MePage, NewResourcePage, NewScenarioPage, PackPage, PacksPage, ResourcePage, ScenarioPage, Simple, UserPage, type ListItem, type ScenarioForm } from '../views/pages';
import { Rights, Terms } from '../views/about';
import { CheckPage } from '../views/check';
import { canEdit, canView, getScenario, LIST_SELECT, requireUser, type ScenarioRow } from './common';
import { archiveUrls, loadPacks, MEMBER_SELECT, packMembers, resolveRequires, selectPacks, type MemberRow, type PackRow } from '../lib/catalog';
import { policyOf } from '../lib/policy';
import { verifyTurnstile } from '../lib/turnstile';
import { canPresign } from '../lib/presign';
import { HANDLE_PATTERN, itemPath, now, parseJsonArray, reportUrl, SLUG_PATTERN } from '../lib/util';
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
  const base = `${LIST_SELECT} WHERE s.kind = 'scenario' AND s.hidden = 0 AND s.visibility = 'public' AND s.latest_version IS NOT NULL`;
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
  const error = await checkNew(c, v);
  if (error) {
    return fail(error);
  }
  await insertItem(c, v, 'scenario', null);
  return c.redirect(`/my/scenarios/${v.slug}`);
});

// 素材を共有パックに投稿する（docs/resources.md）。zip を上げるところからはシナリオと同じ
pages.get('/my/resources/new', requireUser, async c => {
  if (!c.get('user')!.terms_accepted_at) {
    return c.redirect('/my');
  }
  const v = { ...EMPTY_FORM, pack: c.req.query('pack') ?? '' };
  return render(c, '素材の投稿', <NewResourcePage v={v} packs={await communityPacks(c)} />);
});

pages.post('/my/resources/new', requireUser, async c => {
  const user = c.get('user')!;
  if (!user.terms_accepted_at) {
    return c.redirect('/my');
  }
  const form = await c.req.parseBody();
  const v = readScenarioForm(form);
  const packs = await communityPacks(c);
  const fail = (error: string) => render(c, '素材の投稿', <NewResourcePage v={v} packs={packs} error={error} />, 400);
  const error = (await checkNew(c, v)) ?? checkPack(packs, v, form.agree === '1');
  if (error) {
    return fail(error);
  }
  await insertItem(c, v, 'resource', v.pack);
  return c.redirect(`/my/scenarios/${v.slug}`);
});

async function checkNew(c: Context<AppEnv>, v: ScenarioForm): Promise<string | null> {
  if (!SLUG_PATTERN.test(v.slug)) {
    return 'ID は英小文字・数字・- の 3〜40 文字にしてください（先頭と末尾は英数字）。';
  }
  if (!v.title) {
    return '題名を入れてください。';
  }
  if (await c.env.DB.prepare('SELECT 1 FROM scenarios WHERE slug = ?').bind(v.slug).first()) {
    return 'その ID は使われています。';
  }
  return null;
}

/** 素材の投稿先のパックと、そのポリシーへの同意・条件を確かめる */
function checkPack(packs: CommunityPack[], v: ScenarioForm, agreed: boolean): string | null {
  const pack = packs.find(p => p.id === v.pack);
  const policy = policyOf(pack?.policy);
  if (!pack || !policy) {
    return '投稿先のパックを選んでください。';
  }
  if (!agreed) {
    return `パックの管理ポリシー（${policy.title}）に同意してください。`;
  }
  if (policy.requiresLicense && !v.license) {
    return 'このパックでは「ライセンス・配布の条件」を書いてください。';
  }
  return null;
}

async function insertItem(c: Context<AppEnv>, v: ScenarioForm, kind: 'scenario' | 'resource', packId: string | null) {
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO scenarios (slug, owner_id, title, author, description, license, tags, visibility, kind, pack_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(v.slug, c.get('user')!.id, v.title, v.author || null, v.description || null, v.license || null, tagsJson(v.tags), v.visibility, kind, packId, t, t).run();
}

export type CommunityPack = { id: string; title: string; policy: string; license: string };

async function communityPacks(c: Context<AppEnv>): Promise<CommunityPack[]> {
  return (await c.env.DB.prepare("SELECT id, title, policy, license FROM packs WHERE kind = 'community' AND withdrawn = 0 ORDER BY priority, id")
    .all<CommunityPack>()).results;
}

pages.get('/scenarios/:slug', async c => {
  const s = await getScenario(c, c.req.param('slug'));
  if (!s || !canView(c, s)) {
    return notFound(c);
  }
  if (s.kind === 'resource') {
    return c.redirect(itemPath(s), 301);
  }
  const { latest, versions } = await versionsOf(c, s);
  const allPacks = (await c.env.DB.prepare('SELECT * FROM packs').all<PackRow>()).results;
  const ids = latest ? selectPacks(allPacks, parseJsonArray(latest.requires), parseJsonArray(latest.excludes)) : [];
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

pages.get('/resources/:slug', async c => {
  const s = await getScenario(c, c.req.param('slug'));
  if (!s || !canView(c, s)) {
    return notFound(c);
  }
  if (s.kind !== 'resource') {
    return c.redirect(itemPath(s), 301);
  }
  const { latest, versions } = await versionsOf(c, s);
  const pack = s.pack_id ? await c.env.DB.prepare('SELECT id, title, policy, license FROM packs WHERE id = ?').bind(s.pack_id).first<CommunityPack>() : null;
  return render(c, s.title, (
    <ResourcePage
      s={{ ...s, tags: parseJsonArray(s.tags) }}
      latest={latest}
      versions={versions}
      pack={pack}
      canEdit={canEdit(c, s)}
      isAdmin={c.get('user')?.role === 'admin'}
      reportUrl={reportUrl(c.env.REPORT_FORM_URL, { url: new URL(`/resources/${s.slug}`, c.req.url).toString(), title: s.title })}
    />
  ));
});

async function versionsOf(c: Context<AppEnv>, s: ScenarioRow) {
  const versions = (await c.env.DB.prepare(
    'SELECT id, number, state, size, created_at, published_at, note, inspect_note, root, eve, manifest, requires, excludes FROM versions WHERE scenario_id = ? ORDER BY number DESC',
  ).bind(s.id).all<any>()).results;
  const latestRow = versions.find(v => v.id === s.latest_version) ?? null;
  const latest = latestRow ? { ...latestRow, manifest: latestRow.manifest ? JSON.parse(latestRow.manifest) : null } : null;
  return { latest, versions };
}

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

pages.get('/packs', async c => {
  const packs = (await c.env.DB.prepare(
    `SELECT p.id, p.title, p.source_name, p.size, p.is_default, p.withdrawn, p.kind, p.policy,
            (SELECT COUNT(*) FROM (${MEMBER_SELECT}) m WHERE m.pack_id = p.id) AS members
       FROM packs p ORDER BY p.priority, p.id`,
  ).all<any>()).results;
  return render(c, '共有パック', <PacksPage packs={packs} />);
});

pages.get('/packs/:id', async c => {
  const p = await c.env.DB.prepare('SELECT * FROM packs WHERE id = ?').bind(c.req.param('id')).first<any>();
  if (!p) {
    return notFound(c);
  }
  const takedowns = (await c.env.DB.prepare("SELECT target_id, reason, created_at FROM takedowns WHERE (target_type = 'pack' AND target_id = ?1) OR (target_type = 'pack_file' AND target_id LIKE ?1 || ':%') ORDER BY created_at DESC")
    .bind(p.id).all<any>()).results;
  // 投稿素材のパックは中の素材を、重ねる順（後ろほど優先）に出す
  const members = p.kind === 'community'
    ? packMembers((await c.env.DB.prepare(MEMBER_SELECT).all<MemberRow>()).results, p.id)
    : [];
  return render(c, p.title, <PackPage p={p} takedowns={takedowns} members={members} />);
});

// データ・シナリオのチェッカー（ログインは要らない）。汎用データは公開しているパックから選ぶ
pages.get('/check', async c => {
  const { packs, members } = await loadPacks(c.env.DB);
  const checkPacks = packs.filter(p => !p.withdrawn).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map(p => ({ id: p.id, title: p.title, is_default: p.is_default, urls: archiveUrls(packs, resolveRequires(packs, [p.id], packs.map(x => x.id), members), members) }))
    .filter(p => p.urls.length > 0);
  return render(c, 'データ・シナリオのチェック', <CheckPage packs={checkPacks} />);
});

pages.get('/about/terms', c => render(c, '利用規約', <Terms />));
pages.get('/about/rights', c => render(c, '権利者の方へ', <Rights reportUrl={reportUrl(c.env.REPORT_FORM_URL)} />));

// ── ログインが要る頁 ──

pages.get('/my', requireUser, async c => {
  const user = c.get('user')!;
  const items = (await c.env.DB.prepare(`${LIST_SELECT} WHERE s.owner_id = ? ORDER BY s.updated_at DESC`).bind(user.id).all<any>()).results;
  return render(c, '設定', <MePage handle={user.handle} termsAccepted={Boolean(user.terms_accepted_at)} items={items} saved={c.req.query('saved') === '1'} />);
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

const EMPTY_FORM: ScenarioForm = { slug: '', title: '', author: '', description: '', license: '', tags: '', visibility: 'public', pack: '' };

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
    pack: text('pack', 40),
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
  const { packs: allPacks, members } = await loadPacks(c.env.DB);
  const packs = allPacks.filter(p => !p.withdrawn).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const form = extra.form ?? {
    slug: s.slug, title: s.title, author: s.author ?? '', description: s.description ?? '', license: s.license ?? '',
    tags: parseJsonArray(s.tags).join(' '), visibility: s.visibility, pack: s.pack_id ?? '',
  };
  // lint が汎用データ（Data/System の sp.txt など）を読むパック。遊ぶときに重ねるものと同じ
  const latestPublished = versions.find(v => v.state === 'published');
  const systemArchives = latestPublished
    ? archiveUrls(packs, resolveRequires(packs, parseJsonArray(latestPublished.requires), parseJsonArray(latestPublished.excludes), members), members)
    : archiveUrls(packs, resolveRequires(packs, [], [], members), members);
  return render(c, `${s.title} の編集`, (
    <EditPage slug={s.slug} kind={s.kind === 'resource' ? 'resource' : 'scenario'} v={form} versions={versions} packs={packs}
      communityPacks={s.kind === 'resource' ? await communityPacks(c) : []} systemArchives={systemArchives}
      error={extra.error} saved={extra.saved} turnstileKey={c.env.TURNSTILE_SITE_KEY} directUpload={canPresign(c.env)} />
  ), extra.error ? 400 : 200);
}

pages.get('/my/scenarios/:slug', requireUser, c => editPage(c, c.req.param('slug'), { saved: c.req.query('saved') === '1' }));

pages.post('/my/scenarios/:slug', requireUser, async c => {
  const s = await getScenario(c, c.req.param('slug'));
  if (!s || !canEdit(c, s)) {
    return notFound(c);
  }
  const form = await c.req.parseBody();
  const v = readScenarioForm(form);
  v.slug = s.slug;
  if (!v.title) {
    return editPage(c, s.slug, { error: '題名を入れてください。', form: v });
  }
  if (s.kind === 'resource') {
    // 投稿先のパックを変えるときは、新しいパックのポリシーに同意してもらう
    const error = checkPack(await communityPacks(c), v, form.agree === '1' || v.pack === s.pack_id);
    if (error) {
      return editPage(c, s.slug, { error, form: v });
    }
  } else {
    v.pack = '';
  }
  await c.env.DB.prepare(
    'UPDATE scenarios SET title = ?, author = ?, description = ?, license = ?, tags = ?, visibility = ?, pack_id = ?, updated_at = ? WHERE id = ?',
  ).bind(v.title, v.author || null, v.description || null, v.license || null, tagsJson(v.tags), v.visibility, v.pack || null, now(), s.id).run();
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
  const packs = (await c.env.DB.prepare('SELECT id, is_default FROM packs').all<{ id: string; is_default: number }>()).results;
  const requires = packs.filter(p => !p.is_default && chosen.has(p.id)).map(p => p.id);
  const excludes = packs.filter(p => p.is_default && !chosen.has(p.id)).map(p => p.id);
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
