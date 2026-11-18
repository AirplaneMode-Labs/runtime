/**
 * In-worker integrity (backend adapter 0.4.0, R15, S1-070). The page hands the worker each file as a Blob
 * together with the manifest entry's `sha256` and `size`; before the engine is imported, before anything is
 * registered under the verified prefix, the worker
 *
 *   1. checks blob.size === entry.size for every file (a mismatch is refused before any hashing),
 *   2. reads each file into an ArrayBuffer, one file at a time, and computes SHA-256 with crypto.subtle over
 *      those bytes, for every file the engine can read: the .onnx graph, the ORT .wasm, tokenizer.json,
 *      tokenizer_config.json, config.json, generation_config.json, chat_template.jinja and
 *      special_tokens_map.json. No kind is exempt,
 *   3. serves the engine from the very File snapshot it hashed (method (ii)): the Blob the page posted is what
 *      the engine reads, not a copy. An OPFS File snapshot becomes unreadable (NotReadableError) when the
 *      file is written after the snapshot was taken, so a write between the hash and the engine's read can
 *      never put different bytes in front of the engine: the shim probes the snapshot before it serves it
 *      (verified-files.ts) and the failure is 'integrity' before the engine receives a byte. IndexedDB and
 *      memory Blobs are immutable. The one file the engine takes as bytes (the ORT wasm binary, named in
 *      `keepBuffer`) is handed over as the very buffer that was hashed.
 *
 * Any failure (a size or digest mismatch, a Blob that cannot be read, which is a NotReadableError when an OPFS
 * snapshot changed) is AdapterError('integrity') and the caller has registered nothing: the engine receives 0
 * bytes. The digest comparison is on the lowercase hex strings the signed manifest carries.
 *
 * Why not method (i), serving a copy made from the hashed buffer: a 617 MB model copied into a new Blob in the
 * worker made the engine's own read of it fail on the Apple M5 Pro run, and the copy would put a second full
 * copy of every model in memory beside the one the engine creates. Method (ii) holds one file's bytes at a time.
 */

import { AdapterError } from '../../spec/backend-adapter';

export interface FileToVerify {
  path: string;
  entryId: string;
  sha256: string;
  size: number;
  blob: Blob;
}

export interface VerifiedFile {
  path: string;
  entryId: string;
  sha256: string;
  /** The Blob that was hashed (method (ii): not a copy). */
  blob: Blob;
  /** Present only for the path named in `keepBuffer`. */
  buffer?: ArrayBuffer;
}

export interface VerifyOutcome {
  files: VerifiedFile[];
  /** Total bytes hashed. */
  bytes: number;
}

const toHex = (buf: ArrayBuffer): string => {
  const b = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < b.length; i++) out += (b[i]! < 16 ? '0' : '') + b[i]!.toString(16);
  return out;
};

export async function verifyFiles(
  files: readonly FileToVerify[],
  options: { keepBuffer?: string; subtle?: Pick<SubtleCrypto, 'digest'> } = {},
): Promise<VerifyOutcome> {
  const subtle = options.subtle ?? globalThis.crypto?.subtle;
  if (!subtle) throw new AdapterError('backend', 'this worker has no crypto.subtle to verify with');
  // 1. sizes first, for every file, before any byte is read
  for (const f of files)
    if (!(f.blob instanceof Blob) || !Number.isSafeInteger(f.size) || f.blob.size !== f.size)
      throw new AdapterError(
        'integrity',
        'a file does not have the size its manifest entry promised',
      );
  const out: VerifiedFile[] = [];
  let bytes = 0;
  for (const f of files) {
    let buffer: ArrayBuffer;
    try {
      buffer = await f.blob.arrayBuffer();
    } catch {
      // NotReadableError (an OPFS snapshot that changed) or anything else: not the bytes that were verified
      throw new AdapterError('integrity', 'a file could not be read for verification');
    }
    if (buffer.byteLength !== f.size)
      throw new AdapterError('integrity', 'a file changed size while it was read');
    let digest: string;
    try {
      digest = toHex(await subtle.digest('SHA-256', buffer));
    } catch {
      throw new AdapterError('backend', 'the digest could not be computed');
    }
    if (digest !== f.sha256)
      throw new AdapterError('integrity', 'a file does not match its signed hash');
    bytes += buffer.byteLength;
    const verified: VerifiedFile = {
      path: f.path,
      entryId: f.entryId,
      sha256: f.sha256,
      blob: f.blob,
    };
    // only the file the engine takes as bytes keeps its buffer; every other buffer is dropped here
    if (options.keepBuffer === f.path) verified.buffer = buffer;
    out.push(verified);
  }
  return { files: out, bytes };
}
