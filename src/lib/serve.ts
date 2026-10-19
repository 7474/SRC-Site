// R2 のオブジェクトを返す（Range・ETag・条件付き要求に対応）。src-host の worker.js と同じ
export async function serveObject(request: Request, bucket: R2Bucket, key: string, extra: Record<string, string> = {}): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const object = request.method === 'HEAD'
    ? await bucket.head(key)
    : await bucket.get(key, {
      // Range 要求のときだけ範囲を指定する（指定すると全体でも range が付き 206 になるため）
      ...(request.headers.has('Range') ? { range: request.headers } : {}),
      onlyIf: request.headers,
    });
  if (!object) {
    return new Response('Not Found', { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', contentType(key));
  }
  headers.set('ETag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }
  if (request.method === 'HEAD' || !('body' in object) || !object.body) {
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: request.method === 'HEAD' ? 200 : 304, headers });
  }
  const body = object as R2ObjectBody;
  if (request.headers.has('Range') && body.range && 'offset' in body.range) {
    const start = body.range.offset ?? 0;
    const length = body.range.length ?? body.size - start;
    headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${body.size}`);
    headers.set('Content-Length', String(length));
    return new Response(body.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(body.size));
  return new Response(body.body, { status: 200, headers });
}

export function contentType(key: string): string {
  const types: Record<string, string> = {
    '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.dat': 'application/octet-stream', '.zip': 'application/zip', '.html': 'text/html; charset=utf-8',
  };
  const dot = key.lastIndexOf('.');
  return (dot >= 0 && types[key.slice(dot)]) || 'application/octet-stream';
}
