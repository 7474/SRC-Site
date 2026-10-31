// ログインしていなければ、投稿も編集もできない（issue #31 の 1）
import { describe, expect, it } from 'vitest';
import { call, createPack, createScenario, createSubmission, createVersion, db, login, status } from './helpers';

describe('ログインしていない', () => {
  it('シナリオを作れない（ログインの頁へ送る）', async () => {
    const r = await call('POST', '/my/scenarios/new', null, { form: { slug: 'anon-new', title: '題' } });
    await r.arrayBuffer();
    expect(r.status).toBe(302);
    expect(r.headers.get('Location')).toMatch(/^\/auth\/login\?next=/);
    expect(await db().prepare("SELECT 1 FROM scenarios WHERE slug = 'anon-new'").first()).toBeNull();
  });

  it('版を作れない（API は 401）', async () => {
    const owner = await login();
    const s = await createScenario(owner);
    expect(await status(call('POST', `/api/scenarios/${s.slug}/versions`, null, { json: { size: 100 } }))).toBe(401);
    expect(await db().prepare('SELECT COUNT(*) AS n FROM versions WHERE scenario_id = ?').bind(s.id).first('n')).toBe(0);
  });

  it('シナリオ・版を直せない、消せない', async () => {
    const owner = await login();
    const s = await createScenario(owner);
    const v = await createVersion(s, { requires: ['x'] });
    expect(await status(call('POST', `/my/scenarios/${s.slug}`, null, { form: { title: '書き換え' } }))).toBe(302);
    expect(await status(call('POST', `/my/scenarios/${s.slug}/delete`, null))).toBe(302);
    expect(await status(call('POST', `/my/versions/${v}/packs`, null, { form: { pack: 'y' } }))).toBe(302);
    expect(await status(call('POST', `/my/versions/${v}/delete`, null))).toBe(302);
    expect(await status(call('GET', `/api/versions/${v}`, null))).toBe(401);
    expect(await status(call('PUT', `/api/versions/${v}/parts/1`, null))).toBe(401);
    expect(await status(call('POST', `/api/versions/${v}/complete`, null, { json: {} }))).toBe(401);
    const row = await db().prepare('SELECT s.title, v.requires FROM scenarios s JOIN versions v ON v.scenario_id = s.id WHERE v.id = ?').bind(v).first();
    expect(row).toEqual({ title: `題 ${s.slug}`, requires: '["x"]' });
  });

  it('パックを作れない・パックに投稿できない・承認できない', async () => {
    const manager = await login();
    const pack = await createPack({ owner: manager });
    expect(await status(call('POST', '/my/packs/new', null, { form: { id: 'anon-pack', title: '名前', policy: 'free' } }))).toBe(302);
    expect(await db().prepare("SELECT 1 FROM packs WHERE id = 'anon-pack'").first()).toBeNull();
    expect(await status(call('POST', `/api/packs/${pack}/submissions`, null, { json: { size: 100, title: '素材', agree: true } }))).toBe(401);
    const sub = await createSubmission(pack, await login());
    expect(await status(call('POST', `/my/submissions/${sub}/approve`, null))).toBe(302);
    expect(await status(call('POST', `/my/packs/${pack}`, null, { form: { title: '書き換え' } }))).toBe(302);
    expect(await db().prepare('SELECT state FROM pack_submissions WHERE id = ?').bind(sub).first('state')).toBe('pending');
    expect(await db().prepare('SELECT title FROM packs WHERE id = ?').bind(pack).first('title')).toBe(`パック ${pack}`);
  });

  it('期限の切れたセッション・形の違う Cookie はログインしていないものとして扱う', async () => {
    const owner = await login();
    const s = await createScenario(owner);
    await db().prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?').bind(owner.id).run();
    expect(await status(call('POST', `/api/scenarios/${s.slug}/versions`, owner, { json: { size: 100 } }))).toBe(401);
    expect(await status(call('POST', `/api/scenarios/${s.slug}/versions`, { ...owner, cookie: `sid=${owner.id}` }, { json: { size: 100 } }))).toBe(401);
  });
});

describe('ログインしていても投稿できない利用者', () => {
  it('停止された利用者は自分のシナリオにも版を作れない', async () => {
    const owner = await login({ suspended: true });
    const s = await createScenario(owner);
    expect(await status(call('POST', `/api/scenarios/${s.slug}/versions`, owner, { json: { size: 100 } }))).toBe(403);
    expect(await status(call('POST', `/my/scenarios/${s.slug}`, owner, { form: { title: '書き換え' } }))).toBe(403);
  });

  it('規約に同意していなければ版を作れない・パックに投稿できない', async () => {
    const owner = await login({ terms: false });
    const s = await createScenario(owner);
    expect(await status(call('POST', `/api/scenarios/${s.slug}/versions`, owner, { json: { size: 100 } }))).toBe(403);
    const pack = await createPack({ owner: await login() });
    expect(await status(call('POST', `/api/packs/${pack}/submissions`, owner, { json: { size: 100, title: '素材', agree: true } }))).toBe(403);
  });

  it('ほかのサイトからの要求は受け付けない', async () => {
    const owner = await login();
    const s = await createScenario(owner);
    expect(await status(call('POST', `/api/scenarios/${s.slug}/versions`, owner, { json: { size: 100 }, origin: 'https://evil.example' }))).toBe(403);
    expect(await db().prepare('SELECT COUNT(*) AS n FROM versions WHERE scenario_id = ?').bind(s.id).first('n')).toBe(0);
  });
});
