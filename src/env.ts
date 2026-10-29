// Worker の環境（wrangler.jsonc のバインディングと Secret）
export type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  INSPECT: Queue<InspectMessage>;
  API_LIMITER?: RateLimit;
  WRITE_LIMITER?: RateLimit;
  SITE_NAME: string;
  R2_BUCKET: string;
  // 通報の Google フォームの URL。{url}・{title} をシナリオの URL・題に置き換える（事前入力）。無ければ通報の案内を出さない
  REPORT_FORM_URL?: string;
  // Secret（無ければその機能を使わない）
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  // ローカル開発用: Google を通さずにログインする（wrangler dev の .dev.vars でだけ設定する）
  DEV_LOGIN?: string;
};

// 設定前の Secret に入れておく値。この値の Secret は無いものとして扱う（docs/operations.md）
export const PLACEHOLDER = 'PLACEHOLDER';
const SECRETS = [
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET',
] as const;

/** 仮の値（PLACEHOLDER）の Secret を除いた環境 */
export function withoutPlaceholders(env: Bindings): Bindings {
  if (!SECRETS.some(k => env[k] === PLACEHOLDER)) {
    return env;
  }
  const result = { ...env };
  for (const k of SECRETS) {
    if (result[k] === PLACEHOLDER) {
      delete result[k];
    }
  }
  return result;
}

// 版（シナリオ）か、パックへの投稿の検査
export type InspectMessage = { versionId: number; submissionId?: undefined } | { submissionId: number; versionId?: undefined };

export type User = {
  id: number;
  handle: string;
  role: 'user' | 'admin';
  suspended: number;
  terms_accepted_at: number | null;
};

export type Variables = {
  user: User | null;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
