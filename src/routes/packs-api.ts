// パックへの投稿と、パックの zip の組み直しの API（docs/resources.md）
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from './common';
import { MAX_FILE, overQuota } from './api';
import { verifyTurnstile } from '../lib/turnstile';
import { canPresign } from '../lib/presign';
import { finishUpload, PART_SIZE, partCount, partTarget, putPart, startUpload, validPart, type Upload } from '../lib/multipart';
import { activeFiles, canManage, canSubmit, getPack, retireSubmissions, type Submission } from '../lib/packs';
import { packZipProblem, packZipSize, verifyPackZip } from '../lib/packzip';
import { policyOf } from '../lib/policy';
import { r2Reader, readEntries, ZipError } from '../lib/zip';
import { now } from '../lib/util';

export const packApi = new Hono<AppEnv>();

packApi.use('/packs/*', requireUser);
packApi.use('/pack-submissions/*', requireUser);
packApi.use('/pack-builds/*', requireUser);

// ── 投稿 ──

// 投稿を作り、アップロード先を返す
packApi.post('/packs/:id/submissions', async c => {
  const user = c.get('user')!;
  const pack = await getPack(c.env.DB, c.req.param('id'));
  if (!pack || !(await canSubmit(c.env.DB, user, pack))) {
    return c.json({ error: user.terms_accepted_at ? 'このパックには投稿できません' : '利用規約に同意してください（設定の頁）' }, 403);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const text = (key: string, max: number) => String(body[key] ?? '').trim().slice(0, max);
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE) {
    return c.json({ error: 'zip は 1 GB までです' }, 400);
  }
  const title = text('title', 100);
  const license = text('license', 5000);
  const policy = policyOf(pack.policy);
  if (!title) {
    return c.json({ error: '題名を入れてください' }, 400);
  }
  if (body.agree !== true && body.agree !== '1') {
    return c.json({ error: `パックの管理ポリシー（${policy?.title ?? pack.policy}）に同意してください` }, 400);
  }
  if (policy?.requiresLicense && !license) {
    return c.json({ error: 'このパックでは「ライセンス・配布の条件」を書いてください' }, 400);
  }
  if (!(await verifyTurnstile(c.env, body.turnstile as string | undefined, c.req.header('CF-Connecting-IP')))) {
    return c.json({ error: '確認に失敗しました。頁を読み込み直してください' }, 400);
  }
  const over = await overQuota(c.env.DB, user, size);
  if (over) {
    return c.json({ error: over.error }, over.status);
  }
  const row = await c.env.DB.prepare(
    `INSERT INTO pack_submissions (pack_id, user_id, title, author, license, state, r2_key, size, created_at)
     VALUES (?, ?, ?, ?, ?, 'uploading', '', ?, ?) RETURNING id`,
  ).bind(pack.id, user.id, title, text('author', 100) || null, license || null, size, now()).first<{ id: number }>();
  const id = row!.id;
  const key = `pack-submissions/${id}.zip`;
  const uploadId = await startUpload(c.env, key);
  await c.env.DB.prepare('UPDATE pack_submissions SET r2_key = ?, upload_id = ? WHERE id = ?').bind(key, uploadId, id).run();
  return c.json({ id, partSize: PART_SIZE, parts: partCount(size), partsBase: `/api/pack-submissions/${id}` });
});

async function ownSubmission(c: any): Promise<Submission | null> {
  const s = await c.env.DB.prepare('SELECT * FROM pack_submissions WHERE id = ?').bind(Number(c.req.param('id'))).first();
  return s && s.user_id === c.get('user').id ? s : null;
}

// アップロードのパート（シナリオの版と同じ。/api/versions/:id/parts/:part）
function multipartRoutes<T extends Upload & { id: number; state: string }>(
  base: string, load: (c: any) => Promise<T | null>, onComplete: (c: any, row: T, etag: string) => Promise<Response>,
) {
  const uploading = async (c: any) => {
    const row = await load(c);
    const part = Number(c.req.param('part'));
    if (!row || row.state !== 'uploading' || !row.upload_id) {
      return { error: c.json({ error: 'アップロード中のものがありません' }, 404) };
    }
    if (!validPart(row, part)) {
      return { error: c.json({ error: 'パートの番号が不正です' }, 400) };
    }
    return { row, part };
  };
  packApi.get(`${base}/:id/parts/:part`, async c => {
    const found = await uploading(c);
    return found.error ?? c.json(await partTarget(c.env, found.row!, found.part!, `/api${base}/${found.row!.id}/parts/${found.part}`));
  });
  packApi.put(`${base}/:id/parts/:part`, async c => {
    if (canPresign(c.env)) {
      return c.json({ error: 'パートは R2 へ直接上げてください' }, 400);
    }
    const found = await uploading(c);
    if (found.error) {
      return found.error;
    }
    const uploaded = await putPart(c.env, found.row!, found.part!, c.req.raw);
    return uploaded ? c.json(uploaded) : c.json({ error: '大きさが申告と違います' }, 400);
  });
  packApi.post(`${base}/:id/complete`, async c => {
    const row = await load(c);
    if (!row || row.state !== 'uploading') {
      return c.json({ error: 'アップロード中のものがありません' }, 404);
    }
    const done = await finishUpload(c.env, row, await c.req.json().catch(() => ({})));
    if (!done.ok) {
      return c.json({ error: done.error }, 400);
    }
    return onComplete(c, row, done.etag);
  });
}

multipartRoutes('/pack-submissions', ownSubmission, async (c, s, etag) => {
  await c.env.DB.prepare("UPDATE pack_submissions SET state = 'inspecting', upload_id = NULL, etag = ? WHERE id = ?").bind(etag, s.id).run();
  await c.env.INSPECT.send({ submissionId: s.id });
  return c.json({ state: 'inspecting' });
});

packApi.get('/pack-submissions/:id', async c => {
  const s = await ownSubmission(c);
  if (!s) {
    return c.json({ error: '投稿がありません' }, 404);
  }
  return c.json({
    id: s.id, state: s.state, note: s.inspect_note,
    done: s.state === 'pending' || s.state === 'approved',
    message: '検査に通りました。パックの管理者の承認を待っています。',
    href: `/my/submissions/${s.id}`,
  });
});

// ── zip への反映（承認者のブラウザが組む） ──

// いまの利用者が管理できる、利用者が作ったパック（運営はどれも）。無い・管理できなければ null
async function managedPack(c: any, id: string = c.req.param('id')) {
  const pack = await getPack(c.env.DB, id);
  return pack && pack.kind === 'community' && (await canManage(c.env.DB, c.get('user'), pack)) ? pack : null;
}

// 組むもの: パックに入れるファイルと、それがある投稿の zip
packApi.get('/packs/:id/plan', async c => {
  const pack = await managedPack(c);
  if (!pack) {
    return c.json({ error: 'パックがありません' }, 404);
  }
  const files = await activeFiles(c.env.DB, pack.id);
  return c.json({ revision: pack.revision, size: packZipSize(files), problem: packZipProblem(files), files });
});

packApi.post('/packs/:id/builds', async c => {
  const pack = await managedPack(c);
  if (!pack) {
    return c.json({ error: 'パックがありません' }, 404);
  }
  const body = await c.req.json<{ revision?: number; size?: number }>().catch(() => ({} as { revision?: number; size?: number }));
  if (body.revision !== pack.revision) {
    return c.json({ error: 'パックの中身が変わりました。頁を読み込み直してください' }, 409);
  }
  const files = await activeFiles(c.env.DB, pack.id);
  const problem = packZipProblem(files);
  if (problem) {
    return c.json({ error: problem }, 400);
  }
  const size = packZipSize(files);
  if (body.size !== size) {
    return c.json({ error: `大きさが合いません（${body.size}、期待 ${size}）` }, 400);
  }
  const row = await c.env.DB.prepare(
    `INSERT INTO pack_builds (pack_id, user_id, revision, state, r2_key, size, created_at) VALUES (?, ?, ?, 'uploading', '', ?, ?) RETURNING id`,
  ).bind(pack.id, c.get('user')!.id, pack.revision, size, now()).first<{ id: number }>();
  const id = row!.id;
  const key = `packs/${pack.id}/build-${id}.zip`;
  const uploadId = await startUpload(c.env, key);
  await c.env.DB.prepare('UPDATE pack_builds SET r2_key = ?, upload_id = ? WHERE id = ?').bind(key, uploadId, id).run();
  return c.json({ id, partSize: PART_SIZE, parts: partCount(size), partsBase: `/api/pack-builds/${id}` });
});

type BuildRow = Upload & { id: number; pack_id: string; user_id: number; revision: number; state: string };

// 自分が始めた組み直し。始めたあとに管理者から外れた・止められたときなどは続けさせないよう、いまも管理できるかを確かめ直す
async function ownBuild(c: any): Promise<BuildRow | null> {
  const b = await c.env.DB.prepare('SELECT * FROM pack_builds WHERE id = ?').bind(Number(c.req.param('id'))).first();
  return b && b.user_id === c.get('user').id && (await managedPack(c, b.pack_id)) ? b : null;
}

// 上がった zip の目次を、パックに入れるファイルと照らし合わせてから、パックの版にする
multipartRoutes('/pack-builds', ownBuild, async (c, b, etag) => {
  const fail = async (error: string, status: 400 | 409 = 400) => {
    await c.env.DB.prepare("UPDATE pack_builds SET state = 'rejected', upload_id = NULL, note = ? WHERE id = ?").bind(error, b.id).run();
    await c.env.FILES.delete(b.r2_key);
    return c.json({ error }, status);
  };
  const pack = await getPack(c.env.DB, b.pack_id);
  if (!pack || pack.revision !== b.revision) {
    return fail('組んでいるあいだにパックの中身が変わりました。もう一度反映してください', 409);
  }
  let problem: string | null;
  try {
    problem = verifyPackZip(await readEntries(r2Reader(c.env.FILES, b.r2_key, b.size)), await activeFiles(c.env.DB, pack.id), b.size);
  } catch (e) {
    if (!(e instanceof ZipError)) {
      throw e;
    }
    problem = e.message;
  }
  if (problem) {
    return fail(`組んだ zip が合いません: ${problem}`);
  }
  const version = `${b.id}-${etag.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)}`;
  const result = await c.env.DB.prepare(
    `UPDATE packs SET version = ?, r2_key = ?, size = ?, built_revision = ?, updated_at = ? WHERE id = ? AND revision = ?`,
  ).bind(version, b.r2_key, b.size, b.revision, now(), pack.id, b.revision).run();
  if (!result.meta.changes) {
    return fail('組んでいるあいだにパックの中身が変わりました。もう一度反映してください', 409);
  }
  await c.env.DB.prepare("UPDATE pack_builds SET state = 'published', upload_id = NULL WHERE id = ?").bind(b.id).run();
  // 前の版の zip は、読み込み中の人のために 1 つ残し、それより古いものを消す
  const old = (await c.env.DB.prepare(
    "SELECT id, r2_key FROM pack_builds WHERE pack_id = ? AND state = 'published' AND id < ? ORDER BY id DESC LIMIT -1 OFFSET 1",
  ).bind(pack.id, b.id).all()).results as { id: number; r2_key: string }[];
  for (const o of old) {
    await c.env.FILES.delete(o.r2_key);
    await c.env.DB.prepare("UPDATE pack_builds SET state = 'retired' WHERE id = ?").bind(o.id).run();
  }
  await retireSubmissions(c.env, pack.id);
  return c.json({ state: 'published', version });
});
