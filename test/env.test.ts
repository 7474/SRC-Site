import { describe, expect, it } from 'vitest';
import { PLACEHOLDER, withoutPlaceholders, type Bindings } from '../src/env';

describe('withoutPlaceholders', () => {
  it('仮の値の Secret を無いものとして扱う', () => {
    const env = { SITE_NAME: 'x', GOOGLE_CLIENT_ID: PLACEHOLDER, SESSION_SECRET: 'secret', TURNSTILE_SECRET: PLACEHOLDER } as unknown as Bindings;
    const result = withoutPlaceholders(env);
    expect(result.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(result.TURNSTILE_SECRET).toBeUndefined();
    expect(result.SESSION_SECRET).toBe('secret');
    expect(result.SITE_NAME).toBe('x');
    expect(env.GOOGLE_CLIENT_ID).toBe(PLACEHOLDER);
  });

  it('仮の値が無ければそのまま返す', () => {
    const env = { SESSION_SECRET: 'secret' } as unknown as Bindings;
    expect(withoutPlaceholders(env)).toBe(env);
  });
});
