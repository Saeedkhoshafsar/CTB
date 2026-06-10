import { describe, expect, it } from 'vitest';
import { SANDBOX_PLACEHOLDER } from '@ctb/sandbox';

describe('@ctb/sandbox placeholder', () => {
  it('exists', () => {
    expect(SANDBOX_PLACEHOLDER).toBe(true);
  });
});
