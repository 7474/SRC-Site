import { describe, expect, it } from 'vitest';
import { MAX_PACK_SIZE, parsePackSubmissionInput } from '../src/lib/pack-submissions';

const valid = {
  slug: 'my-pack',
  title: 'My Pack',
  description: '',
  sourceName: 'Contributor',
  sourceUrl: 'https://example.com/source',
  license: 'Redistribution allowed',
  root: '',
  size: 1024,
  excludesJasrac: true,
};

describe('parsePackSubmissionInput', () => {
  it('accepts a complete pack submission and normalizes its slug', () => {
    const result = parsePackSubmissionInput({ ...valid, slug: 'My-Pack' });
    expect(result).toEqual({ input: { ...valid, slug: 'my-pack' } });
  });

  it('rejects invalid IDs, archive sizes, URLs, and unsafe roots', () => {
    expect(parsePackSubmissionInput({ ...valid, slug: '../pack' })).toHaveProperty('error');
    expect(parsePackSubmissionInput({ ...valid, size: MAX_PACK_SIZE + 1 })).toHaveProperty('error');
    expect(parsePackSubmissionInput({ ...valid, sourceUrl: 'javascript:alert(1)' })).toHaveProperty('error');
    expect(parsePackSubmissionInput({ ...valid, root: 'data/../outside' })).toHaveProperty('error');
  });

  it('requires an explicit confirmation that JASRAC-managed tracks are excluded', () => {
    expect(parsePackSubmissionInput({ ...valid, excludesJasrac: false })).toHaveProperty('error');
  });
});
