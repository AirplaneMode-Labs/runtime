// D1-02 (Sprint 5, Part A): the exact shape of backend.egress.refused on both reporter paths.
//
// The ubuntu-latest model-wasm failure at test/browser/model.spec.ts:385 (run 43667709960) was a stale
// expectation: the guard refused the probe and recorded ONE origin-only event, but the spec still
// expected the Event 0.1.2 attrs {adapter, origin} while Event 0.1.3 (S1-074, TD-21) added reporter:
// 'main'. Written before the spec was changed: the static checks at the end are red until it is.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterError } from '../spec/backend-adapter';
import {
  createVerifiedFetch,
  registerVerifiedFiles,
  type VerifiedFileSet,
} from '../src/backends/verified-files';
import { EventBus } from '../src/events';
import { eventsNamed, installLocation, PREFIX } from './backends-helpers';
import { mainEgressAttrs, workerEgressAttrs } from './egress-expect';
import { repoDir } from './helpers';
import { unloadAllRigs, workerRig } from './worker-rig';

const PROBE = 'https://huggingface.co/x';

describe('main-thread guard (reporter main): the probe the browser spec injects', () => {
  let restore: () => void;
  let sets: VerifiedFileSet[] = [];
  beforeEach(() => {
    restore = installLocation();
  });
  afterEach(() => {
    for (const s of sets.splice(0)) s.release();
    restore();
  });

  it('refuses https://huggingface.co/x with egress_refused and exactly one event whose attrs are {adapter, origin, reporter:main}', async () => {
    sets.push(
      registerVerifiedFiles(PREFIX, 'm.descriptor', [
        { path: 'config.json', blob: new Blob(['{}']), sha256: '0'.repeat(64) },
      ]),
    );
    const events = new EventBus();
    const guarded = createVerifiedFetch({ adapterId: 'transformers-js', events });
    await expect(guarded(PROBE)).rejects.toMatchObject({ code: 'egress_refused' });
    await expect(guarded(PROBE)).rejects.toBeInstanceOf(AdapterError);
    const refused = eventsNamed(events, 'backend.egress.refused');
    expect(refused).toHaveLength(2); // one per refused call: the first is what the browser probe sees
    const first = refused[0]!;
    expect(first.attrs).toEqual(mainEgressAttrs('transformers-js', 'https://huggingface.co'));
    expect(Object.keys(first.attrs).sort()).toEqual(['adapter', 'origin', 'reporter']);
    expect('count' in first.attrs).toBe(false);
    expect(first.kind).toBe('error');
    expect(first.level).toBe('error');
    // origin only: no path
    expect(JSON.stringify(first)).not.toContain('/x');
  });
});

describe('worker path (reporter worker): a refusal the engine worker reports', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installLocation();
  });
  afterEach(async () => {
    await unloadAllRigs();
    restore();
  });

  it('records one event {adapter, origin:worker-reported, reporter:worker, count:1}; the worker never supplies the origin', async () => {
    const r = await workerRig({
      engine: {
        inPipeline: async (env) => {
          await env.fetch(PROBE);
        },
      },
    });
    await expect(r.load()).rejects.toMatchObject({ code: 'egress_refused' });
    const refused = eventsNamed(r.events, 'backend.egress.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.attrs).toEqual(workerEgressAttrs('transformers-js', 1));
    const wire = JSON.stringify(r.events.snapshot());
    expect(wire).not.toContain('huggingface.co');
  });
});

describe('the browser spec expects what the guard emits (stale assertion, D1-02)', () => {
  const spec = readFileSync(resolve(repoDir, 'test/browser/model.spec.ts'), 'utf8');
  const has = (needle: string): boolean => spec.includes(needle);
  // the body of each test('...probe...') in the spec
  const probeTests = spec
    .split("\ntest('")
    .slice(1)
    .filter((t) => /probe/.test(t.slice(0, 200)));

  it('the main-path probe asserts reporter main through the shared expectation, not a two-key literal', () => {
    expect(has("from '../egress-expect'"), 'imports the shared expectation').toBe(true);
    expect(has("mainEgressAttrs('transformers-js', 'https://huggingface.co')")).toBe(true);
    const stale =
      /refused\[0\]!\.attrs\)\.toEqual\(\{\s*adapter: 'transformers-js',\s*origin: 'https:\/\/huggingface\.co',\s*\}\)/;
    expect(stale.test(spec), 'the stale two-key literal is gone').toBe(false);
  });

  it('a worker-path probe exists: one event, reporter worker, egress_refused, empty gate.aborted', () => {
    expect(has('workerEgressAttrs('), 'uses the worker expectation').toBe(true);
    expect(probeTests.some((t) => /inside the engine worker/.test(t.slice(0, 200)))).toBe(true);
  });

  it('assertGate runs in both probes (the zero-network gate)', () => {
    expect(probeTests.length).toBeGreaterThanOrEqual(2);
    for (const t of probeTests) expect(t.includes('await assertGate('), t.slice(0, 80)).toBe(true);
  });
});
