// zip を R2 のマルチパートアップロードで上げる（シナリオの版・パックへの投稿・パックの組み直しで共通。docs/architecture.md の「投稿」）
// R2 は最後以外のパートが同じ大きさであることを求める（https://developers.cloudflare.com/r2/objects/multipart-objects/）
// - R2 の S3 互換 API の鍵があれば、ブラウザからパートの署名付き URL へ直接上げる（Worker を通さない）
// - 無ければ（ローカル開発など）Worker を通して上げる（Worker の要求の本体は 100 MB まで）
import type { Bindings } from '../env';
import { canPresign, completeMultipartUpload, createMultipartUpload, presignUploadPart, UPLOAD_CONTENT_TYPE } from './presign';

export const PART_SIZE = 32 * 1024 * 1024;

export function partCount(size: number): number {
  return Math.ceil(size / PART_SIZE);
}

export function partLength(size: number, partNumber: number): number {
  return partNumber < partCount(size) ? PART_SIZE : size - PART_SIZE * (partCount(size) - 1);
}

/** アップロード中のもの（versions・pack_submissions・pack_builds の行） */
export type Upload = { r2_key: string; upload_id: string | null; size: number };

export type Part = { partNumber: number; etag: string };

// https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/
export async function startUpload(env: Bindings, key: string): Promise<string> {
  return canPresign(env)
    ? createMultipartUpload(env, key)
    : (await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: UPLOAD_CONTENT_TYPE } })).uploadId;
}

export function validPart(u: Upload, part: number): boolean {
  return Number.isInteger(part) && part >= 1 && part <= partCount(u.size);
}

/** パートの上げ先。direct なら R2 へ直接（応答の ETag ヘッダを完了に渡す）、でなければ selfUrl へ Worker を通して */
export async function partTarget(env: Bindings, u: Upload, part: number, selfUrl: string) {
  if (canPresign(env)) {
    return { url: await presignUploadPart(env, u.r2_key, u.upload_id!, part), direct: true, length: partLength(u.size, part) };
  }
  return { url: selfUrl, direct: false, length: partLength(u.size, part) };
}

/** Worker を通してパートを 1 つ上げる。大きさが違えば null */
export async function putPart(env: Bindings, u: Upload, part: number, request: Request): Promise<Part | null> {
  const length = Number(request.headers.get('Content-Length'));
  if (length !== partLength(u.size, part) || !request.body) {
    return null;
  }
  const uploaded = await env.FILES.resumeMultipartUpload(u.r2_key, u.upload_id!).uploadPart(part, request.body.pipeThrough(new FixedLengthStream(length)));
  return { partNumber: uploaded.partNumber, etag: uploaded.etag };
}

/** マルチパートアップロードを完了し、大きさとパートの数を確かめる。応答は R2 の ETag か、断る理由 */
export async function finishUpload(env: Bindings, u: Upload, body: { parts?: unknown }): Promise<{ ok: true; etag: string } | { ok: false; error: string }> {
  const parts = Array.isArray(body.parts) ? body.parts as Part[] : [];
  if (parts.length !== partCount(u.size) || parts.some((p, i) => p?.partNumber !== i + 1 || typeof p?.etag !== 'string')) {
    return { ok: false, error: 'パートが揃っていません' };
  }
  try {
    if (canPresign(env)) {
      await completeMultipartUpload(env, u.r2_key, u.upload_id!, parts);
    } else {
      await env.FILES.resumeMultipartUpload(u.r2_key, u.upload_id!).complete(parts);
    }
  } catch (e) {
    return { ok: false, error: `アップロードを完了できません（${String((e as Error).message ?? e)}）` };
  }
  // 軽い確かめ: 大きさが申告どおりか、ETag の末尾のパートの数（マルチパートの ETag は「…-パートの数」）が合うか
  const head = await env.FILES.head(u.r2_key);
  if (!head || head.size !== u.size) {
    return { ok: false, error: '大きさが申告と違います' };
  }
  const partsInEtag = head.etag.match(/-(\d+)$/)?.[1];
  if (partsInEtag && Number(partsInEtag) !== parts.length) {
    return { ok: false, error: 'パートの数が合いません' };
  }
  return { ok: true, etag: head.etag };
}
