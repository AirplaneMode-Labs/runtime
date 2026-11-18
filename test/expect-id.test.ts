// D1-04 (manifest 0.1.2): the expectId verifier option and AssetManager({ expectManifestId }). Every row of
// spec/vectors/expect-id/expect-id.json goes through verifyManifest with a SPY downgrade store, then the
// asset manager refuses a validly signed manifest of another id with 0 asset requests and without
// touching the state. Written before the verifier changed (red run: evidence/sprint-5/D1/red/D1-04.log).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_REJECT_PRECEDENCE } from '../spec/manifest';
import { AssetManager } from '../src/asset-manager';
import { EventBus } from '../src/events';
import {
  ManifestError,
  verifyManifest,
  type ManifestState,
  type ManifestStateStore,
} from '../src/manifest';
import { MemoryAssetStore } from '../src/store/memory';
import { FakeServer } from './fake-fetch';
import { RFC8032_PUBLIC, RFC8032_TEST2_PUBLIC, keyIdOf, readJson, specDir } from './helpers';

const vectorsDir = resolve(specDir, 'vectors');

interface Row {
  file: string;
  trust: string[];
  allowTestKeys: boolean;
  now: string;
  state: ManifestState | null;
  requiresState: boolean;
  expectId: string;
  expect: { valid: boolean; stage?: string; reason?: string; throws?: string; message?: string };
}
const rows = readJson<Row[]>(resolve(vectorsDir, 'expect-id/expect-id.json'));
const KEYS: Record<string, Uint8Array> = {
  'rfc8032-1': RFC8032_PUBLIC,
  'rfc8032-2': RFC8032_TEST2_PUBLIC,
};
const trustOf = (names: string[]): Map<string, Uint8Array> =>
  new Map(names.map((n) => [keyIdOf(KEYS[n]!), KEYS[n]!]));

class SpyState implements ManifestStateStore {
  readonly sets: [string, ManifestState][] = [];
  gets = 0;
  private stored: ManifestState | undefined;
  constructor(seed: ManifestState | null) {
    this.stored = seed ?? undefined;
  }
  async get(): Promise<ManifestState | undefined> {
    this.gets++;
    return this.stored ? { ...this.stored } : undefined;
  }
  async set(id: string, state: ManifestState): Promise<void> {
    this.sets.push([id, { ...state }]);
    this.stored = { ...state };
  }
}

const textOf = (file: string): string => readFileSync(resolve(vectorsDir, file), 'utf8');
const verifyRow = (row: Row, spy: SpyState, events?: EventBus) =>
  verifyManifest(textOf(row.file), trustOf(row.trust), {
    allowTestKeys: row.allowTestKeys,
    now: Date.parse(row.now),
    state: spy,
    expectId: row.expectId,
    ...(events ? { events } : {}),
  });

describe('expect-id vectors: every row through verifyManifest', () => {
  for (const [i, row] of rows.entries()) {
    const label = `${String(i + 1).padStart(2, '0')} ${row.file} expectId ${JSON.stringify(row.expectId)}`;
    it(`${label}: ${row.expect.throws ?? (row.expect.valid ? 'valid' : row.expect.reason)}`, async () => {
      const spy = new SpyState(row.state);
      const events = new EventBus();
      if (row.expect.throws !== undefined) {
        // a caller error: a TypeError with the exact message, before anything is parsed, no reason
        let thrown: unknown;
        try {
          await verifyRow(row, spy, events);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(TypeError);
        expect((thrown as Error).name).toBe(row.expect.throws);
        expect((thrown as Error).message).toBe(row.expect.message);
        expect(thrown).not.toBeInstanceOf(ManifestError);
        expect(spy.gets).toBe(0);
        expect(spy.sets).toHaveLength(0);
        expect(events.snapshot()).toHaveLength(0); // nothing was parsed or judged
        return;
      }
      const r = await verifyRow(row, spy, events);
      expect(r.ok, JSON.stringify(r.ok ? '' : r)).toBe(row.expect.valid);
      if (!r.ok) {
        expect(r.reason).toBe(row.expect.reason);
        const failed = events.snapshot().filter((e) => e.name === 'manifest.verify.failed');
        expect(failed).toHaveLength(1);
        expect(failed[0]!.attrs['reason']).toBe(row.expect.reason);
      }
      // unexpected_id: the state store is neither read nor written (before the downgrade state is read)
      if (!r.ok && r.reason === 'unexpected_id') {
        expect(spy.gets).toBe(0);
        expect(spy.sets).toHaveLength(0);
      }
      // any other refusal writes nothing; an accepted manifest writes its state once
      if (!r.ok) expect(spy.sets).toHaveLength(0);
      else expect(spy.sets).toHaveLength(1);
    });
  }

  it('the precedence: unexpected_id sits after no_valid_signature and before downgrade and state', () => {
    const flat = MANIFEST_REJECT_PRECEDENCE.map((g) => [...g]);
    const at = (reason: string) => flat.findIndex((g) => g.includes(reason as never));
    expect(at('unexpected_id')).toBe(at('no_valid_signature') + 1);
    expect(at('unexpected_id')).toBe(at('downgrade') - 1);
  });

  it('without expectId every verdict is unchanged: a manifest of any id verifies', async () => {
    const r = await verifyManifest(textOf('tamper/tamper-base.json'), trustOf(['rfc8032-1']), {
      allowTestKeys: true,
      now: Date.parse('2026-11-14T00:00:00Z'),
    });
    expect(r.ok).toBe(true);
    // an explicit undefined is the same as absent
    const u = await verifyManifest(textOf('tamper/tamper-base.json'), trustOf(['rfc8032-1']), {
      allowTestKeys: true,
      now: Date.parse('2026-11-14T00:00:00Z'),
      expectId: undefined,
    });
    expect(u.ok).toBe(true);
  });

  it('every non-string or ungrammatical expectId is the same TypeError', async () => {
    for (const bad of [
      null,
      5,
      {},
      [],
      'ab',
      'A-upper',
      'a b',
      'x'.repeat(129),
      '-lead',
      '\u0000x',
    ] as unknown[]) {
      await expect(
        verifyManifest(textOf('tamper/tamper-base.json'), trustOf(['rfc8032-1']), {
          allowTestKeys: true,
          expectId: bad as string,
        }),
        JSON.stringify(bad),
      ).rejects.toThrow(new TypeError('invalid expectId'));
    }
  });

  it('the expectId check runs before the test-key refusal: a caller error comes first', async () => {
    await expect(
      verifyManifest(textOf('tamper/tamper-base.json'), trustOf(['rfc8032-1']), {
        expectId: '',
      }),
    ).rejects.toThrow(new TypeError('invalid expectId'));
  });
});

describe('AssetManager({ expectManifestId })', () => {
  const ORIGIN = 'https://assets.test';
  const baseManifest = () =>
    JSON.parse(textOf('tamper/tamper-base.json')) as Record<string, unknown>;
  /** The manager's own start-up reads and writes the index once; the spy counts only what follows it. */
  const make = (expectManifestId: string | undefined) => {
    const server = new FakeServer({ origin: ORIGIN });
    const store = new MemoryAssetStore();
    const reads: string[] = [];
    const orig = { r: store.readIndex.bind(store), w: store.writeIndex.bind(store) };
    store.readIndex = async () => {
      reads.push('read');
      return orig.r();
    };
    store.writeIndex = async (i) => {
      reads.push('write');
      return orig.w(i);
    };
    const events = new EventBus(100);
    const mgr = new AssetManager({
      store,
      fetch: server.fetch,
      events,
      allowTestKeys: true,
      allowedOrigins: [ORIGIN],
      ...(expectManifestId !== undefined ? { expectManifestId } : {}),
    });
    return {
      server,
      store,
      reads,
      events,
      mgr,
      ready: async () => {
        await mgr.list(); // opens the store
        reads.length = 0;
      },
    };
  };
  const NOW = Date.parse('2026-11-14T00:00:00Z');

  it('refuses a validly signed manifest of another id: unexpected_id, manifest.verify.failed, 0 asset requests, state untouched', async () => {
    const { server, reads, events, mgr, ready } = make('other-product');
    await ready();
    await expect(
      mgr.loadManifest(baseManifest() as never, trustOf(['rfc8032-1']), { now: NOW }),
    ).rejects.toMatchObject({ name: 'ManifestError', reason: 'unexpected_id' });
    expect(server.requests).toHaveLength(0);
    expect(reads).toEqual([]); // neither readIndex nor writeIndex for the refused manifest
    const failed = events.snapshot().filter((e) => e.name === 'manifest.verify.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.attrs['reason']).toBe('unexpected_id');
    expect(events.snapshot().some((e) => e.name === 'manifest.verify.ok')).toBe(false);
  });

  it('accepts the manifest of the pinned id and writes its state once', async () => {
    const { reads, events, mgr, ready } = make('tamper-base');
    await ready();
    const m = await mgr.loadManifest(baseManifest() as never, trustOf(['rfc8032-1']), { now: NOW });
    expect(m.id).toBe('tamper-base');
    expect(reads.filter((r) => r === 'write')).toHaveLength(1);
    expect(events.snapshot().some((e) => e.name === 'manifest.verify.ok')).toBe(true);
  });

  it('without expectManifestId any validly signed id loads (the 0.1.1 behaviour)', async () => {
    const { mgr } = make(undefined);
    await expect(
      mgr.loadManifest(baseManifest() as never, trustOf(['rfc8032-1']), { now: NOW }),
    ).resolves.toMatchObject({ id: 'tamper-base' });
  });

  it('an invalid expectManifestId is the verifier TypeError, raised at loadManifest', async () => {
    const { server, mgr } = make('BAD ID');
    await expect(
      mgr.loadManifest(baseManifest() as never, trustOf(['rfc8032-1']), { now: NOW }),
    ).rejects.toThrow(new TypeError('invalid expectId'));
    expect(server.requests).toHaveLength(0);
  });
});
