import { describe, expect, it } from 'vitest';
import { NODES_DEPEND_ON_CORE } from '@ctb/nodes';

describe('@ctb/server placeholder', () => {
  it('reaches the full dependency chain shared←core←nodes←server', () => {
    expect(NODES_DEPEND_ON_CORE).toBe('0.0.1');
  });
});
