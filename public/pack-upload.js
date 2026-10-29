// 共有パックの投稿。公開前に運営の確認を待つ。
(() => {
  const form = document.getElementById('pack-upload');
  if (!form) {
    return;
  }
  const status = form.querySelector('.status');
  const progress = form.querySelector('progress');
  const button = form.querySelector('button[type=submit]');
  const show = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const file = form.elements.namedItem('file').files[0];
    if (!file || !/\.zip$/i.test(file.name)) {
      show('zip を選んでください。', true);
      return;
    }
    if (file.size <= 0 || file.size > 1024 * 1024 * 1024) {
      show('zip は 1 GB までです。', true);
      return;
    }
    button.disabled = true;
    progress.hidden = false;
    try {
      const created = await json(await fetch('/api/pack-submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: form.elements.namedItem('slug').value,
          title: form.elements.namedItem('title').value,
          description: form.elements.namedItem('description').value,
          sourceName: form.elements.namedItem('sourceName').value,
          sourceUrl: form.elements.namedItem('sourceUrl').value,
          license: form.elements.namedItem('license').value,
          root: form.elements.namedItem('root').value,
          excludesJasrac: form.elements.namedItem('excludesJasrac').checked,
          size: file.size,
          turnstile: form.querySelector('[name="cf-turnstile-response"]')?.value,
        }),
      }));
      const parts = [];
      for (let n = 1; n <= created.parts; n++) {
        show(`zip を上げています…（${n}／${created.parts}）`);
        const start = (n - 1) * created.partSize;
        const blob = file.slice(start, Math.min(file.size, start + created.partSize));
        const etag = await putPart(`/api/pack-submissions/${created.submissionId}/parts/${n}`, blob,
          loaded => (progress.value = (start + loaded) / file.size * 100));
        parts.push({ partNumber: n, etag });
      }
      show('確認に出しています…');
      await json(await fetch(`/api/pack-submissions/${created.submissionId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts }),
      }));
      location.href = '/my/packs?uploaded=1';
    } catch (error) {
      show(String(error.message || error), true);
    } finally {
      button.disabled = false;
    }
  });

  async function json(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `エラー（${response.status}）`);
      error.retry = response.status >= 500;
      throw error;
    }
    return body;
  }

  async function putPart(api, blob, onProgress) {
    for (let attempt = 1; ; attempt++) {
      try {
        const target = await json(await fetch(api));
        return await put(target, blob, onProgress);
      } catch (error) {
        if (attempt >= 5 || error.retry === false) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  function put(target, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', target.url);
      xhr.responseType = target.direct ? 'text' : 'json';
      xhr.upload.onprogress = event => event.lengthComputable && onProgress(event.loaded);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = target.direct ? xhr.getResponseHeader('ETag') : xhr.response?.etag;
          etag ? resolve(etag) : reject(new Error('アップロードに失敗しました（ETag がありません）'));
          return;
        }
        const error = new Error((!target.direct && xhr.response?.error) || `アップロードに失敗しました（${xhr.status}）`);
        error.retry = xhr.status >= 500;
        reject(error);
      };
      xhr.onerror = () => reject(new Error('アップロードに失敗しました（通信）'));
      xhr.send(blob);
    });
  }
})();
