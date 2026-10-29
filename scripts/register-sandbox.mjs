// サンドボックス（sandbox/README.md）を、手元の wrangler dev（DEV_LOGIN=1）に入れる。
// パックを作って投稿・承認・zip への反映をし、シナリオを投稿してパックを選ぶ。本番では画面から同じ順に行う
// 使い方: python3 -I scripts/make-sandbox.py && node scripts/register-sandbox.mjs [http://127.0.0.1:8787]
// zip の組み直しには dist/static/packbuild.js（scripts/assemble.sh が作る）を使う
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const out = new URL('../out/sandbox/', import.meta.url);
const { buildPack, partWriter, WindowReader } = await import(new URL('../dist/static/packbuild.js', import.meta.url));

// ブラウザの代わり（Cookie を持ち、同じオリジンの Origin を付ける）
const cookies = new Map();
async function req(path, init = {}) {
  const headers = new Headers(init.headers);
  if (cookies.size) {
    headers.set('Cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
  }
  if (init.method && init.method !== 'GET') {
    headers.set('Origin', base);
  }
  const res = await fetch(base + path, { ...init, headers, redirect: 'manual' });
  for (const c of res.headers.getSetCookie()) {
    const [k, v] = c.split(';')[0].split('=');
    cookies.set(k, v);
  }
  return res;
}
const form = (path, data) => req(path, { method: 'POST', body: new URLSearchParams(data) });
async function json(path, body) {
  const res = await req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await res.json();
  assert.ok(res.ok, `${path}: ${value.error}`);
  return value;
}

// zip を上げる（シナリオの版・パックへの投稿・パックの組み直しで同じ API の形）
async function upload(data, createUrl, extra = {}) {
  const created = await json(createUrl, { size: data.length, ...extra });
  const parts = [];
  for (let n = 1; n <= created.parts; n++) {
    const target = await (await req(`${created.partsBase}/parts/${n}`)).json();
    const body = data.subarray((n - 1) * created.partSize, n * created.partSize);
    parts.push(await (await req(target.url, { method: 'PUT', body })).json());
  }
  await json(`${created.partsBase}/complete`, { parts });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const state = await (await req(created.partsBase)).json();
    if (state.done || state.state === 'rejected') {
      assert.ok(state.done, state.note);
      return { ...state, id: created.id };
    }
  }
  throw new Error('検査が終わりません');
}

// 承認者のブラウザの代わりに、パックの zip を組んで上げる
async function build(packId) {
  const plan = await (await req(`/api/packs/${packId}/plan`)).json();
  const created = await json(`/api/packs/${packId}/builds`, { revision: plan.revision, size: plan.size });
  const parts = [];
  const writer = partWriter(created.partSize, async (n, body) => {
    const target = await (await req(`${created.partsBase}/parts/${n}`)).json();
    parts.push(await (await req(target.url, { method: 'PUT', body })).json());
  });
  await buildPack(plan, { write: c => writer.write(c) }, source => new WindowReader(async (o, l) => {
    const res = await req(source, { headers: { Range: `bytes=${o}-${o + l - 1}` } });
    return new Uint8Array(await res.arrayBuffer());
  }));
  await writer.flush();
  return json(`${created.partsBase}/complete`, { parts });
}

await req('/auth/dev?as=sandbox&admin=1&next=/my');
await form('/my', { handle: 'sandbox-admin', terms: '1' });

let res = await form('/my/packs/new', {
  id: 'sandbox-assets',
  title: '【テスト用・生成AI製】サンドボックス素材',
  description: '※生成AIで作ったテスト用の素材です。サイトの動作確認のために、生成AI（Claude）がプログラムで作りました。絵は単純な図形、音楽と効果音は単純な音の並びで、作品に使うための素材ではありません。シナリオ「【テスト用・生成AI製】サンドボックス」が使います。',
  policy: 'free',
  accepts: 'managers',
});
assert.equal(res.headers.get('Location'), '/my/packs/sandbox-assets', 'パックを作れません（もう入っていれば、手元の D1 を消してからやり直す）');
const submission = await upload(readFileSync(new URL('sandbox-pack.zip', out)), '/api/packs/sandbox-assets/submissions', {
  title: '【テスト用・生成AI製】サンドボックス素材', license: '生成AI（Claude）で作ったテスト用の素材。CC0-1.0', agree: true,
});
await form(`/my/submissions/${submission.id}/approve`, {});
const { version } = await build('sandbox-assets');
console.log(`パック sandbox-assets を反映しました（版 ${version}）`);

res = await form('/my/scenarios/new', {
  slug: 'sandbox',
  title: '【テスト用・生成AI製】サンドボックス',
  author: '生成AI（Claude）',
  description: '※生成AIで作ったテスト用のシナリオです。サイトの動作確認（SRC#Web で遊ぶ・共有パックの読み込み・BGM・データビューア）のために、生成AI（Claude）で作りました。作品として遊ぶためのものではありません。敵を 1 体倒すと終わります。画像・音楽・効果音も生成AIで作ったテスト用のもので、共有パック「【テスト用・生成AI製】サンドボックス素材」から読み込みます。',
  license: 'CC0-1.0。文章・データ・マップ・画像・音は生成AI（Claude）で作ったテスト用のもの',
  tags: 'テスト 生成AI',
  visibility: 'public',
});
assert.equal(res.headers.get('Location'), '/my/scenarios/sandbox');
await upload(readFileSync(new URL('sandbox-scenario.zip', out)), '/api/scenarios/sandbox/versions');
const edit = await (await req('/my/scenarios/sandbox')).text();
const versionId = /\/my\/versions\/(\d+)\/packs/.exec(edit)[1];
// 既定のパックはそのままにし、サンドボックス素材を足す
const defaults = [...edit.matchAll(/name="pack" value="([^"]+)" checked/g)].map(m => m[1]);
await req(`/my/versions/${versionId}/packs`, { method: 'POST', body: new URLSearchParams([...defaults, 'sandbox-assets'].map(p => ['pack', p])) });
const catalog = await (await req('/api/catalog/sandbox.json')).json();
assert.ok(catalog.entries[0].requires.includes('sandbox-assets'));
console.log(`シナリオ sandbox を入れました（重ねるパック: ${catalog.entries[0].requires.join(', ')}）`);
console.log(`${base}/scenarios/sandbox`);
