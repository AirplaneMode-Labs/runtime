/**
 * Repeated-member scan for JSON text (manifest 0.1.1 "Duplicate members", model descriptor 0.2.1).
 *
 * JSON.parse keeps the LAST member of a repeated name without a word, so a document can carry one
 * value in the bytes a human reads and another in the value a verifier checks. A parser that works on
 * text therefore runs this scan first: an object with a repeated member name, at any depth, is
 * invalid_json.
 *
 * The scan is a single pass with an explicit stack (no recursion, so hostile nesting cannot raise a
 * RangeError), compares names after unescaping (`"a"` and `"a"` are one name), and tolerates
 * malformed text: it never throws, it answers false and leaves the syntax error to JSON.parse.
 */

interface ObjectFrame {
  names: Set<string>;
  /** True while the next string in this object is a member name. */
  expectKey: boolean;
}

/** True when `text` holds an object with a repeated member name at any depth. */
export function hasRepeatedMember(text: string): boolean {
  const stack: (ObjectFrame | null)[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
      i++;
    } else if (c === 0x7b) {
      // {
      stack.push({ names: new Set(), expectKey: true });
      i++;
    } else if (c === 0x5b) {
      // [
      stack.push(null);
      i++;
    } else if (c === 0x7d || c === 0x5d) {
      // } ]
      stack.pop();
      i++;
    } else if (c === 0x2c) {
      // ,
      const top = stack[stack.length - 1];
      if (top) top.expectKey = true;
      i++;
    } else if (c === 0x3a) {
      // :
      i++;
    } else if (c === 0x22) {
      // a string: scan to its closing quote
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 0x5c) j += 2;
        else if (d === 0x22) break;
        else j++;
      }
      if (j >= n) return false; // unterminated: JSON.parse reports it
      const top = stack[stack.length - 1];
      if (top && top.expectKey) {
        top.expectKey = false;
        let name: unknown;
        try {
          name = JSON.parse(text.slice(i, j + 1));
        } catch {
          return false;
        }
        if (typeof name !== 'string') return false;
        if (top.names.has(name)) return true;
        top.names.add(name);
      }
      i = j + 1;
    } else {
      // a number or a literal: run to the next structural character
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (
          d === 0x20 ||
          d === 0x0a ||
          d === 0x0d ||
          d === 0x09 ||
          d === 0x2c ||
          d === 0x7d ||
          d === 0x5d ||
          d === 0x3a ||
          d === 0x22 ||
          d === 0x7b ||
          d === 0x5b
        )
          break;
        i++;
      }
    }
  }
  return false;
}
