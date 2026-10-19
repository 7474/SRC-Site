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

export type InspectMessage = { versionId: number };

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
