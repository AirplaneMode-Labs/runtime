// D1-06: the opt-in DevTools hook. Without exposeDevtoolsHook() there is no global; with it, one
// non-enumerable, read-only global whose snapshot() returns a fresh string. Written before the
// implementation.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event } from '../spec/event';
import { EventBus, newEvent, sessionId } from '../src/events';
import { exposeDevtoolsHook } from '../src/devtools-hook';
import { SCHEMAS, validateSchema } from '../src/schema';
import { filesContaining, repoDir } from './helpers';

const G = '__airplanemodeDevtools';
const g = globalThis as Record<string, unknown>;
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  delete g[G];
  delete g['__customHook'];
});

const emit = (
  bus: EventBus,
  name: string,
  kind: Event['kind'] = 'log',
  attrs: Event['attrs'] = {},
): void =>
  bus.emit(newEvent({ source: 'runtime', kind, name, level: 'info', attrs, durationMs: 1 }));

describe('exposeDevtoolsHook', () => {
  it('there is no global before the hook is exposed', () => {
    expect(G in globalThis).toBe(false);
    expect(g[G]).toBeUndefined();
  });

  it('defines one global: enumerable false, writable false, configurable true; dispose() deletes it', () => {
    const dispose = exposeDevtoolsHook(new EventBus());
    disposers.push(dispose);
    const d = Object.getOwnPropertyDescriptor(globalThis, G)!;
    expect(d.enumerable).toBe(false);
    expect(d.writable).toBe(false);
    expect(d.configurable).toBe(true);
    expect('value' in d).toBe(true);
    const hook = d.value as { version: number; snapshot: unknown };
    expect(hook.version).toBe(1);
    expect(typeof hook.snapshot).toBe('function');
    expect(Object.keys(globalThis)).not.toContain(G);
    expect(() => {
      'use strict';
      g[G] = 1;
    }).toThrow(TypeError); // read-only
    dispose();
    expect(G in globalThis).toBe(false);
    expect(() => dispose()).not.toThrow(); // idempotent
  });

  it('the hook object is frozen and has exactly version and snapshot', () => {
    disposers.push(exposeDevtoolsHook(new EventBus()));
    const hook = g[G] as object;
    expect(Object.isFrozen(hook)).toBe(true);
    expect(Object.keys(hook).sort()).toEqual(['snapshot', 'version']);
  });

  it('snapshot() returns a JSON string of airplanemode.devtools/0.1 with the session and events oldest first', () => {
    const bus = new EventBus();
    disposers.push(exposeDevtoolsHook(bus));
    emit(bus, 'model.load.phase', 'timing', { phase: 'acquire' });
    emit(bus, 'memory.sample', 'memory', { at: 'before_load' });
    const raw = (g[G] as { snapshot(): unknown }).snapshot();
    expect(typeof raw).toBe('string');
    const snap = JSON.parse(raw as string) as {
      spec: string;
      session: string;
      capturedAt: number;
      events: Event[];
      dropped: number;
    };
    expect(snap.spec).toBe('airplanemode.devtools/0.1');
    expect(snap.session).toBe(sessionId());
    expect(Number.isSafeInteger(snap.capturedAt)).toBe(true);
    expect(snap.dropped).toBe(0);
    expect(snap.events.map((e) => e.name)).toEqual(['model.load.phase', 'memory.sample']);
    expect(Object.keys(snap).sort()).toEqual([
      'capturedAt',
      'dropped',
      'events',
      'session',
      'spec',
    ]);
    for (const e of snap.events) expect(validateSchema(SCHEMAS.event, e).errors).toEqual([]);
  });

  it('includes kinds timing, memory and model-load and the backend., asset.verify., model., memory. and storage. names, and nothing else', () => {
    const bus = new EventBus();
    disposers.push(exposeDevtoolsHook(bus));
    emit(bus, 'custom.timing', 'timing');
    emit(bus, 'custom.memory', 'memory');
    emit(bus, 'custom.load', 'model-load');
    emit(bus, 'backend.select', 'log');
    emit(bus, 'asset.verify.ok', 'asset');
    emit(bus, 'model.generate', 'log');
    emit(bus, 'memory.sample', 'log');
    emit(bus, 'storage.set', 'log');
    emit(bus, 'asset.download.progress', 'asset'); // excluded: asset kind, not asset.verify.*
    emit(bus, 'capability.measured', 'log'); // excluded
    emit(bus, 'manifest.verify.ok', 'log'); // excluded
    const snap = JSON.parse((g[G] as { snapshot(): string }).snapshot()) as { events: Event[] };
    expect(snap.events.map((e) => e.name)).toEqual([
      'custom.timing',
      'custom.memory',
      'custom.load',
      'backend.select',
      'asset.verify.ok',
      'model.generate',
      'memory.sample',
      'storage.set',
    ]);
  });

  it('keeps at most 1000 events (the newest) and counts the rest in dropped', () => {
    const bus = new EventBus(5000);
    disposers.push(exposeDevtoolsHook(bus));
    for (let i = 0; i < 1200; i++) emit(bus, 'model.load.phase', 'timing', { seq: i });
    const snap = JSON.parse((g[G] as { snapshot(): string }).snapshot()) as {
      events: Event[];
      dropped: number;
    };
    expect(snap.events).toHaveLength(1000);
    expect(snap.dropped).toBe(200);
    expect(snap.events[0]!.attrs['seq']).toBe(200);
    expect(snap.events[999]!.attrs['seq']).toBe(1199);
  });

  it('the max option lowers the cap', () => {
    const bus = new EventBus();
    disposers.push(exposeDevtoolsHook(bus, { max: 3 }));
    for (let i = 0; i < 5; i++) emit(bus, 'model.load.phase', 'timing', { seq: i });
    const snap = JSON.parse((g[G] as { snapshot(): string }).snapshot()) as {
      events: Event[];
      dropped: number;
    };
    expect(snap.events.map((e) => e.attrs['seq'])).toEqual([2, 3, 4]);
    expect(snap.dropped).toBe(2);
  });

  it('never returns more than 2 MiB: the oldest events are dropped and counted', () => {
    const bus = new EventBus(5000);
    disposers.push(exposeDevtoolsHook(bus));
    const big = 'x'.repeat(1024);
    for (let i = 0; i < 400; i++) {
      const attrs: Record<string, string | number> = { seq: i };
      for (let k = 0; k < 30; k++) attrs[`k${k}`] = big;
      emit(bus, 'model.load.phase', 'timing', attrs);
    }
    const raw = (g[G] as { snapshot(): string }).snapshot();
    expect(raw.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    const snap = JSON.parse(raw) as { events: Event[]; dropped: number };
    expect(snap.events.length).toBeGreaterThan(0);
    expect(snap.events.length + snap.dropped).toBe(400);
    expect(snap.events[snap.events.length - 1]!.attrs['seq']).toBe(399); // the newest survive
  });

  it('every call serialises afresh: no live reference, and events emitted later appear next time', () => {
    const bus = new EventBus();
    disposers.push(exposeDevtoolsHook(bus));
    emit(bus, 'model.load.phase', 'timing', { seq: 1 });
    const a = (g[G] as { snapshot(): string }).snapshot();
    const parsed = JSON.parse(a) as { events: Event[] };
    parsed.events[0]!.attrs['seq'] = 999;
    parsed.events.length = 0;
    emit(bus, 'model.load.phase', 'timing', { seq: 2 });
    const b = JSON.parse((g[G] as { snapshot(): string }).snapshot()) as { events: Event[] };
    expect(b.events.map((e) => e.attrs['seq'])).toEqual([1, 2]);
    expect(bus.snapshot()[0]!.attrs['seq']).toBe(1);
  });

  it('globalName chooses the property; dispose only removes a hook that is still its own', () => {
    const bus = new EventBus();
    const d1 = exposeDevtoolsHook(bus, { globalName: '__customHook' });
    expect(typeof (g['__customHook'] as { snapshot: unknown }).snapshot).toBe('function');
    expect(G in globalThis).toBe(false);
    const d2 = exposeDevtoolsHook(bus, { globalName: '__customHook' }); // replaces it
    d1(); // the first hook is no longer installed: must not remove the second
    expect('__customHook' in globalThis).toBe(true);
    d2();
    expect('__customHook' in globalThis).toBe(false);
  });

  it('refuses a global name that is not an identifier', () => {
    expect(() => exposeDevtoolsHook(new EventBus(), { globalName: 'a b' })).toThrow(TypeError);
    expect(() => exposeDevtoolsHook(new EventBus(), { globalName: '' })).toThrow(TypeError);
  });

  it('a prompt and an output sentinel never appear: events built by the library carry none', () => {
    const bus = new EventBus();
    disposers.push(exposeDevtoolsHook(bus));
    emit(bus, 'model.generate', 'timing', { adapter: 'transformers-js', outTokens: 2 });
    const raw = (g[G] as { snapshot(): string }).snapshot();
    expect(raw).not.toContain('SENTINEL');
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('opt-in only', () => {
  const code = (text: string): string =>
    text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

  it('nothing under src/ calls exposeDevtoolsHook() other than its own definition', () => {
    // POSIX-form relative paths on every host: 'src\\devtools-hook.ts' failed on windows-latest (D1-01)
    const hits = filesContaining(repoDir, walk(resolve(repoDir, 'src')), /exposeDevtoolsHook\s*\(/);
    expect(hits).toEqual(['src/devtools-hook.ts']);
    const def = code(readFileSync(resolve(repoDir, 'src/devtools-hook.ts'), 'utf8'));
    expect(def.match(/exposeDevtoolsHook\s*\(/g)!.length).toBe(1);
    expect(readFileSync(resolve(repoDir, 'src/index.ts'), 'utf8')).toMatch(/exposeDevtoolsHook/);
  });
});
