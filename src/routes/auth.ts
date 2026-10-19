// ログイン（Google の OpenID Connect）とログアウト
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { authorizeUrl, exchangeCode, newLoginState, provisionalHandle, type LoginState } from '../lib/oidc';
import { createSession, destroySession } from '../lib/session';
import { now, sign, unsign } from '../lib/util';

const LOGIN_COOKIE = 'login';

export const auth = new Hono<AppEnv>();

function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/my';
}

function redirectUri(url: string): string {
  return new URL('/auth/callback', url).toString();
}

auth.get('/login', async c => {
  const next = safeNext(c.req.query('next'));
  if (c.env.DEV_LOGIN) {
    // ローカル開発: Google を通さずにログインする（.dev.vars に DEV_LOGIN=1）
    return c.redirect(`/auth/dev?next=${encodeURIComponent(next)}`);
  }
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.SESSION_SECRET) {
    return c.text('ログインの設定（GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・SESSION_SECRET）がされていません。', 503);
  }
  const state = newLoginState(next);
  setCookie(c, LOGIN_COOKIE, await sign(c.env.SESSION_SECRET, btoa(JSON.stringify(state))), {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth', maxAge: 600,
  });
  return c.redirect(await authorizeUrl(c.env.GOOGLE_CLIENT_ID, redirectUri(c.req.url), state));
});

auth.get('/callback', async c => {
  const secret = c.env.SESSION_SECRET;
  const raw = getCookie(c, LOGIN_COOKIE);
  deleteCookie(c, LOGIN_COOKIE, { path: '/auth' });
  if (!secret || !raw || !c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text('ログインをやり直してください。', 400);
  }
  const value = await unsign(secret, raw);
  if (!value) {
    return c.text('ログインをやり直してください。', 400);
  }
  const state = JSON.parse(atob(value)) as LoginState;
  const code = c.req.query('code');
  if (!code || c.req.query('state') !== state.state) {
    return c.text('ログインをやり直してください。', 400);
  }
  let sub: string;
  try {
    sub = await exchangeCode(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, redirectUri(c.req.url), code, state);
  } catch (e) {
    console.error('login failed', e);
    return c.text('ログインに失敗しました。', 400);
  }
  const userId = await findOrCreateUser(c.env.DB, 'google', sub);
  await createSession(c, userId);
  return c.redirect(state.next);
});

auth.get('/dev', async c => {
  if (!c.env.DEV_LOGIN) {
    return c.notFound();
  }
  const name = c.req.query('as') ?? 'dev';
  const userId = await findOrCreateUser(c.env.DB, 'dev', name);
  if (c.req.query('admin') === '1') {
    await c.env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(userId).run();
  }
  await createSession(c, userId);
  return c.redirect(safeNext(c.req.query('next')));
});

auth.post('/logout', async c => {
  await destroySession(c);
  return c.redirect('/');
});

async function findOrCreateUser(db: D1Database, provider: string, subject: string): Promise<number> {
  const existing = await db.prepare('SELECT id FROM users WHERE provider = ? AND subject = ?').bind(provider, subject).first<{ id: number }>();
  if (existing) {
    return existing.id;
  }
  const handle = await provisionalHandle(subject);
  const row = await db.prepare('INSERT INTO users (provider, subject, handle, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(provider, subject, handle, now()).first<{ id: number }>();
  return row!.id;
}
