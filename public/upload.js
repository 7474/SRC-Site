// 新しい版のアップロード（/my/scenarios/:slug）と、パックへの投稿（/my/packs/:id/submit。data-kind="resource"）。
// 上げる先は data-create-url、一緒に送る入力は data-fields（カンマ区切りの name）。アップロードは public/uploader.js
// 1. zip の目次をブラウザで検査する（precheck.js。Worker の検査と同じ規則。素材は .eve が要らない）
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
  const { json, postJson, putPart, wait } = window.SrcUpload;
  const resource = form.dataset.kind === 'resource';
  // lint はシナリオだけ（素材の投稿の画面には lint の選択が無い）
  const hasLint = Boolean(form.lintLevel);
  const lintBox = form.querySelector('.lint');
  const lintConfirm = form.querySelector('.lint-confirm');
  const lintCancel = form.querySelector('.lint-cancel');
  const show = (text, error) => {
    status.textContent = text;
    status.classList.toggle('error', Boolean(error));
  };
  const clearLint = () => {
    if (!hasLint) {
      return;
    }
    lintBox.hidden = true;
    lintConfirm.hidden = true;
    form.lintConfirm.checked = false;
  };
  // 一緒に使うパックの選び（シナリオの版だけ）。lint はここで選んだパックを読む
  const packInputs = [...form.querySelectorAll('input[name=pack]')];
  // 選んだ zip・確かめ方・パックが変わったら lint の結果と確認を消す
  form.file.addEventListener('change', clearLint);
  for (const input of packInputs) {
    input.addEventListener('change', clearLint);
  }
  // 確かめ方は次の投稿でも使う（保存できなくても既定のまま使える）
  try {
    if (!hasLint) {
      throw new Error('lint なし');
    }
    const saved = JSON.parse(localStorage.getItem('upload.lint') || '{}');
    if ([...form.lintLevel.options].some(o => o.value === saved.level)) {
      form.lintLevel.value = saved.level;
    }
    if (typeof saved.assets === 'boolean') {
      form.lintAssets.checked = saved.assets;
    }
  } catch {}
  for (const input of hasLint ? [form.lintLevel, form.lintAssets] : []) {
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
      const checked = await precheck(file, resource ? 'resource' : 'scenario');
      if (!checked.ok) {
        show(`この zip は上げられません: ${checked.reason}`, true);
        return;
      }
      const level = hasLint ? form.lintLevel.value : 'off';
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
      const body = { size: file.size, turnstile: form.querySelector('[name="cf-turnstile-response"]')?.value };
      for (const name of (form.dataset.fields || 'note').split(',')) {
        const input = form.elements[name];
        body[name] = input.type === 'checkbox' ? input.checked : input.value;
      }
      if (packInputs.length) {
        body.packs = packInputs.filter(i => i.checked).map(i => i.value);
      }
      const created = await postJson(form.dataset.createUrl, body);
      const label = created.number ? `第 ${created.number} 版` : 'zip';
      const parts = [];
      for (let n = 1; n <= created.parts; n++) {
        show(`${label}を上げています…（${n}／${created.parts}）`);
        const start = (n - 1) * created.partSize;
        const blob = file.slice(start, Math.min(file.size, start + created.partSize));
        const etag = await putPart(`${created.partsBase}/parts/${n}`, blob,
          loaded => (progress.value = (start + loaded) / file.size * 100));
        parts.push({ partNumber: n, etag });
      }
      show('検査しています…');
      await postJson(`${created.partsBase}/complete`, { parts });
      const v = await wait(created.partsBase);
      if (v && v.done) {
        if (!found.length) {
          show(v.message);
          location.href = v.href;
          return;
        }
        // 確かめた結果を読めるように、頁は移らない
        show(`${v.message}確かめた結果は下のとおりです。`);
        const link = status.appendChild(document.createElement('a'));
        link.href = v.href;
        link.textContent = ' 版の一覧へ';
        return;
      }
      if (v) {
        show(`検査で弾かれました: ${v.note}`, true);
        return;
      }
      show('検査に時間がかかっています。しばらくしてから頁を読み込み直してください。');
    } catch (err) {
      show(String(err.message || err), true);
    } finally {
      button.disabled = false;
    }
  });

  // srcsharp lint と同じ検査（public/lint-ui.js）。汎用データと素材は、いま選んでいるパックからも探す。止めたら null
  function lint(file, assets) {
    const systemArchives = packInputs.filter(i => i.checked).map(i => i.dataset.archive);
    return SrcLint.run(file, { systemArchives, assets, show, progress, cancel: lintCancel });
  }

  // 一覧を出す。confirm なら「問題があっても上げる」も出す
  function showLint(found, confirm) {
    SrcLint.renderTable(lintBox, found);
    lintConfirm.hidden = !confirm;
  }

})();
