import { describe, expect, it } from 'vitest';
import { Sha256, sha256Hex, toHex } from '../src/sha256';
import { pseudoRandomBytes } from './helpers';

async function subtleHex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
}

describe('Sha256 (streaming, pure TypeScript)', () => {
  it('matches the known empty-string digest', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the known "abc" digest', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 1048576 + 3]) {
    it(`matches crypto.subtle for ${n} bytes`, async () => {
      const bytes = pseudoRandomBytes(n, n + 7);
      expect(sha256Hex(bytes)).toBe(await subtleHex(bytes));
    });
  }

  it('matches crypto.subtle for 50 random lengths, fed in irregular pieces', async () => {
    let seed = 12345;
    for (let i = 0; i < 50; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const n = seed % 20000;
      const bytes = pseudoRandomBytes(n, seed);
      const h = new Sha256();
      let off = 0;
      let piece = 1;
      while (off < n) {
        const len = Math.min(piece, n - off);
        h.update(bytes.subarray(off, off + len));
        off += len;
        piece = (piece * 3 + 1) % 777;
      }
      expect(h.digestHex(), `length ${n}`).toBe(await subtleHex(bytes));
    }
  });

  it('digest is idempotent and update after digest throws', () => {
    const h = new Sha256();
    h.update(new Uint8Array([1, 2, 3]));
    const a = h.digestHex();
    expect(h.digestHex()).toBe(a);
    expect(() => h.update(new Uint8Array([4]))).toThrow();
  });

  it('handles subarray views with a non-zero byteOffset', async () => {
    const backing = pseudoRandomBytes(300, 9);
    const view = backing.subarray(17, 283);
    expect(sha256Hex(view)).toBe(await subtleHex(new Uint8Array(view)));
  });

  it('streams a multi-MiB input in 64 KiB pieces identically to one shot', () => {
    const bytes = pseudoRandomBytes(3 * 1048576 + 11, 3);
    const h = new Sha256();
    for (let off = 0; off < bytes.length; off += 65536) h.update(bytes.subarray(off, off + 65536));
    expect(h.digestHex()).toBe(sha256Hex(bytes));
  });
});
