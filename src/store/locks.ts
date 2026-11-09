import { HELD_LOCK_PREFIX, type LockProvider } from './types';

/** Prefix for Web Lock names so other code on the origin cannot collide by accident. */
export const LOCK_PREFIX = 'airplanemode-runtime:';

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
  request<T>(
    name: string,
    options: { mode?: 'shared' | 'exclusive' },
    callback: () => Promise<T>,
  ): Promise<T>;
  /** navigator.locks.query(); optional so that minimal fakes still work. */
  query?(): Promise<{ held?: { name?: string | undefined }[] | undefined }>;
}

/** The Web Lock name for a logical lock: the held-asset locks are global, everything else prefixed. */
function physicalName(name: string): string {
  return name.startsWith(HELD_LOCK_PREFIX) ? name : LOCK_PREFIX + name;
}

/** Cross-tab locks through navigator.locks. */
export class WebLocksProvider implements LockProvider {
  private readonly locks: LockManagerLike;
  constructor(locks?: LockManagerLike) {
    const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
    const l = locks ?? nav?.locks;
    if (!l || typeof l.request !== 'function') throw new Error('navigator.locks is not available');
    this.locks = l;
  }
  request<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.request(physicalName(name), fn);
  }
  /** A shared lock named exactly `name` (callers pass `airplanemode-held:<sha>`). */
  hold(name: string): Promise<() => void> {
    return new Promise<() => void>((resolveHold, rejectHold) => {
      this.locks
        .request(physicalName(name), { mode: 'shared' }, () => {
          return new Promise<void>((release) => resolveHold(() => release()));
        })
        .catch(rejectHold);
    });
  }
  /**
   * Whether any tab or worker holds or has requested `name`. `'unknown'` when navigator.locks has no
   * query() or it throws: "cannot tell" is not "not held" (S1-054), and the engine's error text is
   * dropped here so it can never reach an event.
   */
  async isHeld(name: string): Promise<boolean | 'unknown'> {
    if (typeof this.locks.query !== 'function') return 'unknown';
    try {
      const snapshot = await this.locks.query();
      const wanted = physicalName(name);
      return (snapshot.held ?? []).some((l) => l.name === wanted);
    } catch {
      return 'unknown';
    }
  }
}

/**
 * Per-process locks: one queue per name, FIFO. Used in Node and where Web Locks are absent. It
 * mirrors the Web Locks surface the asset manager needs: request() (exclusive), hold() (shared,
 * counted) and isHeld() (a request is running or queued, or at least one hold is open).
 */
export class InProcessLockProvider implements LockProvider {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly holds = new Map<string, number>();

  async request<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.tails.set(name, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }

  async hold(name: string): Promise<() => void> {
    this.holds.set(name, (this.holds.get(name) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.holds.get(name) ?? 1) - 1;
      if (n <= 0) this.holds.delete(name);
      else this.holds.set(name, n);
    };
  }

  async isHeld(name: string): Promise<boolean> {
    return this.tails.has(name) || (this.holds.get(name) ?? 0) > 0;
  }
}

/** WebLocksProvider when navigator.locks exists, else InProcessLockProvider. */
export function defaultLockProvider(): LockProvider {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  if (nav?.locks && typeof nav.locks.request === 'function') return new WebLocksProvider(nav.locks);
  return new InProcessLockProvider();
}
