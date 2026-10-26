// 新しい版のアップロード（/my/scenarios/:slug）。
// 1. zip の目次をブラウザで検査する（precheck.js。Worker の検査と同じ規則）
// → 1'. データとイベントを lint する（/lint/srclint.js。srcsharp lint と同じ検査と、ラベル・include・素材の参照の静的解析）
//      どこまで確かめるかは投稿者が選ぶ（lintLevel: stop＝エラー・警告があれば止める / warn＝表示して上げる / off＝確かめない）。素材が無いこと（info）では止めない
// → 2. 大きさを送って版を作る
// → 3. パートに分けて上げる（R2 へ直接か Worker を通す） → 4. 完了を知らせる → 5. 検査が済むまで状態を見る
(() => {

  const form = document.getElementById('upload');
  if (!form) {
    return;
  }
  const status = form.querySelector('.status');
  const progress = form.querySelector('progress');
  const button = form.querySelector('button[type=submit]');
  const lintBox = form.querySelector('.lint');
  const lintConfirm = form.querySelector('.lint-confirm');
  const lintCancel = form.querySelector('.lint-cancel');
  const show = (text, error) => {
    status.textContent = text;
    status.classList.toggle('error', Boolean(error));
  };
  const clearLint = () => {
    lintBox.hidden = true;
    lintConfirm.hidden = true;
    form.lintConfirm.checked = false;
  };
  // 選んだ zip か確かめ方が変わったら lint の結果と確認を消す
  form.file.addEventListener('change', clearLint);
  // 確かめ方は次の投稿でも使う（保存できなくても既定のまま使える）
  try {
    const saved = JSON.parse(localStorage.getItem('upload.lint') || '{}');
    if ([...form.lintLevel.options].some(o => o.value === saved.level)) {
      form.lintLevel.value = saved.level;
    }
    if (typeof saved.assets === 'boolean') {
      form.lintAssets.checked = saved.assets;
    }
  } catch {}
  for (const input of [form.lintLevel, form.lintAssets]) {
    input.addEventListener('change', () => {
      clearLint();
      try {
        localStorage.setItem('upload.lint', JSON.stringify({ level: form.lintLevel.value, assets: form.lintAssets.checked }));
      } catch {}
    });
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const file = form.file.files[0];
    if (!file) {
      return;
    }
    if (!/\.zip$/i.test(file.name)) {
      show('zip を選んでください。', true);
      return;
    }
    button.disabled = true;
    progress.hidden = false;
    try {
      show('zip の中身を確かめています…');
      const { precheck } = await import('/static/precheck.js');
      const checked = await precheck(file);
      if (!checked.ok) {
        show(`この zip は上げられません: ${checked.reason}`, true);
        return;
      }
      const level = form.lintLevel.value;
      let found = [];
      if (level !== 'off' && !form.lintConfirm.checked) {
        found = await lint(file, form.lintAssets.checked);
        if (!found) {
          show('確かめるのをやめました。もう一度「上げる」を押すと、初めから確かめます。');
          return;
        }
        progress.value = 0;
        const blocking = found.filter(d => d.severity !== 'info');
        if (found.length) {
          showLint(found, level === 'stop' && blocking.length > 0);
        } else {
          clearLint();
        }
        if (level === 'stop' && blocking.length) {
          show(`問題が ${blocking.length} 件あります。直してから上げ直すか、「問題があっても上げる」を選んで上げてください。`, true);
          return;
        }
      }
      const turnstile = form.querySelector('[name="cf-turnstile-response"]')?.value;
      const created = await json(await fetch(`/api/scenarios/${encodeURIComponent(form.dataset.slug)}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: file.size, note: form.note.value, turnstile }),
      }));
      const parts = [];
      for (let n = 1; n <= created.parts; n++) {
        show(`第 ${created.number} 版を上げています…（${n}／${created.parts}）`);
        const start = (n - 1) * created.partSize;
        const blob = file.slice(start, Math.min(file.size, start + created.partSize));
        const etag = await putPart(`/api/versions/${created.versionId}/parts/${n}`, blob,
          loaded => (progress.value = (start + loaded) / file.size * 100));
        parts.push({ partNumber: n, etag });
      }
      show('検査しています…');
      await json(await fetch(`/api/versions/${created.versionId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts }),
      }));
      for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const v = await json(await fetch(`/api/versions/${created.versionId}`));
        if (v.state === 'published') {
          const href = `/my/scenarios/${encodeURIComponent(v.slug)}?saved=1`;
          if (!found.length) {
            show(`第 ${v.number} 版を公開しました。`);
            location.href = href;
            return;
          }
          // 確かめた結果を読めるように、頁は移らない
          show(`第 ${v.number} 版を公開しました。確かめた結果は下のとおりです。`);
          const link = status.appendChild(document.createElement('a'));
          link.href = href;
          link.textContent = ' 版の一覧へ';
          return;
        }
        if (v.state === 'rejected') {
          show(`検査で弾かれました: ${v.note}`, true);
          return;
        }
      }
      show('検査に時間がかかっています。しばらくしてから頁を読み込み直してください。');
    } catch (err) {
      show(String(err.message || err), true);
    } finally {
      button.disabled = false;
    }
  });

  // srcsharp lint と同じ検査（public/lint-ui.js）。汎用データと素材はこのシナリオが重ねるパックからも探す。止めたら null
  function lint(file, assets) {
    return SrcLint.run(file, { systemArchives: JSON.parse(form.dataset.systemArchives || '[]'), assets, show, progress, cancel: lintCancel });
  }

  // 一覧を出す。confirm なら「問題があっても上げる」も出す
  function showLint(found, confirm) {
    SrcLint.renderTable(lintBox, found);
    lintConfirm.hidden = !confirm;
  }

  async function json(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `エラー（${response.status}）`);
    }
    return body;
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
      xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded);
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


})();
