// Turnstile（https://developers.cloudflare.com/turnstile/get-started/server-side-validation/）。
// TURNSTILE_SECRET が無ければ検証しない（ローカル開発・設定前）
import type { Bindings } from '../env';

export async function verifyTurnstile(env: Bindings, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    return true;
  }
  if (!token) {
    return false;
  }
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) {
    form.append('remoteip', ip);
  }
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const result = await response.json<{ success: boolean }>();
  return result.success === true;
}
