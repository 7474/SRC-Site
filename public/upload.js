// 新しい版のアップロード（/my/scenarios/:slug）。
// 1. 大きさと sha256 を送って版を作る → 2. 返った URL へ PUT（R2 へ直接） → 3. 完了を知らせる → 4. 検査が済むまで状態を見る
(() => {
  // SHA-256（FIPS 180-4）
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  class Sha256 {
    constructor() {
      this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
      this.w = new Uint32Array(64);
      this.buf = new Uint8Array(64);
      this.len = 0;
      this.total = 0;
    }
    update(data) {
      let i = 0;
      this.total += data.length;
      if (this.len > 0) {
        const n = Math.min(64 - this.len, data.length);
        this.buf.set(data.subarray(0, n), this.len);
        this.len += n;
        i = n;
        if (this.len === 64) {
          this.block(this.buf, 0);
          this.len = 0;
        }
      }
      for (; i + 64 <= data.length; i += 64) {
        this.block(data, i);
      }
      if (i < data.length) {
        this.buf.set(data.subarray(i), 0);
        this.len = data.length - i;
      }
    }
    block(d, o) {
      const w = this.w;
      for (let t = 0; t < 16; t++) {
        w[t] = (d[o + t * 4] << 24) | (d[o + t * 4 + 1] << 16) | (d[o + t * 4 + 2] << 8) | d[o + t * 4 + 3];
      }
      for (let t = 16; t < 64; t++) {
        const x = w[t - 15], y = w[t - 2];
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let [a, b, c, dd, e, f, g, h] = this.h;
      for (let t = 0; t < 64; t++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (dd + t1) | 0; dd = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      const H = this.h;
      H[0] += a; H[1] += b; H[2] += c; H[3] += dd; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    hex() {
      const bits = this.total * 8;
      const pad = new Uint8Array(((this.len < 56 ? 56 : 120) - this.len) + 8);
      pad[0] = 0x80;
      const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
      const p = pad.length - 8;
      pad[p] = hi >>> 24; pad[p + 1] = hi >>> 16; pad[p + 2] = hi >>> 8; pad[p + 3] = hi;
      pad[p + 4] = lo >>> 24; pad[p + 5] = lo >>> 16; pad[p + 6] = lo >>> 8; pad[p + 7] = lo;
      const total = this.total;
      this.update(pad);
      this.total = total;
      return [...this.h].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
    }
  }
  // テストから使う
  window.srcSiteSha256 = data => { const h = new Sha256(); h.update(data); return h.hex(); };

  const form = document.getElementById('upload');
  if (!form) {
    return;
  }
  const status = form.querySelector('.status');
  const progress = form.querySelector('progress');
  const button = form.querySelector('button[type=submit]');
  const show = (text, error) => {
    status.textContent = text;
    status.classList.toggle('error', Boolean(error));
  };

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
      show('確かめるための値（sha256）を計算しています…');
      const sha256 = await sha256File(file, ratio => (progress.value = ratio * 100));
      const turnstile = form.querySelector('[name="cf-turnstile-response"]')?.value;
      const created = await json(await fetch(`/api/scenarios/${encodeURIComponent(form.dataset.slug)}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: file.size, sha256, note: form.note.value, turnstile }),
      }));
      show(`第 ${created.number} 版を上げています…`);
      await put(created.uploadUrl, file, created.contentType, ratio => (progress.value = ratio * 100));
      show('検査しています…');
      await json(await fetch(`/api/versions/${created.versionId}/complete`, { method: 'POST' }));
      for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const v = await json(await fetch(`/api/versions/${created.versionId}`));
        if (v.state === 'published') {
          show(`第 ${v.number} 版を公開しました。`);
          location.href = `/my/scenarios/${encodeURIComponent(v.slug)}?saved=1`;
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

  async function json(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `エラー（${response.status}）`);
    }
    return body;
  }

  // fetch では送った量が分からないので XMLHttpRequest で送る
  function put(url, file, contentType, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`アップロードに失敗しました（${xhr.status}）`)));
      xhr.onerror = () => reject(new Error('アップロードに失敗しました（通信）'));
      xhr.send(file);
    });
  }

  // 大きい zip でもメモリに読み切らないよう、少しずつ読んで SHA-256 を計算する（Web Crypto は一括でしか計算できない）
  async function sha256File(file, onProgress) {
    const h = new Sha256();
    const chunk = 4 * 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += chunk) {
      h.update(new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer()));
      onProgress(Math.min(1, (offset + chunk) / file.size));
    }
    return h.hex();
  }

})();
