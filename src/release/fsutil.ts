/**
 * File handling of the release tool (manifest 0.1.4, "Release manifests": File handling).
 *
 * Every directory and every member is checked with lstat first: a symbolic link, a junction or other reparse point
 * (Node reports a junction as a symbolic link), a directory, a FIFO, a socket or a device is `not_regular_file`.
 * A file is then opened, and its identity (device and inode, which on Windows is the file index) is re-checked on
 * the open handle with fstat, so a file swapped for a link between the lstat and the open is caught. Nothing here
 * follows a link on purpose, and nothing reads more than it needs: the manifest, SHA256SUMS and the release-keys
 * file are read whole (with a size limit); artefacts are hashed as a stream.
 */

import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A stop with a token. The token is a release reason (`not_regular_file`, `artifact_missing`, ...) or a usage token
 * (`expect_id_required`, ...); the command that catches it decides whether it is a refusal (exit 3) or a usage
 * error (exit 2): tool.ts classify().
 */
export class ReleaseStop extends Error {
  override readonly name = 'ReleaseStop';
  readonly token: string;
  constructor(token: string, message: string) {
    super(message);
    this.token = token;
  }
}

/** Test hooks: a function that runs between the lstat and the open, to prove the identity check. */
export interface FsHooks {
  afterLstat?: (path: string) => void;
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/** lstat as BigIntStats, or undefined when the path does not exist. Any other error is thrown (exit 1). */
export async function lstatOrUndefined(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
}

/** True for an ordinary file that is not a link. */
export function isRegular(st: BigIntStats): boolean {
  return st.isFile() && !st.isSymbolicLink();
}

/** The directory must exist, be a directory and not be a link. */
export async function requireDirectory(dir: string): Promise<void> {
  const st = await lstat(dir, { bigint: true });
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new ReleaseStop('not_regular_file', 'the directory is a link or is not a directory');
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && b.isFile();
}

/**
 * Read-only open flags. O_NONBLOCK makes the open of a FIFO that was swapped in after the lstat return at once (instead of
 * blocking until a writer appears) and O_NOFOLLOW refuses a symbolic link swapped in after the lstat. Each flag is OR-ed in
 * only where the platform defines it (win32 defines neither); the fstat identity check that follows is the portable part.
 */
export function openReadFlags(c: {
  O_RDONLY: number;
  O_NONBLOCK?: number;
  O_NOFOLLOW?: number;
}): number {
  return c.O_RDONLY | (c.O_NONBLOCK ?? 0) | (c.O_NOFOLLOW ?? 0);
}

async function openChecked(path: string, hooks?: FsHooks) {
  const before = await lstat(path, { bigint: true });
  if (!isRegular(before))
    throw new ReleaseStop(
      'not_regular_file',
      'not a regular file (a link, a directory or another kind)',
    );
  hooks?.afterLstat?.(path);
  let handle;
  try {
    handle = await open(path, openReadFlags(fsConstants));
  } catch (e) {
    // a symlink swapped in after the lstat (O_NOFOLLOW) is a refusal, never an I/O error
    if ((e as NodeJS.ErrnoException)?.code === 'ELOOP')
      throw new ReleaseStop('not_regular_file', 'the file changed between the check and the open');
    throw e;
  }
  try {
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after))
      throw new ReleaseStop('not_regular_file', 'the file changed between the check and the open');
    return { handle, size: after.size };
  } catch (e) {
    await handle.close();
    throw e;
  }
}

/** A regular file read whole. Larger than `max` bytes is an error (exit 1), not a refusal. */
export async function readRegularFile(path: string, max: number, hooks?: FsHooks): Promise<Buffer> {
  const { handle, size } = await openChecked(path, hooks);
  try {
    if (size > BigInt(max)) throw new Error(`file is larger than ${max} bytes`);
    const buf = Buffer.alloc(Number(size));
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await handle.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    if (off !== buf.length) throw new Error('file is shorter than its size');
    return buf;
  } finally {
    await handle.close();
  }
}

/** Streams a regular file through SHA-256. Returns the lowercase hex digest and the size read. */
export async function hashRegularFile(
  path: string,
  hooks?: FsHooks,
): Promise<{ sha256: string; size: number }> {
  const { handle, size } = await openChecked(path, hooks);
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1 << 16);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    // a file that grew or shrank while it was being read is not the file that was checked
    if (BigInt(total) !== size)
      throw new ReleaseStop('not_regular_file', 'the file changed while it was being read');
    return { sha256: hash.digest('hex'), size: total };
  } finally {
    await handle.close();
  }
}

/** The names in the directory, sorted in byte order. Every member must be a regular file (lstat). */
export async function listRegularMembers(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const n of names) {
    const st = await lstat(join(dir, n), { bigint: true });
    if (!isRegular(st))
      throw new ReleaseStop('not_regular_file', `${JSON.stringify(n)} is not a regular file`);
  }
  return names;
}

/**
 * Writes `data` to a file inside the directory. A path that exists must be a regular file (checked with lstat and
 * again with fstat on the open handle) and is truncated in place; a path that does not exist is created and must not
 * appear as a link in the meantime (the open fails if it exists, 'wx').
 */
export async function writeRegularFile(path: string, data: Uint8Array): Promise<void> {
  const before = await lstatOrUndefined(path);
  if (before === undefined) {
    const h = await open(path, 'wx');
    try {
      await h.writeFile(data);
    } finally {
      await h.close();
    }
    return;
  }
  if (!isRegular(before))
    throw new ReleaseStop(
      'not_regular_file',
      'not a regular file (a link, a directory or another kind)',
    );
  const h = await open(path, 'r+');
  try {
    const after = await h.stat({ bigint: true });
    if (!sameIdentity(before, after))
      throw new ReleaseStop('not_regular_file', 'the file changed between the check and the open');
    await h.truncate(0);
    await h.writeFile(data);
  } finally {
    await h.close();
  }
}
