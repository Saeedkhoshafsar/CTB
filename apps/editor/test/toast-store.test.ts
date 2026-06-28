/**
 * Toast store tests (UX) — queue/dismiss behaviour + auto-dismiss timer.
 *
 * The store is a singleton (mirrors the other editor stores), so each test
 * resets it via `clear()` and uses fake timers to drive the auto-dismiss path
 * deterministically without real waits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useToasts } from '../src/stores/toast';

describe('toast store', () => {
  beforeEach(() => {
    useToasts.getState().clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('push adds a toast and returns its id', () => {
    const id = useToasts.getState().push({ kind: 'info', message: 'hello' });
    const { toasts } = useToasts.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ id, kind: 'info', message: 'hello' });
  });

  it('dismiss removes only the targeted toast', () => {
    const a = toast.success('a');
    const b = toast.error('b');
    useToasts.getState().dismiss(a);
    const ids = useToasts.getState().toasts.map((tt) => tt.id);
    expect(ids).toEqual([b]);
  });

  it('auto-dismisses after its duration elapses', () => {
    toast.info('temp', 1000);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(600); // now past the 1000ms deadline
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('duration 0 keeps the toast until dismissed manually', () => {
    const id = toast.show({ kind: 'warn', message: 'sticky', duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(useToasts.getState().toasts).toHaveLength(1);
    useToasts.getState().dismiss(id);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('helper kinds map to the right toast kind', () => {
    toast.success('s');
    toast.error('e');
    toast.warn('w');
    toast.info('i');
    expect(useToasts.getState().toasts.map((tt) => tt.kind)).toEqual([
      'success',
      'error',
      'warn',
      'info',
    ]);
  });
});
