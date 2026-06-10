import { describe, expect, it } from 'vitest';
import { CORE_DEPENDS_ON_SHARED } from '@ctb/core';

describe('@ctb/core placeholder', () => {
  it('depends on shared (dependency rule shared←core)', () => {
    expect(CORE_DEPENDS_ON_SHARED).toBe('0.0.1');
  });
});
