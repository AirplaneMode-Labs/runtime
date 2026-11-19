// Sprint 6, D1-07: the engine-load retry root cause, as a reproduction (docs/engine-load-retry.md).
//
// The observation (Sprint 5, Chrome 157, dockit): a model file that was written to OPFS less than about a second
// ago could fail its first read by the engine, code 'backend'; the same load a moment later succeeded. The
// hypothesis: the OPFS write has not settled when the R15 File snapshot is taken and read, so the snapshot is
// short, stale or unreadable.
//
// This spec writes a synthetic ~64 MiB file the way src/store/opfs.ts does (8 MiB chunk files, then the chunks
// streamed into `<sha>.bin` through createWritable(), each chunk removed as it is consumed, then close()), takes
// the File snapshot IMMEDIATELY after close() resolves, posts it to a worker and reads it there, and compares the
// size and a 32-bit FNV-1a checksum of what the worker read with what was written. It repeats that
// RUNTIME_SNAPSHOT_ITERATIONS times (default 50) and records, per iteration, the size read, the checksum match and
// the error name if the read failed. Two more variants: the snapshot read straight after a single createWritable()
// write (no chunk files), and a snapshot taken immediately but read 1.5 s later. A last test changes the file after
// a snapshot was taken and shows what Chrome then does to the old snapshot (the platform fact behind R15, R20).
//
//   RUNTIME_MODEL=1 RUNTIME_MODEL_LEGS=wasm npm run test:model          (it rides the model config)
//   RUNTIME_SNAPSHOT_ITERATIONS=50 RUNTIME_MODEL_OUT=<dir> ...           (counts go to opfs-snapshot.json there)
//
// Not measured on 8 GB: one Apple M5 Pro, 48 GB, installed Chrome.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from 'playwright/test';
import { resultsDir } from './out-dir';

const OUT_DIR = resultsDir('RUNTIME_MODEL_OUT');
const ITERATIONS = Number(process.env['RUNTIME_SNAPSHOT_ITERATIONS'] ?? '50');
const MiB = 1024 * 1024;

test.skip(
  process.env['RUNTIME_MODEL'] !== '1',
  'set RUNTIME_MODEL=1 to run the OPFS snapshot proof',
);
test.describe.configure({ mode: 'serial' });

interface Probe {
  variant: string;
  iteration: number;
  expectedSize: number;
  snapshotSize: number;
  readOk: boolean;
  readSize: number;
  checksumMatch: boolean;
  error: string;
  writeMs: number;
  readMs: number;
}

const results: Record<string, unknown> = { generatedAt: new Date().toISOString() };

test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, 'opfs-snapshot.json'), JSON.stringify(results, null, 2) + '\n');
});

/** A page with no CSP on the test server's origin (a secure context: loopback), so OPFS and a blob worker work. */
async function plainPage(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/__opfs-snapshot-probe__`).catch(() => undefined);
  await page.setContent('<!doctype html><title>opfs snapshot probe</title>');
}

/** Runs one variant in the page and returns one Probe per iteration. */
async function runVariant(
  page: Page,
  variant: 'chunked-immediate' | 'single-immediate' | 'chunked-held-1500ms' | 'chunked-large-twice',
  iterations: number,
  size: number,
): Promise<Probe[]> {
  return await page.evaluate(
    async ({ variant, iterations, size }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('snapshot-probe', { create: true });

      // deterministic data and its expected checksum (FNV-1a over 32-bit words)
      const words = size / 4;
      const data = new Uint32Array(words);
      let x = 0x9e3779b9;
      for (let i = 0; i < words; i++) {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        data[i] = x;
      }
      const fnv = (u: Uint32Array): number => {
        let h = 0x811c9dc5;
        for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 0x01000193) >>> 0;
        return h;
      };
      const expected = fnv(data);
      const bytes = new Uint8Array(data.buffer);

      const workerSource = `
        const fnv = (u) => { let h = 0x811c9dc5; for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0; return h; };
        onmessage = async (e) => {
          const { file, delayMs, twice } = e.data;
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          const t0 = performance.now();
          try {
            let buf = await file.arrayBuffer();
            if (twice) {
              // the hash read, dropped, then the engine's own read of the same snapshot
              const first = fnv(new Uint32Array(buf));
              buf = null;
              buf = await file.arrayBuffer();
              if (fnv(new Uint32Array(buf)) !== first) throw Object.assign(new Error('two reads differ'), { name: 'ReadsDiffer' });
            }
            postMessage({ ok: true, size: buf.byteLength, fnv: fnv(new Uint32Array(buf)), ms: performance.now() - t0 });
          } catch (err) {
            postMessage({ ok: false, error: String(err && err.name), ms: performance.now() - t0 });
          }
        };`;
      const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      const worker = new Worker(url);
      const ask = (file: File, delayMs: number, twice = false) =>
        new Promise<{ ok: boolean; size?: number; fnv?: number; error?: string; ms: number }>(
          (resolve) => {
            worker.onmessage = (ev) => resolve(ev.data);
            worker.postMessage({ file, delayMs, twice });
          },
        );

      const out: Probe[] = [];
      const CHUNK = 8 * 1024 * 1024;
      for (let i = 0; i < iterations; i++) {
        const name = `probe-${variant}-${i}.bin`;
        const t0 = performance.now();
        if (variant === 'single-immediate') {
          const fh = await dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable({ keepExistingData: false });
          await w.write(bytes);
          await w.close();
        } else {
          // the store's path: chunk files, then streamed into <name> through createWritable, chunk removed as consumed
          const part = await dir.getDirectoryHandle(`${name}.part`, { create: true });
          const names: string[] = [];
          for (let off = 0, seq = 0; off < bytes.length; off += CHUNK, seq++) {
            const cn = `${String(seq).padStart(6, '0')}.chunk`;
            const cfh = await part.getFileHandle(cn, { create: true });
            const cw = await cfh.createWritable({ keepExistingData: false });
            await cw.write(bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
            await cw.close();
            names.push(cn);
          }
          const fh = await dir.getFileHandle(name, { create: true });
          const w = await fh.createWritable({ keepExistingData: false });
          for (const cn of names) {
            const cfh = await part.getFileHandle(cn);
            await w.write(await cfh.getFile());
            await part.removeEntry(cn);
          }
          await w.close();
          await dir.removeEntry(`${name}.part`, { recursive: true });
        }
        const writeMs = performance.now() - t0;
        // the snapshot, taken the instant close() has resolved
        const fh = await dir.getFileHandle(name);
        const file = await fh.getFile();
        const snapshotSize = file.size;
        const r = await ask(
          file,
          variant === 'chunked-held-1500ms' ? 1500 : 0,
          variant === 'chunked-large-twice',
        );
        out.push({
          variant,
          iteration: i,
          expectedSize: size,
          snapshotSize,
          readOk: r.ok,
          readSize: r.size ?? 0,
          checksumMatch: r.ok && r.fnv === expected,
          error: r.error ?? '',
          writeMs: Math.round(writeMs),
          readMs: Math.round(r.ms),
        });
        await dir.removeEntry(name).catch(() => undefined);
      }
      worker.terminate();
      URL.revokeObjectURL(url);
      await root.removeEntry('snapshot-probe', { recursive: true }).catch(() => undefined);
      return out;
    },
    { variant, iterations, size },
  );
}

function summarise(probes: Probe[]) {
  return {
    iterations: probes.length,
    snapshotSizeWrong: probes.filter((p) => p.snapshotSize !== p.expectedSize).length,
    readFailed: probes.filter((p) => !p.readOk).length,
    readSizeWrong: probes.filter((p) => p.readOk && p.readSize !== p.expectedSize).length,
    checksumWrong: probes.filter((p) => p.readOk && !p.checksumMatch).length,
    errors: [...new Set(probes.filter((p) => p.error).map((p) => p.error))],
    medianWriteMs: probes.map((p) => p.writeMs).sort((a, b) => a - b)[
      Math.floor(probes.length / 2)
    ],
    medianReadMs: probes.map((p) => p.readMs).sort((a, b) => a - b)[Math.floor(probes.length / 2)],
  };
}

test(`D1-07: a 64 MiB file written through the store's chunked commit path and snapshotted immediately reads back whole, ${ITERATIONS} times`, async ({
  page,
  baseURL,
}) => {
  test.setTimeout(15 * 60_000);
  await plainPage(page, baseURL!);
  const probes = await runVariant(page, 'chunked-immediate', ITERATIONS, 64 * MiB);
  const summary = summarise(probes);
  results['chunked-immediate'] = { summary, probes };
  console.log('chunked-immediate', JSON.stringify(summary));
  // the outcome is recorded either way (docs/engine-load-retry.md quotes it); the expectations state what was observed
  expect(probes).toHaveLength(ITERATIONS);
  expect(summary.snapshotSizeWrong, 'a snapshot with the wrong size').toBe(0);
  expect(summary.readFailed, 'a read that failed').toBe(0);
  expect(summary.readSizeWrong, 'a read of the wrong size').toBe(0);
  expect(summary.checksumWrong, 'a read with other bytes').toBe(0);
});

test('D1-07: a single createWritable write snapshotted immediately, and a snapshot read 1.5 s after it was taken, read back whole', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(15 * 60_000);
  await plainPage(page, baseURL!);
  const single = await runVariant(page, 'single-immediate', Math.min(ITERATIONS, 20), 64 * MiB);
  const held = await runVariant(page, 'chunked-held-1500ms', Math.min(ITERATIONS, 10), 64 * MiB);
  results['single-immediate'] = { summary: summarise(single), probes: single };
  results['chunked-held-1500ms'] = { summary: summarise(held), probes: held };
  console.log('single-immediate', JSON.stringify(summarise(single)));
  console.log('chunked-held-1500ms', JSON.stringify(summarise(held)));
  for (const s of [summarise(single), summarise(held)]) {
    expect(s.snapshotSizeWrong).toBe(0);
    expect(s.readFailed).toBe(0);
    expect(s.readSizeWrong).toBe(0);
    expect(s.checksumWrong).toBe(0);
  }
});

test('D1-07: a file changed after a snapshot was taken makes the OLD snapshot unreadable (NotReadableError), never a read of other bytes (R15, R20)', async ({
  page,
  baseURL,
}) => {
  await plainPage(page, baseURL!);
  const r = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('snapshot-change', { create: true });
    const fh = await dir.getFileHandle('f.bin', { create: true });
    const write = async (fill: number, len: number) => {
      const w = await fh.createWritable({ keepExistingData: false });
      await w.write(new Uint8Array(len).fill(fill));
      await w.close();
    };
    await write(1, 4096);
    const snapshot = await fh.getFile();
    const before = new Uint8Array(await snapshot.arrayBuffer());
    // the hash would have been taken here; now the file changes (same size, other bytes)
    await write(2, 4096);
    let after: { ok: boolean; name?: string; firstByte?: number } = { ok: true };
    try {
      const again = new Uint8Array(await snapshot.arrayBuffer());
      after = { ok: true, firstByte: again[0]! };
    } catch (e) {
      after = { ok: false, name: String((e as { name?: string }).name) };
    }
    let probeAfter: { ok: boolean; name?: string } = { ok: true };
    try {
      await snapshot.slice(0, 1).arrayBuffer();
    } catch (e) {
      probeAfter = { ok: false, name: String((e as { name?: string }).name) };
    }
    await root.removeEntry('snapshot-change', { recursive: true }).catch(() => undefined);
    return { firstBefore: before[0], after, probeAfter };
  });
  results['changed-after-snapshot'] = r;
  console.log('changed-after-snapshot', JSON.stringify(r));
  expect(r.firstBefore).toBe(1);
  // the old snapshot must never serve the new bytes: it fails to read, or still serves the OLD bytes
  if (r.after.ok) expect(r.after.firstByte).toBe(1);
  else expect(r.after.name).toBe('NotReadableError');
});

test('D1-07: a model-sized file (600 MiB) written through the chunked commit path, snapshotted immediately and read twice (the hash read, then the engine read), reads back whole', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(20 * 60_000);
  const mib = Number(process.env['RUNTIME_SNAPSHOT_LARGE_MIB'] ?? '600');
  const n = Number(process.env['RUNTIME_SNAPSHOT_LARGE_ITERATIONS'] ?? '3');
  await plainPage(page, baseURL!);
  const probes = await runVariant(page, 'chunked-large-twice', n, mib * MiB);
  const summary = summarise(probes);
  results['chunked-large-twice'] = { sizeMiB: mib, summary, probes };
  console.log('chunked-large-twice', mib, 'MiB', JSON.stringify(summary));
  expect(summary.snapshotSizeWrong).toBe(0);
  expect(summary.readFailed, JSON.stringify(summary)).toBe(0);
  expect(summary.readSizeWrong).toBe(0);
  expect(summary.checksumWrong).toBe(0);
});
