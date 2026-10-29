import { SLUG_PATTERN } from './util';

export const MAX_PACK_SIZE = 1024 * 1024 * 1024;

export type PackSubmissionInput = {
  slug: string;
  title: string;
  description: string;
  sourceName: string;
  sourceUrl: string;
  license: string;
  root: string;
  size: number;
  excludesJasrac: boolean;
};

export type PackSubmissionRow = {
  id: number;
  owner_id: number;
  slug: string;
  title: string;
  description: string | null;
  source_name: string;
  source_url: string | null;
  license: string;
  root: string | null;
  excludes_jasrac: number;
  size: number;
  r2_key: string;
  upload_id: string | null;
  status: 'uploading' | 'pending' | 'approved' | 'rejected';
  review_note: string | null;
  reviewed_by: number | null;
  created_at: number;
  reviewed_at: number | null;
};

export function parsePackSubmissionInput(value: unknown): { input: PackSubmissionInput } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '入力を読み取れません。' };
  }
  const body = value as Record<string, unknown>;
  const text = (key: string, max: number) => typeof body[key] === 'string' ? body[key].trim().slice(0, max) : '';
  const slug = text('slug', 40).toLowerCase();
  const title = text('title', 100);
  const description = text('description', 5000);
  const sourceName = text('sourceName', 100);
  const sourceUrl = text('sourceUrl', 500);
  const license = text('license', 5000);
  const root = text('root', 200).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const size = body.size;

  if (!SLUG_PATTERN.test(slug)) {
    return { error: 'ID は英小文字・数字・- の 3〜40 文字にしてください。' };
  }
  if (!title || !sourceName || !license) {
    return { error: '題名・出典・再配布の条件を入れてください。' };
  }
  if (root.split('/').includes('..')) {
    return { error: 'フォルダ名に .. は使えません。' };
  }
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        return { error: '出典 URL は http または https にしてください。' };
      }
    } catch {
      return { error: '出典 URL が正しくありません。' };
    }
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_PACK_SIZE) {
    return { error: 'zip は 1 GB までです。' };
  }
  if (body.excludesJasrac !== true) {
    return { error: 'JASRAC 管理楽曲を含まないことを確認してください。' };
  }
  return {
    input: {
      slug, title, description, sourceName, sourceUrl, license, root,
      size, excludesJasrac: true,
    },
  };
}
