// パックの管理者でなければ、投稿を承認・却下できない（issue #31 の 3）
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, createPack, createSubmission, db, login, status, type TestUser } from './helpers';

async function snapshot(packId: string, submissionId: number) {
  return {
    state: await db().prepare('SELECT state FROM pack_submissions WHERE id = ?').bind(submissionId).first('state'),
    files: await db().prepare('SELECT state FROM pack_files WHERE submission_id = ?').bind(submissionId).first('state'),
    revision: await db().prepare('SELECT revision FROM packs WHERE id = ?').bind(packId).first('revision'),
  };
}

const PENDING = { state: 'pending', files: 'pending', revision: 0 };

describe('承認', () => {
  async function setup() {
    const [owner, submitter] = [await login(), await login()];
    const pack = await createPack({ owner });
    const sub = await createSubmission(pack, submitter);
    return { owner, submitter, pack, sub };
  }
  const approve = (sub: number, user: TestUser) => status(call('POST', `/my/submissions/${sub}/approve`, user));

  it('管理者でない利用者は承認できない', async () => {
    const { pack, sub } = await setup();
    expect(await approve(sub, await login())).toBe(404);
    expect(await snapshot(pack, sub)).toEqual(PENDING);
  });

  it('投稿した本人でも、管理者でなければ承認できない', async () => {
    const { submitter, pack, sub } = await setup();
    expect(await approve(sub, submitter)).toBe(404);
    expect(await snapshot(pack, sub)).toEqual(PENDING);
  });

  it('ほかのパックの管理者は承認できない', async () => {
    const { pack, sub } = await setup();
    const otherManager = await login();
    await createPack({ owner: otherManager });
    expect(await approve(sub, otherManager)).toBe(404);
    expect(await snapshot(pack, sub)).toEqual(PENDING);
  });

  it('停止された管理者は承認できない', async () => {
    const { owner, pack, sub } = await setup();
    await db().prepare('UPDATE users SET suspended = 1 WHERE id = ?').bind(owner.id).run();
    expect(await approve(sub, owner)).toBe(403);
    expect(await snapshot(pack, sub)).toEqual(PENDING);
  });

  it('管理者でない利用者は却下できない（投稿の zip も消えない）', async () => {
    const { pack, sub } = await setup();
    await env.FILES.put(`pack-submissions/${sub}.zip`, 'zip');
    expect(await status(call('POST', `/my/submissions/${sub}/reject`, await login(), { form: { note: '却下' } }))).toBe(404);
    expect(await snapshot(pack, sub)).toEqual(PENDING);
    expect(await env.FILES.head(`pack-submissions/${sub}.zip`)).not.toBeNull();
  });

  it('作った人（owner）は承認できる。ファイルがパックに入り、revision が上がる', async () => {
    const { owner, pack, sub } = await setup();
    expect(await approve(sub, owner)).toBe(302);
    expect(await snapshot(pack, sub)).toEqual({ state: 'approved', files: 'active', revision: 1 });
    expect(await db().prepare('SELECT reviewed_by FROM pack_submissions WHERE id = ?').bind(sub).first('reviewed_by')).toBe(owner.id);
    // 承認済みのものはもう一度承認できない
    expect(await approve(sub, owner)).toBe(404);
  });

  it('加えられた管理者（manager）も承認できる', async () => {
    const { pack, sub } = await setup();
    const manager = await login();
    await db().prepare("INSERT INTO pack_managers (pack_id, user_id, role, created_at) VALUES (?, ?, 'manager', 0)").bind(pack, manager.id).run();
    expect(await approve(sub, manager)).toBe(302);
    expect((await snapshot(pack, sub)).state).toBe('approved');
  });

  it('運営はどのパックの投稿も承認できる', async () => {
    const { pack, sub } = await setup();
    expect(await approve(sub, await login({ role: 'admin' }))).toBe(302);
    expect((await snapshot(pack, sub)).state).toBe('approved');
  });
});
