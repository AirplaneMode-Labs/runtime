/**
 * Everything the panel accepts from the page is checked here before anything is rendered.
 *
 * The page's answer is untrusted: a string of at most 2 MiB that must parse as JSON in this
 * extension, name the spec airplanemode.devtools/0.1 and have the documented shape, and whose events
 * each pass the runtime validator (event.schema.json 0.1.2 and the privacy key rule). Events that
 * fail are dropped and counted, never shown.
 */

import { EVENT_FORBIDDEN_KEY_PATTERN, type Event } from '../../spec/event';
import { SCHEMAS, validateSchema } from '../../src/schema';
import { MAX_SNAPSHOT_CHARS } from './page-expr';

export { MAX_SNAPSHOT_CHARS };
export const SNAPSHOT_SPEC = 'airplanemode.devtools/0.1';

export type SnapshotRejection =
  'not_string' | 'too_large' | 'invalid_json' | 'bad_spec' | 'bad_shape';

export interface ParsedSnapshot {
  session: string;
  capturedAt: number;
  /** Events that passed validation, oldest first. */
  events: Event[];
  /** Events the page reported as left out (its own cap or size limit). */
  dropped: number;
  /** Events in the snapshot that failed validation here and were dropped. */
  invalid: number;
}

export type SnapshotResult =
  { ok: true; snapshot: ParsedSnapshot } | { ok: false; reason: SnapshotRejection };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** True when `e` is a valid Event 0.1.x (JSON Schema plus the forbidden attr key rule). */
export function validateEvent(e: unknown): e is Event {
  if (!isRecord(e)) return false;
  if (!validateSchema(SCHEMAS.event, e).ok) return false;
  const attrs = e['attrs'];
  if (!isRecord(attrs)) return false;
  for (const key of Object.keys(attrs)) if (EVENT_FORBIDDEN_KEY_PATTERN.test(key)) return false;
  return true;
}

/** Parses what the page returned. Never throws. */
export function parseSnapshot(raw: unknown): SnapshotResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_string' };
  if (raw.length > MAX_SNAPSHOT_CHARS) return { ok: false, reason: 'too_large' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isRecord(value)) return { ok: false, reason: 'bad_shape' };
  if (value['spec'] !== SNAPSHOT_SPEC) return { ok: false, reason: 'bad_spec' };
  const { session, capturedAt, events, dropped } = value;
  if (
    typeof session !== 'string' ||
    session.length === 0 ||
    session.length > 64 ||
    !isCount(capturedAt) ||
    !isCount(dropped) ||
    !Array.isArray(events)
  )
    return { ok: false, reason: 'bad_shape' };
  const good: Event[] = [];
  let invalid = 0;
  for (const e of events) {
    if (validateEvent(e)) good.push(e);
    else invalid++;
  }
  return { ok: true, snapshot: { session, capturedAt, events: good, dropped, invalid } };
}
