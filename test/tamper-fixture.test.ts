// D1-03: the demo's tamper fixture is a verbatim copy of spec/vectors/tamper and spec/vectors/tamper-assets,
// and the build fails if any copied file's sha256 differs from the spec. Written before
// demo/tools/tamper-fixture.mjs existed (red run: evidence/sprint-4/D1/red-D1-03.log).

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TAMPER_FIXTURE_FILES,
  copyTamperFixture,
  verifyTamperFixture,
} from '../demo/tools/tamper-fixture.mjs';
import { repoDir } from './helpers';

const vectorsDir = resolve(repoDir, 'spec/vectors');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('the demo tamper fixture (demo/public/tamper)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const fresh = () => {
    const out = mkdtempSync(join(tmpdir(), 'tamper-fixture-'));
    dirs.push(out);
    return out;
  };

  it('lists the 15 tamper vectors, tamper.json, the three asset manifests, the three .bin files and expect.json', () => {
    const names = TAMPER_FIXTURE_FILES.map((f) => f.to).sort();
    expect(names).toHaveLength(23);
    expect(names.filter((n) => n.startsWith('vectors/tamper-'))).toHaveLength(15);
    expect(names).toContain('vectors/tamper.json');
    expect(names).toContain('assets/expect.json');
    for (const n of ['manifest-ok.json', 'manifest-flip.json', 'manifest-truncated.json'])
      expect(names).toContain(`assets/${n}`);
    for (const n of ['asset-ok.bin', 'asset-flip.bin', 'asset-truncated.bin'])
      expect(names).toContain(`assets/${n}`);
    expect(names.some((n) => n.endsWith('README.md'))).toBe(false);
  });

  it('copies every file byte for byte (the same sha256 as spec/)', () => {
    const out = fresh();
    copyTamperFixture({ vectorsDir, outDir: out });
    for (const f of TAMPER_FIXTURE_FILES) {
      expect(sha(join(out, f.to)), f.to).toBe(sha(join(vectorsDir, f.from)));
    }
    expect(() => verifyTamperFixture({ vectorsDir, outDir: out })).not.toThrow();
  });

  it('fails when a copied vector differs by one byte', () => {
    const out = fresh();
    copyTamperFixture({ vectorsDir, outDir: out });
    const p = join(out, 'vectors/tamper-01-entry-sha-byte.json');
    const bytes = readFileSync(p);
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x01;
    writeFileSync(p, bytes);
    expect(() => verifyTamperFixture({ vectorsDir, outDir: out })).toThrow(
      /tamper-01-entry-sha-byte\.json.*sha256/,
    );
  });

  it('fails when an asset .bin differs, a file is missing, or a stray file appears', () => {
    const out = fresh();
    copyTamperFixture({ vectorsDir, outDir: out });
    const bin = join(out, 'assets/asset-flip.bin');
    const b = readFileSync(bin);
    b[2048] = b[2048]! ^ 0x01;
    writeFileSync(bin, b);
    expect(() => verifyTamperFixture({ vectorsDir, outDir: out })).toThrow(
      /asset-flip\.bin.*sha256/,
    );
    copyTamperFixture({ vectorsDir, outDir: out }); // restores
    rmSync(join(out, 'vectors/tamper.json'));
    expect(() => verifyTamperFixture({ vectorsDir, outDir: out })).toThrow(/missing.*tamper\.json/);
    copyTamperFixture({ vectorsDir, outDir: out });
    writeFileSync(join(out, 'assets/extra.bin'), 'x');
    expect(() => verifyTamperFixture({ vectorsDir, outDir: out })).toThrow(
      /unexpected.*extra\.bin/,
    );
  });

  it('copyTamperFixture refuses an output directory outside demo/public or the OS temp directory', () => {
    expect(() => copyTamperFixture({ vectorsDir, outDir: resolve(repoDir, 'src/x') })).toThrow(
      /refusing to write outside/,
    );
  });

  it('the built fixture, when present, equals the spec (npm run demo:build writes it)', () => {
    const built = resolve(repoDir, 'demo/public/tamper');
    if (!existsSync(built)) return;
    expect(() => verifyTamperFixture({ vectorsDir, outDir: built })).not.toThrow();
    expect(readdirSync(join(built, 'assets')).length).toBe(7);
  });
});
