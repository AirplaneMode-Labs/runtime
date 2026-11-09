import type { LockProvider } from './types';

/** Prefix for Web Lock names so other code on the origin cannot collide by accident. */
export const LOCK_PREFIX = 'airplanemode-runtime:';

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
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
    return this.locks.request(LOCK_PREFIX + name, fn);
  }
}

/** Per-process locks: one queue per name, FIFO. Used in Node and where Web Locks are absent. */
export class InProcessLockProvider implements LockProvider {
  private readonly tails = new Map<string, Promise<void>>();

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
}

/** WebLocksProvider when navigator.locks exists, else InProcessLockProvider. */
export function defaultLockProvider(): LockProvider {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  if (nav?.locks && typeof nav.locks.request === 'function') return new WebLocksProvider(nav.locks);
  return new InProcessLockProvider();
}
