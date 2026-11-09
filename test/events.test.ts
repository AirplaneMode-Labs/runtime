import { describe, expect, it } from 'vitest';
import { EventBus, newEvent, sessionId } from '../src/events';
import { SCHEMAS, validateSchema } from '../src/schema';

const base = { source: 'runtime', kind: 'log', name: 'test.event', level: 'info' } as const;

describe('newEvent', () => {
  it('fills spec, id (uuid v4), ts, mono, session and validates against the schema', () => {
    const e = newEvent({ ...base, attrs: { a: 1 } });
    expect(e.spec).toBe('airplanemode.event/0.1');
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.isInteger(e.ts)).toBe(true);
    expect(typeof e.mono).toBe('number');
    expect(e.session).toBe(sessionId());
    expect(e.attrs).toEqual({ a: 1 });
    const r = validateSchema(SCHEMAS.event, e);
    expect(r.errors).toEqual([]);
  });

  it('session id is random per load, not user-derived, and stable within the process', () => {
    expect(sessionId()).toMatch(/^[0-9a-f-]{16,64}$/);
    expect(newEvent(base).session).toBe(newEvent(base).session);
  });

  it('defaults attrs to {} and copies durationMs/bytes', () => {
    const e = newEvent({ ...base, durationMs: 12.5, bytes: 10 });
    expect(e.attrs).toEqual({});
    expect(e.durationMs).toBe(12.5);
    expect(e.bytes).toBe(10);
  });

  it('rejects more than 32 attrs keys with TypeError', () => {
    const attrs: Record<string, number> = {};
    for (let i = 0; i < 33; i++) attrs[`k${i}`] = i;
    expect(() => newEvent({ ...base, attrs })).toThrow(TypeError);
    delete attrs['k32'];
    expect(() => newEvent({ ...base, attrs })).not.toThrow();
  });

  it('rejects keys outside ^[A-Za-z][A-Za-z0-9_]{0,63}$ with TypeError', () => {
    for (const k of ['_x', '1a', 'a-b', 'a.b', '', 'x'.repeat(65), 'héllo']) {
      expect(() => newEvent({ ...base, attrs: { [k]: 1 } }), k).toThrow(TypeError);
    }
    expect(() => newEvent({ ...base, attrs: { ['x'.repeat(64)]: 1 } })).not.toThrow();
  });

  it('rejects keys matching /prompt|text|content|document|ua|userAgent/i with TypeError, always', () => {
    for (const k of [
      'prompt',
      'systemPrompt',
      'text',
      'pageText',
      'content',
      'documentId',
      'ua',
      'userAgent',
      'UA',
      'DocumentTitle',
      'language', // contains "ua"
    ]) {
      expect(() => newEvent({ ...base, attrs: { [k]: 'x' } }), k).toThrow(TypeError);
    }
    for (const k of [
      'entryId',
      'received',
      'total',
      'quota',
      'usage',
      'reason',
      'origin',
      'sha256',
    ]) {
      expect(() => newEvent({ ...base, attrs: { [k]: 'x' } }), k).not.toThrow();
    }
  });

  it('truncates string values to 1024 UTF-16 units', () => {
    const e = newEvent({ ...base, attrs: { s: 'a'.repeat(5000) } });
    expect((e.attrs['s'] as string).length).toBe(1024);
  });

  it('strips the query string from values containing "?" after "://"', () => {
    const e = newEvent({
      ...base,
      attrs: {
        url: 'https://cdn.example.com/a.bin?token=secret&x=1',
        plain: 'what? really?',
        frag: 'https://h/x?q=1#frag',
      },
    });
    expect(e.attrs['url']).toBe('https://cdn.example.com/a.bin');
    expect(e.attrs['plain']).toBe('what? really?');
    expect(e.attrs['frag']).toBe('https://h/x');
  });

  it('rejects non-primitive attr values with TypeError', () => {
    for (const v of [{}, [], () => 1, undefined, 10n, Symbol('s')]) {
      expect(() => newEvent({ ...base, attrs: { v: v as never } })).toThrow(TypeError);
    }
    expect(() => newEvent({ ...base, attrs: { a: null, b: true, c: 1.5, d: 'x' } })).not.toThrow();
  });

  it('rejects bad name, source, kind and level', () => {
    expect(() => newEvent({ ...base, name: 'Bad.Name' })).toThrow(TypeError);
    expect(() => newEvent({ ...base, name: 'a..b' })).toThrow(TypeError);
    expect(() => newEvent({ ...base, source: 'Runtime' })).toThrow(TypeError);
    expect(() => newEvent({ ...base, kind: 'nope' as never })).toThrow(TypeError);
    expect(() => newEvent({ ...base, level: 'trace' as never })).toThrow(TypeError);
    expect(() => newEvent({ ...base, name: 'asset.download.progress' })).not.toThrow();
  });
});

describe('EventBus', () => {
  it('keeps the last 1000 events (ring buffer) by default', () => {
    const bus = new EventBus();
    for (let i = 0; i < 1005; i++) bus.emit(newEvent({ ...base, attrs: { i } }));
    const all = bus.snapshot();
    expect(all).toHaveLength(1000);
    expect(all[0]!.attrs['i']).toBe(5);
    expect(all[999]!.attrs['i']).toBe(1004);
  });

  it('subscribe delivers every event and returns an unsubscribe function', () => {
    const bus = new EventBus(10);
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(e.name));
    bus.emit(newEvent({ ...base, name: 'one' }));
    off();
    bus.emit(newEvent({ ...base, name: 'two' }));
    expect(seen).toEqual(['one']);
  });

  it('a throwing subscriber does not break other subscribers or the buffer', () => {
    const bus = new EventBus(10);
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((e) => seen.push(e.name));
    bus.emit(newEvent({ ...base, name: 'ok' }));
    expect(seen).toEqual(['ok']);
    expect(bus.snapshot()).toHaveLength(1);
  });

  it('clear() empties the buffer', () => {
    const bus = new EventBus(10);
    bus.emit(newEvent(base));
    bus.clear();
    expect(bus.snapshot()).toEqual([]);
  });

  it('rejects a capacity below 1', () => {
    expect(() => new EventBus(0)).toThrow(RangeError);
  });
});
