// SRC-Site の Worker（docs/architecture.md）
import { Hono } from 'hono';
import { withoutPlaceholders, type AppEnv, type Bindings, type InspectMessage } from './env';
import { loadUser } from './lib/session';
import { inspectVersion, sweep } from './lib/inspector';
import { serveObject } from './lib/serve';
import { auth } from './routes/auth';
import { pages } from './routes/pages';
import { api } from './routes/api';
import { files } from './routes/files';
import { admin } from './routes/admin';

const app = new Hono<AppEnv>();

// どの応答にも付ける。ほかのサイトの枠（iframe）には入れない
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};
app.use('*', async (c, next) => {
  await next();
  // 静的アセット・R2 の応答はヘッダを変えられないので、作り直す
  c.res = new Response(c.res.body, c.res);
  for (const [k, v] of Object.entries(SECURITY)) {
    c.res.headers.set(k, v);
  }
});

// SRC#Web（マルチスレッドの WebAssembly）はクロスオリジン分離が要る。/play/ の下だけに付ける
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

app.get('/play', c => c.redirect('/play/'));
app.on(['GET', 'HEAD'], '/play/*', async c => {
  let response = await c.env.ASSETS.fetch(c.req.raw);
  if (response.status === 404) {
    // 静的アセットの上限（1 ファイル 25 MiB）を超える発行物（AOT の dotnet.native.wasm など）は R2 の web/ に置く
    const key = 'web' + decodeURIComponent(new URL(c.req.url).pathname).slice('/play'.length);
    if (!key.includes('..')) {
      const large = await serveObject(c.req.raw, c.env.FILES, key, { 'Cache-Control': 'public, max-age=3600' });
      if (large.status !== 404) {
        response = large;
      }
    }
  }
  const result = new Response(response.body, response);
  for (const [k, v] of Object.entries(ISOLATION)) {
    result.headers.set(k, v);
  }
  return result;
});
app.on(['GET', 'HEAD'], '/static/*', c => c.env.ASSETS.fetch(c.req.raw));
// ブラウザで動く lint（7474/SRC の SRCLintWeb。スレッドを使わないのでクロスオリジン分離は要らない）。投稿の画面が読み込む
app.on(['GET', 'HEAD'], '/lint/*', c => c.env.ASSETS.fetch(c.req.raw));
app.get('/favicon.ico', c => c.env.ASSETS.fetch(new Request(new URL('/static/favicon.ico', c.req.url))));

// ログインしている利用者
app.use('*', async (c, next) => {
  c.set('user', await loadUser(c));
  await next();
});

// 状態を変える要求は同じオリジンからだけ受け付ける（SameSite=Lax の Cookie と合わせて CSRF を防ぐ）
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin');
    const site = c.req.header('Sec-Fetch-Site');
    const self = new URL(c.req.url).origin;
    if ((origin && origin !== self) || (!origin && site && site !== 'same-origin' && site !== 'none')) {
      return c.text('別のサイトからの要求は受け付けません。', 403);
    }
  }
  await next();
});

// 回数の制限（拠点ごとの近似。https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/）
app.use('*', async (c, next) => {
  const user = c.get('user');
  const key = user ? `user:${user.id}` : `ip:${c.req.header('CF-Connecting-IP') ?? 'local'}`;
  // パートのアップロード（1 GB で 32 回）は書き込みの回数に数えない（本人の版に限り、大きさの上限で縛られている）
  const writing = c.req.method !== 'GET' && c.req.method !== 'HEAD' && !/^\/api\/versions\/\d+\/parts\/\d+$/.test(c.req.path);
  const limiter = writing ? c.env.WRITE_LIMITER : c.env.API_LIMITER;
  if (limiter && (c.req.path.startsWith('/api/') || writing)) {
    const { success } = await limiter.limit({ key: `${writing ? 'w' : 'r'}:${key}` });
    if (!success) {
      return c.text('要求が多すぎます。しばらく待ってからやり直してください。', 429);
    }
  }
  await next();
});

app.route('/auth', auth);
app.route('/api', api);
app.route('/admin', admin);
app.route('/', files);
app.route('/', pages);

app.onError((err, c) => {
  console.error(err);
  return c.text('エラーが起きました。', 500);
});

export default {
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(request, withoutPlaceholders(env), ctx),
  async queue(batch: MessageBatch<InspectMessage>, env: Bindings) {
    env = withoutPlaceholders(env);
    for (const message of batch.messages) {
      await inspectVersion(env, message.body.versionId);
      message.ack();
    }
  },
  async scheduled(_event: ScheduledController, env: Bindings) {
    await sweep(withoutPlaceholders(env));
  },
} satisfies ExportedHandler<Bindings, InspectMessage>;
