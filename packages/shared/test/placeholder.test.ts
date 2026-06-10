import { describe, expect, it } from 'vitest';
import { CTB_VERSION } from '@ctb/shared';

describe('@ctb/shared placeholder', () => {
  it('exports a version', () => {
    expect(CTB_VERSION).toBe('0.0.1');
  });
});
