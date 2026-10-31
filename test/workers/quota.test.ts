// 投稿の量の上限（1 人 1 日 10 回・合計 5 GB。シナリオの版とパックへの投稿を合わせて数える）を超える投稿は断る（issue #31 の 4。src/routes/api.ts の overQuota）
import { describe, expect, it } from 'vitest';
import { call, createPack, createScenario, createSubmission, createVersion, db, login, status, type TestUser } from './helpers';

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 3600 * 1000;

const newVersion = (user: TestUser, slug: string, size = 100) => call('POST', `/api/scenarios/${slug}/versions`, user, { json: { size } });
const countVersions = (scenarioId: number) => db().prepare('SELECT COUNT(*) AS n FROM versions WHERE scenario_id = ?').bind(scenarioId).first<number>('n');

/** 版を n 個入れておく（1 版目から） */
async function versions(s: { id: number; slug: string }, n: number, opts: { state?: string; size?: number; createdAt?: number } = {}) {
  for (let i = 1; i <= n; i++) {
    await createVersion(s, { number: i, ...opts });
  }
}

describe('1 日の回数', () => {
  it('24 時間に 10 版上げていれば、11 版目は断る', async () => {
    const user = await login();
    const s = await createScenario(user);
    await versions(s, 10);
    const r = await newVersion(user, s.slug);
    expect(r.status).toBe(429);
    expect((await r.json<{ error: string }>()).error).toContain('1 日 10 回');
    expect(await countVersions(s.id)).toBe(10);
  });

  it('9 版なら上げられる', async () => {
    const user = await login();
    const s = await createScenario(user);
    await versions(s, 9);
    expect(await status(newVersion(user, s.slug))).toBe(200);
    expect(await countVersions(s.id)).toBe(10);
  });

  it('ほかのシナリオの版も合わせて数える', async () => {
    const user = await login();
    await versions(await createScenario(user), 10);
    const s = await createScenario(user);
    expect(await status(newVersion(user, s.slug))).toBe(429);
  });

  it('パックへの投稿も合わせて数える（版 9 + 投稿 1 で、版もパックへの投稿も断る）', async () => {
    const user = await login();
    const s = await createScenario(user);
    await versions(s, 9);
    const pack = await createPack({ owner: await login() });
    await createSubmission(pack, user);
    expect(await status(newVersion(user, s.slug))).toBe(429);
    expect(await status(call('POST', `/api/packs/${pack}/submissions`, user, { json: { size: 100, title: '素材', agree: true } }))).toBe(429);
    expect(await db().prepare('SELECT COUNT(*) AS n FROM pack_submissions WHERE user_id = ?').bind(user.id).first('n')).toBe(1);
  });

  it('24 時間より前の版・弾かれた版は数えない', async () => {
    const user = await login();
    const s = await createScenario(user);
    await versions(s, 10, { createdAt: Date.now() - 2 * DAY });
    const s2 = await createScenario(user);
    await versions(s2, 10, { state: 'rejected' });
    expect(await status(newVersion(user, s.slug))).toBe(200);
  });
});

describe('合計の大きさ', () => {
  it('合計が 5 GB を超える版は断る', async () => {
    const user = await login();
    const s = await createScenario(user);
    // 1 GB の版を 5 つ（日をまたいで上げたもの）で、ちょうど 5 GB
    await versions(s, 5, { size: GB, createdAt: Date.now() - 2 * DAY });
    const r = await newVersion(user, s.slug, 1);
    expect(r.status).toBe(400);
    expect((await r.json<{ error: string }>()).error).toContain('5 GB');
  });

  it('ちょうど 5 GB までは上げられる', async () => {
    const user = await login();
    const s = await createScenario(user);
    await versions(s, 4, { size: GB, createdAt: Date.now() - 2 * DAY });
    expect(await status(newVersion(user, s.slug, GB))).toBe(200);
  });

  it('パックへの投稿も合わせて数える', async () => {
    const user = await login();
    const s = await createScenario(user);
    await versions(s, 4, { size: GB, createdAt: Date.now() - 2 * DAY });
    const pack = await createPack({ owner: await login() });
    await createSubmission(pack, user, { state: 'approved', size: GB, createdAt: Date.now() - 2 * DAY });
    expect(await status(newVersion(user, s.slug, 1))).toBe(400);
    expect(await status(call('POST', `/api/packs/${pack}/submissions`, user, { json: { size: 1, title: '素材', agree: true } }))).toBe(400);
  });

  it('1 つの zip は 1 GB まで', async () => {
    const user = await login();
    const s = await createScenario(user);
    expect(await status(newVersion(user, s.slug, GB + 1))).toBe(400);
    expect(await countVersions(s.id)).toBe(0);
  });
});

describe('運営', () => {
  it('上限を数えない', async () => {
    const admin = await login({ role: 'admin' });
    const s = await createScenario(admin);
    await versions(s, 10, { size: GB });
    expect(await status(newVersion(admin, s.slug))).toBe(200);
  });
});
