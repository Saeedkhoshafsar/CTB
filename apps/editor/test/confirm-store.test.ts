/**
 * Confirm store tests (UX) — promise-based confirm dialog state machine that
 * replaces the blocking window.confirm (PLAN5 P2-T4).
 *
 * The store is a singleton; each test starts from a clean slate by resolving any
 * leftover dialog. We assert the request→resolve contract and the
 * "second request cancels the first" guard.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { confirmDialog, useConfirm } from '../src/stores/confirm';

afterEach(() => {
  // ensure no dialog leaks between tests
  if (useConfirm.getState().current) useConfirm.getState().resolve(false);
});

describe('confirm store', () => {
  it('exposes no dialog initially', () => {
    expect(useConfirm.getState().current).toBeNull();
  });

  it('request opens a dialog carrying the given options', () => {
    void confirmDialog({ message: 'delete this?', danger: true });
    const cur = useConfirm.getState().current;
    expect(cur).not.toBeNull();
    expect(cur?.message).toBe('delete this?');
    expect(cur?.danger).toBe(true);
  });

  it('resolves true on confirm and clears the dialog', async () => {
    const p = confirmDialog({ message: 'ok?' });
    useConfirm.getState().resolve(true);
    await expect(p).resolves.toBe(true);
    expect(useConfirm.getState().current).toBeNull();
  });

  it('resolves false on cancel', async () => {
    const p = confirmDialog({ message: 'cancel?' });
    useConfirm.getState().resolve(false);
    await expect(p).resolves.toBe(false);
  });

  it('a second request cancels the previous (resolves it false)', async () => {
    const first = confirmDialog({ message: 'first' });
    const second = confirmDialog({ message: 'second' });
    await expect(first).resolves.toBe(false);
    expect(useConfirm.getState().current?.message).toBe('second');
    useConfirm.getState().resolve(true);
    await expect(second).resolves.toBe(true);
  });
});
