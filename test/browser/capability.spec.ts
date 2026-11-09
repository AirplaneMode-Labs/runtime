// detectCapabilities() in the installed Chrome: fast, schema-valid, allow-listed details only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from 'playwright/test';
import { call, openDemo, specDir } from './helpers';

const ALLOWED_DETAILS = new Set([
  'vendor',
  'architecture',
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup',
]);

type Schema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  propertyNames?: Schema;
  items?: Schema;
};

/** Small JSON Schema 2020-12 subset checker: enough for capability-profile.schema.json. */
function validate(schema: Schema, value: unknown, path: string, errors: string[]): void {
  const typeOf = (v: unknown): string =>
    v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
  if (schema.const !== undefined && value !== schema.const)
    errors.push(`${path}: expected const ${String(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not in enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === 'number' && t === 'integer'));
    if (!ok) errors.push(`${path}: type ${t} not in ${types.join('|')}`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
    errors.push(`${path}: does not match ${schema.pattern}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path}: above maximum`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`${path}: missing ${k}`);
    for (const [k, v] of Object.entries(obj)) {
      const prop = schema.properties?.[k];
      if (prop) validate(prop, v, `${path}/${k}`, errors);
      else if (schema.additionalProperties === false)
        errors.push(`${path}: unexpected property ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        validate(schema.additionalProperties, v, `${path}/${k}`, errors);
      if (schema.propertyNames) validate(schema.propertyNames, k, `${path}/(name ${k})`, errors);
    }
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((v, i) => validate(schema.items as Schema, v, `${path}/${i}`, errors));
}

test('detectCapabilities() resolves within 2 s, validates against the schema, and leaks no fingerprint', async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error('baseURL missing');
  await openDemo(page, baseURL, 'opfs');
  const t0 = Date.now();
  const profile = await call<Record<string, unknown>>(page, 'detectCapabilities');
  const elapsed = Date.now() - t0;
  expect(elapsed, 'detectCapabilities wall time (ms)').toBeLessThan(2000);

  const schema = JSON.parse(
    readFileSync(join(specDir, 'capability-profile.schema.json'), 'utf8'),
  ) as Schema;
  const errors: string[] = [];
  validate(schema, profile, '', errors);
  expect(errors).toEqual([]);
  expect(profile['spec']).toBe('airplanemode.capability/0.1');

  const ua = await page.evaluate(() => navigator.userAgent);
  const details = (profile['details'] ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(details)) {
    expect(ALLOWED_DETAILS.has(k), `details key ${k} is allow-listed`).toBe(true);
    if (typeof v === 'string') {
      expect(v.includes(ua)).toBe(false);
      expect(ua.includes(v) && v.length > 3, `details.${k} must not be a user-agent fragment`).toBe(
        false,
      );
    }
  }
  const text = JSON.stringify(profile);
  expect(text.includes(ua)).toBe(false);
  expect(/Chrome\/\d/.test(text), 'no browser version string in the profile').toBe(false);

  const features = profile['features'] as Record<string, boolean>;
  expect(features['opfs']).toBe(true);
  expect(features['indexedDb']).toBe(true);
  expect(['webgpu-f16', 'webgpu-f32', 'wasm-simd', 'wasm', 'none']).toContain(
    profile['backendTier'],
  );
});
