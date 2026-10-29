// zip を R2 のマルチパートアップロードで上げる（シナリオの版・パックへの投稿・パックの zip の組み直しで共通）。
// API: <partsBase>/parts/<n>（GET で上げ先、PUT で Worker を通して上げる）・<partsBase>/complete・<partsBase>（状態）。src/lib/multipart.ts
window.SrcUpload = (() => {
  async function json(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `エラー（${response.status}）`);
    }
    return body;
  }

  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  }

  // パートを上げ、ETag を返す。上げ先（R2 の署名付き URL か Worker）はパートごとに取る。通信が切れたら少し待って上げ直す
  async function putPart(api, blob, onProgress) {
    const tries = 5;
    for (let i = 1; ; i++) {
      try {
        const target = await json(await fetch(api));
        return await put(target, blob, onProgress);
      } catch (err) {
        if (i >= tries || err.retry === false) {
          throw err;
        }
        await new Promise(r => setTimeout(r, 2000 * i));
      }
    }
  }

  // fetch では送った量が分からないので XMLHttpRequest で送る
  // R2 へ直接上げたときは応答の ETag ヘッダ（バケットの CORS で見せている）、Worker を通したときは応答の JSON の etag
  function put(target, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', target.url);
      xhr.responseType = target.direct ? 'text' : 'json';
      xhr.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = target.direct ? xhr.getResponseHeader('ETag') : xhr.response?.etag;
          etag ? resolve(etag) : reject(new Error('アップロードに失敗しました（ETag がありません）'));
          return;
        }
        const err = new Error((!target.direct && xhr.response?.error) || `アップロードに失敗しました（${xhr.status}）`);
        // 4xx（大きさが違うなど）は上げ直しても変わらない
        err.retry = xhr.status >= 500;
        reject(err);
      };
      xhr.onerror = () => reject(new Error('アップロードに失敗しました（通信）'));
      xhr.send(blob);
    });
  }

  // 状態を見て、検査が済むまで待つ（応答の done・state）
  async function wait(partsBase, onWait) {
    for (let i = 0; i < 600; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await json(await fetch(partsBase));
      if (s.done || s.state === 'rejected') {
        return s;
      }
      onWait && onWait(s);
    }
    return null;
  }

  return { json, postJson, putPart, wait };
})();
