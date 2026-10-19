// 配信したサイトを外から確かめる（読むだけ。投稿・ログインはしない）。docs/operations.md の「配信」
// 使い方: node scripts/check-site.mjs [https://src.koudenpa.net]
import assert from 'node:assert/strict';

const base = (process.argv[2] ?? 'https://src.koudenpa.net').replace(/\/$/, '');
const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
const step = name => console.log(`✓ ${name}`);

let res = await get('/');
assert.equal(res.status, 200);
assert.match(res.headers.get('Cache-Control') ?? '', /no-store/);
assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
let html = await res.text();
assert.match(html, /SRC#Web で遊ぶ/);
assert.match(html, /href="\/static\/site\.css"/);
assert.equal((await get('/static/site.css')).status, 200);
step('トップ・ヘッダ・CSS');

res = await get('/packs');
html = await res.text();
const packs = [...html.matchAll(/href="\/packs\/([a-z0-9-]+)"/g)].map(m => m[1]);
assert.ok(packs.length >= 1, '共有パックが 1 つ以上ある');
res = await get(`/packs/${packs[0]}`);
html = await res.text();
const zip = html.match(/\/files\/packs\/[a-z0-9-]+\/[0-9a-f]+\.zip/)?.[0];
assert.ok(zip, 'パックの頁に zip へのリンクがある');
step(`共有パック（${packs.length} 件: ${packs.join('・')}）`);

res = await get(zip, { method: 'HEAD' });
assert.equal(res.status, 200);
assert.match(res.headers.get('Cache-Control') ?? '', /immutable/);
assert.ok(res.headers.get('ETag'));
res = await get(zip, { headers: { Range: 'bytes=0-3' } });
assert.equal(res.status, 206);
assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
step('パックの zip（キャッシュ・ETag・Range）');

res = await get('/api/catalog.json');
assert.equal(res.status, 200);
assert.match(res.headers.get('Cache-Control') ?? '', /public/);
const catalog = await res.json();
assert.ok(Array.isArray(catalog.entries));
assert.equal((await get('/api/catalog/no-such-scenario.json')).status, 404);
step(`カタログ（${catalog.entries.filter(e => e.kind !== 'asset').length} 本）`);

res = await get('/play/');
assert.equal(res.status, 200);
assert.equal(res.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
assert.equal(res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
const config = await (await get('/play/srcweb.json')).json();
assert.equal(config.allowUserCatalogs, false);
assert.equal(config.ratingConfirm, undefined);
html = await (await get('/play/')).text();
assert.match(html, /<base href="\/play\/" \/>/);
step('SRC#Web（クロスオリジン分離・srcweb.json）');

res = await get('/my');
assert.equal(res.status, 302);
assert.equal(res.headers.get('Location'), '/auth/login?next=%2Fmy');
res = await get('/auth/login');
assert.equal(res.status, 302);
const login = new URL(res.headers.get('Location'));
assert.equal(login.origin, 'https://accounts.google.com');
assert.equal(login.searchParams.get('redirect_uri'), `${base}/auth/callback`);
assert.equal(login.searchParams.get('scope'), 'openid');
assert.equal(login.searchParams.get('code_challenge_method'), 'S256');
step('ログイン（Google へ PKCE で転送）');

assert.equal((await get('/admin')).status, 404, '運営の頁はログインしていなければ見えない');
res = await get('/my/scenarios/new', { method: 'POST', headers: { Origin: 'https://evil.example' } });
assert.equal(res.status, 403, '別のサイトからの POST は断る');
assert.equal((await get('/scenarios/no-such-scenario')).status, 404);
assert.equal((await get('/s/old-path')).status, 404);
step('運営の頁・CSRF・404');

html = await (await get('/about/rights')).text();
assert.match(html, /docs\.google\.com\/forms/);
assert.equal((await get('/about/terms')).status, 200);
step('規約・権利者の方へ（通報のフォーム）');

console.log('すべて成功');
