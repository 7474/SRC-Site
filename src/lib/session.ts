// セッション（D1 の sessions。Cookie には推測できない ID だけを入れる）
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, User } from '../env';
import { now, randomHex } from './util';

export const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;

export async function createSession(c: Context<AppEnv>, userId: number): Promise<void> {
  const id = randomHex(32);
  const expires = now() + SESSION_DAYS * 24 * 3600 * 1000;
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(id, userId, expires).run();
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export async function loadUser(c: Context<AppEnv>): Promise<User | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id || !/^[0-9a-f]{64}$/.test(id)) {
    return null;
  }
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.handle, u.role, u.suspended, u.terms_accepted_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
  ).bind(id, now()).first<User>();
  return row ?? null;
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
