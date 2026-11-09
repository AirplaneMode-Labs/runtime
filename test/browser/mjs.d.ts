// Types for the zero-dependency Node oracles in test/tools/*.mjs that the browser specs import.
// Only the members the specs use are declared.
declare module '*.mjs' {
  export const RFC8032_SEED_HEX: string;
  export const RFC8032_PUBLIC_HEX: string;
  export function signManifest(
    manifest: Record<string, unknown>,
    seedHex: string,
    signedAt: string,
  ): { alg: string; keyId: string; publicKey: string; sig: string; signedAt: string };
  export function canonicalize(value: unknown): string;
  export function keyIdOf(rawPub: Uint8Array): string;
  export function sha256Hex(bytes: Uint8Array): string;
  export class AssetStream {
    constructor(name: string);
    fill(out: Uint8Array): Uint8Array;
  }
  export function parseArgs(argv: string[]): unknown;
}
