import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/lib/env';

describe('env config', () => {
  it('loads with valid CTB_SECRET and applies defaults', () => {
    const env = loadEnv({ CTB_SECRET: 'devsecret0123456' } as NodeJS.ProcessEnv);
    expect(env.CTB_DB_PATH).toBe('data/ctb.sqlite');
    expect(env.CTB_PORT).toBe(3000);
    expect(env.CTB_ADMIN_USER).toBe('admin');
  });

  it('refuses to boot without CTB_SECRET', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/CTB_SECRET/);
  });

  it('refuses short CTB_SECRET', () => {
    expect(() => loadEnv({ CTB_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/16 characters/);
  });

  it('coerces CTB_PORT and rejects junk', () => {
    expect(loadEnv({ CTB_SECRET: 'devsecret0123456', CTB_PORT: '8080' } as NodeJS.ProcessEnv).CTB_PORT).toBe(8080);
    expect(() => loadEnv({ CTB_SECRET: 'devsecret0123456', CTB_PORT: 'nope' } as NodeJS.ProcessEnv)).toThrow();
  });
});
