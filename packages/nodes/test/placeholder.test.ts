import { describe, expect, it } from 'vitest';
import { NODES_DEPEND_ON_CORE } from '@ctb/nodes';

describe('@ctb/nodes placeholder', () => {
  it('depends on core (dependency rule core←nodes)', () => {
    expect(NODES_DEPEND_ON_CORE).toBe('0.0.1');
  });
});
