/**
 * The ONE expression the panel evaluates in the inspected page: a constant string, never built from
 * page data or user input.
 *
 * It reads the hook through property descriptors, so a getter the page defined (on the global or on
 * the hook) is never invoked; it only calls `snapshot`, and only when that is a plain data property
 * holding a function. It returns
 *
 *  - null          when the page has no hook (nothing called exposeDevtoolsHook());
 *  - '!throw'      when snapshot() threw;
 *  - '!shape'      when snapshot() returned something that is not a string of at most 2 MiB;
 *  - the string    otherwise.
 *
 * The expression runs in the page's own JavaScript realm, so a hostile page can tamper with the
 * built-ins it uses; the panel therefore treats the answer as untrusted data (it rechecks the type
 * and the size, parses the JSON in the extension, validates every event and renders text only).
 * A Proxy cannot be told from an object, so a Proxy hook may see descriptor traps run; its `get`
 * trap is never called.
 */

export const MAX_SNAPSHOT_CHARS = 2097152;

export const PAGE_EXPRESSION =
  '(function () {' +
  "var d = Object.getOwnPropertyDescriptor(globalThis, '__airplanemodeDevtools');" +
  "if (!d || !('value' in d)) return null;" +
  'var hook = d.value;' +
  "if (hook === null || typeof hook !== 'object') return null;" +
  "var s = Object.getOwnPropertyDescriptor(hook, 'snapshot');" +
  "if (!s || !('value' in s) || typeof s.value !== 'function') return null;" +
  'var r;' +
  'try { r = s.value.call(hook); } catch (e) { return "!throw"; }' +
  "if (typeof r !== 'string' || r.length > 2097152) return '!shape';" +
  'return r;' +
  '})()';
