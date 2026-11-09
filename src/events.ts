/**
 * Event bus and constructor with the Event 0.1 privacy rules enforced in code.
 * There is no network sink anywhere in this library; events stay in memory.
 */

import {
  EVENT_ATTRS_MAX_KEYS,
  EVENT_ATTR_KEY_PATTERN,
  EVENT_ATTR_STRING_MAX,
  EVENT_FORBIDDEN_KEY_PATTERN,
  EVENT_NAME_PATTERN,
  EVENT_SOURCE_PATTERN,
  EVENT_SPEC,
  type Event,
  type EventAttrValue,
  type EventAttrs,
  type EventKind,
  type EventLevel,
  type EventSink,
} from '../spec/event';

const KINDS: ReadonlySet<string> = new Set([
  'log',
  'timing',
  'memory',
  'model-load',
  'asset',
  'error',
]);
const LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);

function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Random id for this page load (process). Never persisted, never derived from the user. */
const SESSION_ID = randomId();

export function sessionId(): string {
  return SESSION_ID;
}

export interface NewEventInput {
  source: string;
  kind: EventKind;
  name: string;
  level: EventLevel;
  attrs?: EventAttrs;
  durationMs?: number;
  bytes?: number;
}

/** Strips a query string from URL-looking values: anything after "?" once "://" was seen. */
function scrubString(value: string): string {
  const schemeAt = value.indexOf('://');
  if (schemeAt >= 0) {
    const q = value.indexOf('?', schemeAt + 3);
    if (q >= 0) value = value.slice(0, q);
    const hash = value.indexOf('#', schemeAt + 3);
    if (hash >= 0) value = value.slice(0, hash);
  }
  return value.length > EVENT_ATTR_STRING_MAX ? value.slice(0, EVENT_ATTR_STRING_MAX) : value;
}

function sanitiseAttrs(attrs: EventAttrs | undefined): EventAttrs {
  if (attrs === undefined) return {};
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs))
    throw new TypeError('event attrs must be a flat object');
  const keys = Object.keys(attrs);
  if (keys.length > EVENT_ATTRS_MAX_KEYS)
    throw new TypeError(
      `event attrs has ${keys.length} keys; at most ${EVENT_ATTRS_MAX_KEYS} allowed`,
    );
  const out: EventAttrs = {};
  for (const key of keys) {
    if (!EVENT_ATTR_KEY_PATTERN.test(key))
      throw new TypeError(
        `event attr key ${JSON.stringify(key)} does not match ${EVENT_ATTR_KEY_PATTERN}`,
      );
    if (EVENT_FORBIDDEN_KEY_PATTERN.test(key))
      throw new TypeError(
        `event attr key ${JSON.stringify(key)} may carry prompts, text or user agents and is refused`,
      );
    const value: unknown = attrs[key];
    if (typeof value === 'string') out[key] = scrubString(value);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      out[key] = value as EventAttrValue;
    else throw new TypeError(`event attr ${key} must be string, number, boolean or null`);
  }
  return out;
}

/** Builds a validated Event 0.1 record. Throws TypeError on any rule violation. */
export function newEvent(input: NewEventInput): Event {
  if (typeof input.source !== 'string' || !EVENT_SOURCE_PATTERN.test(input.source))
    throw new TypeError(`invalid event source ${JSON.stringify(input.source)}`);
  if (!KINDS.has(input.kind))
    throw new TypeError(`invalid event kind ${JSON.stringify(input.kind)}`);
  if (typeof input.name !== 'string' || !EVENT_NAME_PATTERN.test(input.name))
    throw new TypeError(`invalid event name ${JSON.stringify(input.name)}`);
  if (!LEVELS.has(input.level))
    throw new TypeError(`invalid event level ${JSON.stringify(input.level)}`);
  const e: Event = {
    spec: EVENT_SPEC,
    id: randomId(),
    ts: Date.now(),
    session: SESSION_ID,
    source: input.source,
    kind: input.kind,
    name: input.name,
    level: input.level,
    attrs: sanitiseAttrs(input.attrs),
  };
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') e.mono = perf.now();
  if (input.durationMs !== undefined) {
    if (typeof input.durationMs !== 'number' || input.durationMs < 0)
      throw new TypeError('durationMs must be >= 0');
    e.durationMs = input.durationMs;
  }
  if (input.bytes !== undefined) {
    if (!Number.isInteger(input.bytes) || input.bytes < 0)
      throw new TypeError('bytes must be a non-negative integer');
    e.bytes = input.bytes;
  }
  return e;
}

export type EventListener = (e: Event) => void;

/** In-memory ring buffer sink with subscriptions. The runtime's default sink. */
export class EventBus implements EventSink {
  readonly capacity: number;
  private readonly buffer: Event[] = [];
  private readonly listeners = new Set<EventListener>();

  constructor(capacity = 1000) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError('EventBus capacity must be >= 1');
    this.capacity = capacity;
  }

  emit(e: Event): void {
    this.buffer.push(e);
    if (this.buffer.length > this.capacity)
      this.buffer.splice(0, this.buffer.length - this.capacity);
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a listener must never break the emitter
      }
    }
  }

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Copy of the buffered events, oldest first. */
  snapshot(): Event[] {
    return this.buffer.slice();
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
