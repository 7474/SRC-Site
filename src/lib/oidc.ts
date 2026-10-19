// Google の OpenID Connect（https://developers.google.com/identity/openid-connect/openid-connect）
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { base64url, randomHex, sha256Hex } from './util';

export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export type LoginState = { state: string; nonce: string; verifier: string; next: string };

export function newLoginState(next: string): LoginState {
  return { state: randomHex(16), nonce: randomHex(16), verifier: base64url(crypto.getRandomValues(new Uint8Array(32))), next };
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function authorizeUrl(clientId: string, redirectUri: string, s: LoginState): Promise<string> {
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', s.state);
  url.searchParams.set('nonce', s.nonce);
  url.searchParams.set('code_challenge', await challenge(s.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/** 認可コードを ID トークンに替えて検証し、利用者の sub を返す */
export async function exchangeCode(clientId: string, clientSecret: string, redirectUri: string, code: string, s: LoginState): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: s.verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(`token endpoint: ${response.status}`);
  }
  const body = await response.json<{ id_token?: string }>();
  if (!body.id_token) {
    throw new Error('id_token がありません');
  }
  const { payload } = await jwtVerify(body.id_token, GOOGLE_JWKS, { issuer: GOOGLE_ISSUERS, audience: clientId });
  if (payload.nonce !== s.nonce) {
    throw new Error('nonce が一致しません');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('sub がありません');
  }
  return payload.sub;
}

/** 利用者を作るときの仮の表示名 */
export async function provisionalHandle(sub: string): Promise<string> {
  return 'user-' + (await sha256Hex(sub + randomHex(4))).slice(0, 8);
}
