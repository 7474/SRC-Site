// ほかの人のシナリオ・パックは変えられない（issue #31 の 2）。運営と本人・管理者は変えられることも確かめ、断っている理由が権限であることを示す
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, createPack, createScenario, createSubmission, createVersion, db, login, status } from './helpers';

const scenarioTitle = (id: number) => db().prepare('SELECT title FROM scenarios WHERE id = ?').bind(id).first<string>('title');

describe('ほかの人のシナリオ', () => {
  it('題などを直せない', async () => {
    const [owner, other] = [await login(), await login()];
    const s = await createScenario(owner);
    expect(await status(call('GET', `/my/scenarios/${s.slug}`, other))).toBe(404);
    expect(await status(call('POST', `/my/scenarios/${s.slug}`, other, { form: { title: '乗っ取り', visibility: 'public' } }))).toBe(404);
    expect(await scenarioTitle(s.id)).toBe(`題 ${s.slug}`);
    // 本人は直せる
    expect(await status(call('POST', `/my/scenarios/${s.slug}`, owner, { form: { title: '直した', visibility: 'public' } }))).toBe(302);
    expect(await scenarioTitle(s.id)).toBe('直した');
  });

  it('消せない', async () => {
    const [owner, other] = [await login(), await login()];
    const s = await createScenario(owner);
    const v = await createVersion(s);
    await env.FILES.put(`scenarios/${s.slug}/1.zip`, 'zip');
    expect(await status(call('POST', `/my/scenarios/${s.slug}/delete`, other))).toBe(404);
    expect(await status(call('POST', `/my/versions/${v}/delete`, other))).toBe(404);
    expect(await db().prepare('SELECT 1 FROM scenarios WHERE id = ?').bind(s.id).first()).not.toBeNull();
    expect(await db().prepare('SELECT 1 FROM versions WHERE id = ?').bind(v).first()).not.toBeNull();
    expect(await env.FILES.head(`scenarios/${s.slug}/1.zip`)).not.toBeNull();
  });

  it('版を作れない・版の設定（共有パック・最初の .eve）を変えられない', async () => {
    const [owner, other] = [await login(), await login()];
    const s = await createScenario(owner);
    const v = await createVersion(s, { requires: ['a'] });
    expect(await status(call('POST', `/api/scenarios/${s.slug}/versions`, other, { json: { size: 100 } }))).toBe(404);
    expect(await status(call('POST', `/my/versions/${v}/packs`, other, { form: { pack: 'b' } }))).toBe(404);
    expect(await status(call('POST', `/my/versions/${v}/settings`, other, { form: { eve: 'evil.eve' } }))).toBe(404);
    const row = await db().prepare('SELECT requires, eve FROM versions WHERE id = ?').bind(v).first();
    expect(row).toEqual({ requires: '["a"]', eve: null });
    expect(await db().prepare('SELECT COUNT(*) AS n FROM versions WHERE scenario_id = ?').bind(s.id).first('n')).toBe(1);
  });

  it('アップロード中の版にパートを上げられない・完了できない・様子を見られない', async () => {
    const [owner, other] = [await login(), await login()];
    const s = await createScenario(owner);
    const created = await call('POST', `/api/scenarios/${s.slug}/versions`, owner, { json: { size: 10 } });
    expect(created.status).toBe(200);
    const { versionId } = await created.json<{ versionId: number }>();
    expect(await status(call('GET', `/api/versions/${versionId}/parts/1`, other))).toBe(404);
    expect(await status(call('GET', `/api/versions/${versionId}`, other))).toBe(404);
    expect(await status(call('POST', `/api/versions/${versionId}/complete`, other, { json: { parts: [] } }))).toBe(404);
    const part = { bytes: new Uint8Array(10) };
    expect(await status(call('PUT', `/api/versions/${versionId}/parts/1`, other, part))).toBe(404);
    expect(await db().prepare('SELECT state FROM versions WHERE id = ?').bind(versionId).first('state')).toBe('uploading');
    // 本人は上げられる
    expect(await status(call('PUT', `/api/versions/${versionId}/parts/1`, owner, part))).toBe(200);
  });

  it('非公開のシナリオはほかの人に見せない', async () => {
    const [owner, other] = [await login(), await login()];
    const s = await createScenario(owner, { visibility: 'private' });
    expect(await status(call('GET', `/scenarios/${s.slug}`, other))).toBe(404);
    expect(await status(call('GET', `/scenarios/${s.slug}`, null))).toBe(404);
    expect(await status(call('GET', `/scenarios/${s.slug}`, owner))).toBe(200);
  });

  it('運営はほかの人のシナリオを直せる', async () => {
    const [owner, admin] = [await login(), await login({ role: 'admin' })];
    const s = await createScenario(owner);
    expect(await status(call('POST', `/my/scenarios/${s.slug}`, admin, { form: { title: '運営が直した', visibility: 'public' } }))).toBe(302);
    expect(await scenarioTitle(s.id)).toBe('運営が直した');
  });
});

describe('ほかの人のパック', () => {
  const packTitle = (id: string) => db().prepare('SELECT title FROM packs WHERE id = ?').bind(id).first<string>('title');

  it('設定を変えられない', async () => {
    const [owner, other] = [await login(), await login()];
    const pack = await createPack({ owner });
    expect(await status(call('GET', `/my/packs/${pack}`, other))).toBe(404);
    expect(await status(call('POST', `/my/packs/${pack}`, other, { form: { title: '乗っ取り', accepts: 'managers' } }))).toBe(404);
    expect(await packTitle(pack)).toBe(`パック ${pack}`);
    // 管理者は変えられる
    expect(await status(call('POST', `/my/packs/${pack}`, owner, { form: { title: '直した', accepts: 'anyone' } }))).toBe(302);
    expect(await packTitle(pack)).toBe('直した');
  });

  it('ファイルを外せない', async () => {
    const [owner, submitter, other] = [await login(), await login(), await login()];
    const pack = await createPack({ owner });
    const sub = await createSubmission(pack, submitter, { state: 'approved' });
    await db().prepare("UPDATE pack_files SET state = 'active' WHERE submission_id = ?").bind(sub).run();
    expect(await status(call('POST', `/my/packs/${pack}/files/remove`, other, { form: { path: 'Bitmap/a.bmp' } }))).toBe(404);
    // 投稿した人でも、パックの管理者でなければ外せない
    expect(await status(call('POST', `/my/submissions/${sub}/remove`, submitter))).toBe(404);
    expect(await db().prepare('SELECT state FROM pack_files WHERE submission_id = ?').bind(sub).first('state')).toBe('active');
  });

  it('zip を組み直せない（組むものの一覧・組み直しの開始）', async () => {
    const [owner, other] = [await login(), await login()];
    const pack = await createPack({ owner });
    expect(await status(call('GET', `/api/packs/${pack}/plan`, other))).toBe(404);
    expect(await status(call('POST', `/api/packs/${pack}/builds`, other, { json: { revision: 0, size: 22 } }))).toBe(404);
    expect(await db().prepare('SELECT COUNT(*) AS n FROM pack_builds WHERE pack_id = ?').bind(pack).first('n')).toBe(0);
    expect(await status(call('GET', `/api/packs/${pack}/plan`, owner))).toBe(200);
  });

  it('サイトのパック（運営が用意したもの）は利用者が管理できない', async () => {
    const user = await login();
    const pack = await createPack({ kind: 'site' });
    // 管理者の表に行があっても、利用者が作ったパックでなければ管理できない
    await db().prepare("INSERT INTO pack_managers (pack_id, user_id, role, created_at) VALUES (?, ?, 'manager', 0)").bind(pack, user.id).run();
    expect(await status(call('GET', `/api/packs/${pack}/plan`, user))).toBe(404);
    expect(await status(call('POST', `/my/packs/${pack}`, user, { form: { title: '乗っ取り' } }))).toBe(404);
    expect(await packTitle(pack)).toBe(`パック ${pack}`);
  });

  it('ほかの人の投稿を取り下げられない・様子を見られない', async () => {
    const [owner, submitter, other] = [await login(), await login(), await login()];
    const pack = await createPack({ owner });
    const sub = await createSubmission(pack, submitter);
    expect(await status(call('POST', `/my/submissions/${sub}/withdraw`, other))).toBe(404);
    expect(await status(call('GET', `/my/submissions/${sub}`, other))).toBe(404);
    expect(await status(call('GET', `/api/pack-submissions/${sub}`, other))).toBe(404);
    expect(await db().prepare('SELECT state FROM pack_submissions WHERE id = ?').bind(sub).first('state')).toBe('pending');
  });

  it('管理者だけが投稿を受け付けるパックには、ほかの人は投稿できない', async () => {
    const [owner, other] = [await login(), await login()];
    const pack = await createPack({ owner });
    await db().prepare("UPDATE packs SET accepts = 'managers' WHERE id = ?").bind(pack).run();
    const body = { json: { size: 100, title: '素材', agree: true } };
    expect(await status(call('POST', `/api/packs/${pack}/submissions`, other, body))).toBe(403);
    expect(await status(call('POST', `/api/packs/${pack}/submissions`, owner, body))).toBe(200);
  });
});

