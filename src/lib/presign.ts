// R2 の S3 互換 API（https://developers.cloudflare.com/r2/api/s3/）。ブラウザから R2 へ直接上げるために使う
// - 署名付き URL: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
// - マルチパートアップロード: https://developers.cloudflare.com/r2/objects/multipart-objects/
import { AwsClient } from 'aws4fetch';
import type { Bindings } from '../env';

export const UPLOAD_CONTENT_TYPE = 'application/zip';

export function canPresign(env: Bindings): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

function client(env: Bindings): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: 's3',
    region: 'auto',
  });
}

function objectUrl(env: Bindings, key: string): URL {
  return new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`);
}

/** PUT の署名付き URL。Content-Type を署名に含め、zip 以外を受け付けない */
export async function presignPut(env: Bindings, key: string, expiresSeconds = 900): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const signed = await client(env).sign(new Request(url, { method: 'PUT', headers: { 'Content-Type': UPLOAD_CONTENT_TYPE } }), {
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}

/** マルチパートアップロードを始め、upload id を返す */
export async function createMultipartUpload(env: Bindings, key: string): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set('uploads', '');
  const res = await client(env).fetch(url, { method: 'POST', headers: { 'Content-Type': UPLOAD_CONTENT_TYPE } });
  const body = await res.text();
  const id = body.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!res.ok || !id) {
    throw new Error(`マルチパートアップロードを始められません（${res.status}）`);
  }
  return id;
}

/** パートの PUT の署名付き URL。応答の ETag を完了のときに渡す */
export async function presignUploadPart(env: Bindings, key: string, uploadId: string, partNumber: number, expiresSeconds = 900): Promise<string> {
  const url = objectUrl(env, key);
  url.searchParams.set('partNumber', String(partNumber));
  url.searchParams.set('uploadId', uploadId);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const signed = await client(env).sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } });
  return signed.url;
}

/** マルチパートアップロードを完了する */
export async function completeMultipartUpload(env: Bindings, key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
  const url = objectUrl(env, key);
  url.searchParams.set('uploadId', uploadId);
  const xml = '<CompleteMultipartUpload>'
    + parts.map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join('')
    + '</CompleteMultipartUpload>';
  const res = await client(env).fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml });
  const body = await res.text();
  // 失敗しても 200 で <Error> を返すことがある（S3 の仕様）
  if (!res.ok || body.includes('<Error>')) {
    const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1];
    throw new Error(code ?? String(res.status));
  }
}

/** マルチパートアップロードを取りやめる（上がったパートを消す） */
export async function abortMultipartUpload(env: Bindings, key: string, uploadId: string): Promise<void> {
  const url = objectUrl(env, key);
  url.searchParams.set('uploadId', uploadId);
  await client(env).fetch(url, { method: 'DELETE' });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
