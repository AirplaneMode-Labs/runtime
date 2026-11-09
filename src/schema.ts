/**
 * Minimal JSON Schema 2020-12 validator covering exactly the keywords the five contracts use.
 * No dependency; deterministic error paths; no code generation.
 */

import capabilityProfileSchema from '../spec/capability-profile.schema.json';
import eventSchema from '../spec/event.schema.json';
import manifestSchema from '../spec/manifest.schema.json';
import modelDescriptorSchema from '../spec/model-descriptor.schema.json';

export type JsonSchema = Record<string, unknown>;

export interface SchemaError {
  /** JSON Pointer to the offending value ('' is the root). */
  path: string;
  keyword: string;
  message: string;
}

export interface SchemaResult {
  ok: boolean;
  errors: SchemaError[];
}

export const SCHEMAS: Readonly<
  Record<'manifest' | 'capabilityProfile' | 'event' | 'modelDescriptor', JsonSchema>
> = Object.freeze({
  manifest: manifestSchema as JsonSchema,
  capabilityProfile: capabilityProfileSchema as JsonSchema,
  event: eventSchema as JsonSchema,
  modelDescriptor: modelDescriptorSchema as JsonSchema,
});

const regexCache = new Map<string, RegExp>();
function regex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, 'u');
    regexCache.set(pattern, re);
  }
  return re;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  let node: unknown = root;
  for (const seg of ref.slice(2).split('/')) {
    node = (node as Record<string, unknown>)[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`unresolved $ref ${ref}`);
  }
  return node as JsonSchema;
}

function validateNode(
  root: JsonSchema,
  schema: JsonSchema | boolean,
  value: unknown,
  path: string,
  errors: SchemaError[],
): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, keyword: 'false', message: 'schema false' });
    return;
  }
  if (typeof schema['$ref'] === 'string') {
    validateNode(root, resolveRef(root, schema['$ref']), value, path, errors);
    return;
  }
  const s = schema;
  const fail = (keyword: string, message: string) => errors.push({ path, keyword, message });

  if (s['type'] !== undefined) {
    const types = Array.isArray(s['type']) ? (s['type'] as string[]) : [s['type'] as string];
    if (!types.some((t) => matchesType(value, t))) {
      fail('type', `expected ${types.join('|')}, got ${typeOf(value)}`);
      return;
    }
  }
  if ('const' in s && !deepEqual(value, s['const'])) {
    fail('const', `expected ${JSON.stringify(s['const'])}`);
  }
  if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).some((e) => deepEqual(e, value))) {
    fail('enum', `not one of ${JSON.stringify(s['enum'])}`);
  }
  if (Array.isArray(s['anyOf'])) {
    const ok = (s['anyOf'] as JsonSchema[]).some((sub) => {
      const subErrors: SchemaError[] = [];
      validateNode(root, sub, value, path, subErrors);
      return subErrors.length === 0;
    });
    if (!ok) fail('anyOf', 'matches none of anyOf');
  }

  if (typeof value === 'string') {
    if (typeof s['minLength'] === 'number' && [...value].length < s['minLength'])
      fail('minLength', `shorter than ${s['minLength']}`);
    if (typeof s['maxLength'] === 'number' && [...value].length > s['maxLength'])
      fail('maxLength', `longer than ${s['maxLength']}`);
    if (typeof s['pattern'] === 'string' && !regex(s['pattern']).test(value))
      fail('pattern', `does not match ${s['pattern']}`);
  }

  if (typeof value === 'number') {
    if (typeof s['minimum'] === 'number' && value < s['minimum'])
      fail('minimum', `below ${s['minimum']}`);
    if (typeof s['maximum'] === 'number' && value > s['maximum'])
      fail('maximum', `above ${s['maximum']}`);
  }

  if (Array.isArray(value)) {
    if (typeof s['minItems'] === 'number' && value.length < s['minItems'])
      fail('minItems', `fewer than ${s['minItems']} items`);
    if (typeof s['maxItems'] === 'number' && value.length > s['maxItems'])
      fail('maxItems', `more than ${s['maxItems']} items`);
    if (s['uniqueItems'] === true) {
      for (let i = 0; i < value.length; i++)
        for (let j = i + 1; j < value.length; j++)
          if (deepEqual(value[i], value[j])) fail('uniqueItems', `items ${i} and ${j} are equal`);
    }
    if (s['items'] !== undefined) {
      value.forEach((item, i) =>
        validateNode(root, s['items'] as JsonSchema | boolean, item, `${path}/${i}`, errors),
      );
    }
  }

  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (s['properties'] as Record<string, JsonSchema | boolean> | undefined) ?? {};
    const keys = Object.keys(obj);
    if (Array.isArray(s['required'])) {
      for (const r of s['required'] as string[])
        if (!(r in obj)) fail('required', `missing property ${r}`);
    }
    if (typeof s['maxProperties'] === 'number' && keys.length > s['maxProperties'])
      fail('maxProperties', `more than ${s['maxProperties']} properties`);
    for (const k of keys) {
      const esc = k.replace(/~/g, '~0').replace(/\//g, '~1');
      if (s['propertyNames'] !== undefined) {
        const pnErrors: SchemaError[] = [];
        validateNode(root, s['propertyNames'] as JsonSchema, k, `${path}/${esc}`, pnErrors);
        if (pnErrors.length)
          fail('propertyNames', `property name ${JSON.stringify(k)} not allowed`);
      }
      if (k in props) {
        validateNode(root, props[k]!, obj[k], `${path}/${esc}`, errors);
      } else if (s['additionalProperties'] === false) {
        fail('additionalProperties', `unexpected property ${k}`);
      } else if (s['additionalProperties'] !== undefined && s['additionalProperties'] !== true) {
        validateNode(
          root,
          s['additionalProperties'] as JsonSchema,
          obj[k],
          `${path}/${esc}`,
          errors,
        );
      }
    }
  }
}

/** Validates `value` against `schema` and returns every error found. */
export function validateSchema(schema: JsonSchema, value: unknown): SchemaResult {
  const errors: SchemaError[] = [];
  validateNode(schema, schema, value, '', errors);
  return { ok: errors.length === 0, errors };
}

/**
 * Validates a model descriptor: the JSON Schema, then the two rules JSON Schema cannot express
 * (`files` sorted by path in byte order with unique paths; `devices` sorted). Ordering errors are
 * reported with keyword `sorted` or `unique` at the offending index.
 */
export function validateModelDescriptor(value: unknown): SchemaResult {
  const result = validateSchema(SCHEMAS.modelDescriptor, value);
  const errors = [...result.errors];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const files = (value as { files?: unknown }).files;
    if (Array.isArray(files)) {
      for (let i = 1; i < files.length; i++) {
        const prev = (files[i - 1] as { path?: unknown } | null)?.path;
        const cur = (files[i] as { path?: unknown } | null)?.path;
        if (typeof prev !== 'string' || typeof cur !== 'string') continue;
        if (cur === prev)
          errors.push({
            path: `/files/${i}/path`,
            keyword: 'unique',
            message: `duplicate path ${JSON.stringify(cur)}`,
          });
        else if (cur < prev)
          errors.push({
            path: `/files/${i}/path`,
            keyword: 'sorted',
            message: `files not sorted by path: ${JSON.stringify(cur)} after ${JSON.stringify(prev)}`,
          });
      }
    }
    const devices = (value as { devices?: unknown }).devices;
    if (Array.isArray(devices)) {
      for (let i = 1; i < devices.length; i++) {
        const prev = devices[i - 1];
        const cur = devices[i];
        if (typeof prev === 'string' && typeof cur === 'string' && cur < prev)
          errors.push({
            path: `/devices/${i}`,
            keyword: 'sorted',
            message: 'devices not sorted',
          });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
