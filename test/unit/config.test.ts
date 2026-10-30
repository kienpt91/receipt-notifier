import { afterEach, describe, expect, it, vi } from 'vitest';
import { secret } from '../../src/config.js';

const LONG = 'x'.repeat(24);

afterEach(() => vi.unstubAllEnvs());

describe('secret()', () => {
  it('falls back to the dev default only in development and test', () => {
    for (const env of ['development', 'test']) {
      vi.stubEnv('NODE_ENV', env);
      vi.stubEnv('ADMIN_TOKEN', '');
      expect(secret('ADMIN_TOKEN', 'dev', 24)).toBe('dev');
    }
  });

  it.each(['production', 'staging', ''])('fails fast without a value when NODE_ENV=%j', (env) => {
    vi.stubEnv('NODE_ENV', env);
    vi.stubEnv('ADMIN_TOKEN', '');
    expect(() => secret('ADMIN_TOKEN', 'dev', 24)).toThrow(/ADMIN_TOKEN must be set/);
  });

  it('fails fast when NODE_ENV is unset', () => {
    vi.stubEnv('NODE_ENV', undefined as unknown as string);
    vi.stubEnv('ADMIN_TOKEN', '');
    delete process.env.NODE_ENV;
    expect(() => secret('ADMIN_TOKEN', 'dev', 24)).toThrow(/must be set/);
  });

  it('enforces the minimum length outside development/test only', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'short');
    expect(() => secret('ADMIN_TOKEN', 'dev', 24)).toThrow(/at least 24/);
    vi.stubEnv('ADMIN_TOKEN', LONG);
    expect(secret('ADMIN_TOKEN', 'dev', 24)).toBe(LONG);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ADMIN_TOKEN', 'tok');
    expect(secret('ADMIN_TOKEN', 'dev', 24)).toBe('tok');
  });
});
