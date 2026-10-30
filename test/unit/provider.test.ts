import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeEmailProvider } from '../../src/email/provider.js';

afterEach(() => vi.unstubAllEnvs());

describe('FakeEmailProvider', () => {
  it('refuses to start in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new FakeEmailProvider({} as Redis)).toThrow(/does not send real email/);
  });

  it('is allowed in development and test', () => {
    for (const env of ['development', 'test']) {
      vi.stubEnv('NODE_ENV', env);
      expect(() => new FakeEmailProvider({} as Redis)).not.toThrow();
    }
  });
});
