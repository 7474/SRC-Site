// 新しい版の「一緒に使う共有パック」（issue #31 の 5）。
// 前の版（公開した版があればその最新、なければ最新の版）から引き継ぎ、上げる画面でパックを選んだときはそれを使う（src/routes/api.ts）
import { describe, expect, it } from 'vitest';
import { call, createPack, createScenario, createVersion, db, login, status, type TestUser } from './helpers';

async function upload(user: TestUser, slug: string, packs?: string[]) {
  const r = await call('POST', `/api/scenarios/${slug}/versions`, user, { json: packs ? { size: 100, packs } : { size: 100 } });
  expect(r.status).toBe(200);
  const { versionId, number } = await r.json<{ versionId: number; number: number }>();
  const row = await db().prepare('SELECT requires, excludes FROM versions WHERE id = ?').bind(versionId).first<{ requires: string; excludes: string }>();
  return { number, requires: JSON.parse(row!.requires) as string[], excludes: JSON.parse(row!.excludes) as string[] };
}

describe('前の版から引き継ぐ', () => {
  it('はじめての版は何も選ばない', async () => {
    const user = await login();
    const s = await createScenario(user);
    expect(await upload(user, s.slug)).toEqual({ number: 1, requires: [], excludes: [] });
  });

  it('前の版の共有パック（使うもの・外すもの）を引き継ぐ', async () => {
    const user = await login();
    const s = await createScenario(user);
    await createVersion(s, { number: 1, requires: ['pack-a'], excludes: ['default-x'] });
    expect(await upload(user, s.slug)).toEqual({ number: 2, requires: ['pack-a'], excludes: ['default-x'] });
  });

  it('公開した版があれば、それより新しい公開していない版より優先する', async () => {
    const user = await login();
    const s = await createScenario(user);
    await createVersion(s, { number: 1, requires: ['old'] });
    await createVersion(s, { number: 2, requires: ['published'] });
    await createVersion(s, { number: 3, state: 'rejected', requires: ['rejected'] });
    await createVersion(s, { number: 4, state: 'uploading', requires: ['uploading'] });
    expect(await upload(user, s.slug)).toMatchObject({ number: 5, requires: ['published'] });
  });

  it('公開した版が無ければ、最新の版から引き継ぐ', async () => {
    const user = await login();
    const s = await createScenario(user);
    await createVersion(s, { number: 1, state: 'rejected', requires: ['first'] });
    await createVersion(s, { number: 2, state: 'rejected', requires: ['second'] });
    expect(await upload(user, s.slug)).toMatchObject({ number: 3, requires: ['second'] });
  });

  it('ほかのシナリオの版からは引き継がない', async () => {
    const user = await login();
    await createVersion(await createScenario(user), { requires: ['other'] });
    const s = await createScenario(user);
    expect(await upload(user, s.slug)).toMatchObject({ requires: [], excludes: [] });
  });
});

describe('上げる画面で選んだパック', () => {
  it('選んだパックを使い、前の版の設定は使わない', async () => {
    const user = await login();
    const chosen = await createPack({ owner: user });
    const inherited = await createPack({ owner: user });
    const s = await createScenario(user);
    await createVersion(s, { requires: [inherited] });
    const v = await upload(user, s.slug, [chosen]);
    expect(v.requires).toEqual([chosen]);
  });

  it('既定のパックは、選ばなければ外す・選べば外さない', async () => {
    const user = await login();
    const [kept, dropped] = [await createPack({ kind: 'site', isDefault: true }), await createPack({ kind: 'site', isDefault: true })];
    const s = await createScenario(user);
    await createVersion(s, { excludes: [kept] });
    const v = await upload(user, s.slug, [kept]);
    expect(v.requires).toEqual([]);
    expect(v.excludes).toContain(dropped);
    expect(v.excludes).not.toContain(kept);
  });

  it('何も選ばなければ（空の一覧）前の版を引き継がず、何も使わない', async () => {
    const user = await login();
    const pack = await createPack({ owner: user });
    const s = await createScenario(user);
    await createVersion(s, { requires: [pack] });
    expect((await upload(user, s.slug, [])).requires).toEqual([]);
  });

  it('zip の無いパック・取り下げたパック・無いパックは選べない', async () => {
    const user = await login();
    const ok = await createPack({ owner: user });
    const unbuilt = await createPack({ owner: user, built: false });
    const withdrawn = await createPack({ owner: user, withdrawn: true });
    const s = await createScenario(user);
    expect((await upload(user, s.slug, [ok, unbuilt, withdrawn, 'no-such-pack'])).requires).toEqual([ok]);
  });
});

// 編集の頁で、上げた版の共有パックを選び直す（/my/versions/:id/packs）。選べるパックは上げる画面と同じ
describe('編集の頁で選び直すパック', () => {
  const settings = async (v: number) => {
    const row = await db().prepare('SELECT requires, excludes FROM versions WHERE id = ?').bind(v).first<{ requires: string; excludes: string }>();
    return { requires: JSON.parse(row!.requires) as string[], excludes: JSON.parse(row!.excludes) as string[] };
  };

  it('zip の無いパック・取り下げたパック・無いパックは選べない', async () => {
    const user = await login();
    const ok = await createPack({ owner: user });
    const unbuilt = await createPack({ owner: user, built: false });
    const withdrawn = await createPack({ owner: user, withdrawn: true });
    const s = await createScenario(user);
    const v = await createVersion(s);
    expect(await status(call('POST', `/my/versions/${v}/packs`, user, { form: { pack: [ok, unbuilt, withdrawn, 'no-such-pack'] } }))).toBe(302);
    expect((await settings(v)).requires).toEqual([ok]);
  });

  it('取り下げた既定のパックは、外すものにも入れない', async () => {
    const user = await login();
    const [usable, withdrawn] = [await createPack({ kind: 'site', isDefault: true }), await createPack({ kind: 'site', isDefault: true, withdrawn: true })];
    const s = await createScenario(user);
    const v = await createVersion(s);
    expect(await status(call('POST', `/my/versions/${v}/packs`, user, { form: { pack: [] } }))).toBe(302);
    const { excludes } = await settings(v);
    expect(excludes).toContain(usable);
    expect(excludes).not.toContain(withdrawn);
  });

  it('編集の頁にも、zip の無いパック・取り下げたパックは出さない', async () => {
    const user = await login();
    const ok = await createPack({ owner: user });
    const unbuilt = await createPack({ owner: user, built: false });
    const withdrawn = await createPack({ owner: user, withdrawn: true });
    const s = await createScenario(user);
    await createVersion(s);
    const r = await call('GET', `/my/scenarios/${s.slug}`, user);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(`value="${ok}"`);
    expect(html).not.toContain(`value="${unbuilt}"`);
    expect(html).not.toContain(`value="${withdrawn}"`);
  });
});
