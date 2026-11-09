import { describe, expect, it } from 'vitest';
import { ENGINE_DEFAULTS, neutraliseEngineDefaults } from '../demo/engine-defaults';

// T1-S2-08 (a): the demo build rewrites the engine's endpoint defaults so a built demo contains no
// endpoint of Hugging Face or a CDN, and fails when a library update moves one of them.
const ENGINE_ID = '/work/node_modules/@huggingface/transformers/dist/transformers.web.js';
const DOLLAR_BRACE = '${';
const GOOD = [
  'const env = { remoteHost: "https://huggingface.co/" };',
  `const wasmPaths = \`https://cdn.jsdelivr.net/npm/onnxruntime-web@${DOLLAR_BRACE}version}/dist/\`;`,
  'const isHFURL = isValidUrl(urlOrPath, ["http:", "https:"], ["huggingface.co", "hf.co"]);',
].join('\n');

const run = (code: string, id = ENGINE_ID) =>
  (neutraliseEngineDefaults.transform as (c: string, i: string) => { code: string } | null)(
    code,
    id,
  );

describe('neutraliseEngineDefaults', () => {
  it('rewrites the remote host, the CDN prefix and the Hugging Face host allow-list', () => {
    const out = run(GOOD)!.code;
    expect(out).not.toContain('huggingface.co');
    expect(out).not.toContain('hf.co');
    expect(out).not.toContain('jsdelivr');
    expect(out).toContain('remoteHost: "https://invalid.invalid/"');
    expect(out).toContain('["http:", "https:"], ["invalid.invalid"]');
  });

  it('has three rewrites, and each one fails the build when its literal is missing', () => {
    expect(ENGINE_DEFAULTS).toHaveLength(3);
    for (const [from] of ENGINE_DEFAULTS) {
      const without = GOOD.split(from).join('');
      expect(() => run(without), from).toThrow(/no longer contains/);
    }
  });

  it('leaves every other module alone', () => {
    expect(run(GOOD, '/work/src/index.ts')).toBeNull();
    expect(run(GOOD, '/work/node_modules/other/dist/transformers.web.js')).toBeNull();
  });
});
