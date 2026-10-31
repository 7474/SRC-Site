// workers のテストの道具。ログインは Google を通さず、アプリと同じように sessions に行を入れて sid の Cookie を渡す（src/lib/session.ts）
import { env, exports } from 'cloudflare:workers';
import { SESSION_COOKIE } from '../../src/lib/session';
import { now, randomHex } from '../../src/lib/util';

export const ORIGIN = 'http://localhost';

export type TestUser = { id: number; handle: string; cookie: string };

let serial = 0;
/** テストごとに重ならない名前 */
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++serial}`;

/** 利用者を作り、ログインした状態の Cookie を返す。既定は規約に同意した一般の利用者 */
export async function login(opts: { role?: 'user' | 'admin'; suspended?: boolean; terms?: boolean } = {}): Promise<TestUser> {
  const handle = unique('u');
  const user = await env.DB.prepare(
    'INSERT INTO users (provider, subject, handle, role, suspended, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
  ).bind('test', handle, handle, opts.role ?? 'user', opts.suspended ? 1 : 0, opts.terms === false ? null : now(), now()).first<{ id: number }>();
  const sid = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(sid, user!.id, now() + 3600 * 1000).run();
  return { id: user!.id, handle, cookie: `${SESSION_COOKIE}=${sid}` };
}

type Body = { json?: unknown; form?: Record<string, string | string[]>; bytes?: Uint8Array; origin?: string };

/** Worker に要求を送る（転送は追わない）。状態を変える要求は、origin を指定しなければ同じオリジンから送ったことにする */
export async function call(method: string, path: string, user?: TestUser | null, body: Body = {}): Promise<Response> {
  const headers = new Headers();
  if (user) {
    headers.set('Cookie', user.cookie);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('Origin', body.origin ?? ORIGIN);
  }
  let payload: BodyInit | undefined;
  if (body.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    payload = JSON.stringify(body.json);
  } else if (body.bytes) {
    headers.set('Content-Length', String(body.bytes.length));
    payload = body.bytes;
  } else if (body.form) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body.form)) {
      for (const x of Array.isArray(v) ? v : [v]) {
        form.append(k, x);
      }
    }
    payload = form;
  }
  return exports.default.fetch(new Request(ORIGIN + path, { method, headers, body: payload, redirect: 'manual' }));
}

/** 応答を読み捨てる（読まないと Workers の実行環境が警告する） */
export async function status(response: Response | Promise<Response>): Promise<number> {
  const r = await response;
  await r.arrayBuffer();
  return r.status;
}

export async function createScenario(owner: TestUser, opts: { visibility?: string } = {}) {
  const slug = unique('s');
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO scenarios (slug, owner_id, title, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(slug, owner.id, `題 ${slug}`, opts.visibility ?? 'public', t, t).first<{ id: number }>();
  return { id: row!.id, slug };
}

export async function createVersion(scenario: { id: number; slug: string }, opts: {
  number?: number; state?: string; size?: number; requires?: string[]; excludes?: string[]; createdAt?: number;
} = {}) {
  const number = opts.number ?? 1;
  const row = await env.DB.prepare(
    `INSERT INTO versions (scenario_id, number, state, r2_key, size, etag, requires, excludes, created_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?) RETURNING id`,
  ).bind(
    scenario.id, number, opts.state ?? 'published', `scenarios/${scenario.slug}/${number}.zip`, opts.size ?? 1000,
    JSON.stringify(opts.requires ?? []), JSON.stringify(opts.excludes ?? []), opts.createdAt ?? now(),
  ).first<{ id: number }>();
  return row!.id;
}

/** パックを作る。community なら owner を管理者（owner）にする。built なら zip がある（シナリオの投稿で選べる） */
export async function createPack(opts: { owner?: TestUser; kind?: 'site' | 'community'; isDefault?: boolean; built?: boolean; withdrawn?: boolean } = {}) {
  const id = unique('p');
  const kind = opts.kind ?? 'community';
  const t = now();
  await env.DB.prepare(
    `INSERT INTO packs (id, title, source_name, license, is_default, priority, version, r2_key, size, withdrawn, updated_at, kind, policy, owner_id, accepts)
     VALUES (?, ?, 'テスト', '自由', ?, 200, ?, ?, 0, ?, ?, ?, ?, ?, 'anyone')`,
  ).bind(
    id, `パック ${id}`, opts.isDefault ? 1 : 0, opts.built === false ? '' : '1', opts.built === false ? '' : `packs/${id}/1.zip`,
    opts.withdrawn ? 1 : 0, t, kind, kind === 'community' ? 'free' : null, opts.owner?.id ?? null,
  ).run();
  if (opts.owner && kind === 'community') {
    await env.DB.prepare("INSERT INTO pack_managers (pack_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, opts.owner.id, t).run();
  }
  return id;
}

export async function createSubmission(packId: string, submitter: TestUser, opts: { state?: string; size?: number; createdAt?: number } = {}) {
  const row = await env.DB.prepare(
    `INSERT INTO pack_submissions (pack_id, user_id, title, state, r2_key, size, created_at) VALUES (?, ?, '素材', ?, '', ?, ?) RETURNING id`,
  ).bind(packId, submitter.id, opts.state ?? 'pending', opts.size ?? 1000, opts.createdAt ?? now()).first<{ id: number }>();
  const id = row!.id;
  await env.DB.prepare('UPDATE pack_submissions SET r2_key = ? WHERE id = ?').bind(`pack-submissions/${id}.zip`, id).run();
  await env.DB.prepare(
    "INSERT INTO pack_files (pack_id, submission_id, path, size, compressed_size, crc32, method, offset, state) VALUES (?, ?, 'Bitmap/a.bmp', 10, 10, 0, 0, 0, 'pending')",
  ).bind(packId, id).run();
  return id;
}

export const db = () => env.DB;
