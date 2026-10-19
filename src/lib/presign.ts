// R2 の S3 互換 API への署名付き URL（https://developers.cloudflare.com/r2/api/s3/presigned-urls/）
import { AwsClient } from 'aws4fetch';
import type { Bindings } from '../env';

export const UPLOAD_CONTENT_TYPE = 'application/zip';

export function canPresign(env: Bindings): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

/** PUT の署名付き URL。Content-Type を署名に含め、zip 以外を受け付けない */
export async function presignPut(env: Bindings, key: string, expiresSeconds = 900): Promise<string> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: 's3',
    region: 'auto',
  });
  const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const signed = await client.sign(new Request(url, { method: 'PUT', headers: { 'Content-Type': UPLOAD_CONTENT_TYPE } }), {
    aws: { signQuery: true, allHeaders: true },
  });
  return signed.url;
}
