/**
 * OPFS AssetStore. Everything lives under <root>/airplanemode-runtime/v1/.
 *
 * A partial download is a directory `<sha>.part/` holding one file per appendPart call
 * (`000000.chunk`, `000001.chunk`, ...). Chrome's createWritable({ keepExistingData: true }) copies
 * the whole existing file into a swap file before each write, so appending to a single 700 MB
 * `.part` file would be quadratic; chunk files make every append O(chunk). commit() moves a single
 * chunk into place, or streams the chunks into `<sha>.bin` removing each chunk as soon as its
 * bytes are in the swap file, so the transient storage overhead of a commit is bounded by one
 * chunk rather than a second full copy of the asset (T1-B1). commitReserve() tells the manager to
 * make that room first. If a commit fails midway the consumed chunks are gone, so the store removes
 * the half-written file and the rest of the part: nothing resumable or readable is left behind.
 */

import {
  emptyIndex,
  type AssetStore,
  type IndexFile,
  type PartState,
  type StoreEstimate,
  type StoreListing,
} from './types';

const ROOT_DIR = 'airplanemode-runtime';
const VERSION_DIR = 'v1';
const SHA = /^[0-9a-f]{64}$/;

interface MovableFileHandle extends FileSystemFileHandle {
  move?(name: string): Promise<void>;
  move?(dir: FileSystemDirectoryHandle, name?: string): Promise<void>;
}

interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

function chunkName(seq: number): string {
  return `${String(seq).padStart(6, '0')}.chunk`;
}

function assertSha(sha: string): void {
  if (!SHA.test(sha)) throw new Error(`invalid sha ${sha}`);
}

async function listEntries(dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> {
  const out: [string, FileSystemHandle][] = [];
  for await (const entry of (dir as IterableDirectoryHandle).entries()) out.push(entry);
  return out;
}

async function removeEntry(
  dir: FileSystemDirectoryHandle,
  name: string,
  recursive = false,
): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive });
  } catch (e) {
    if ((e as { name?: string }).name !== 'NotFoundError') throw e;
  }
}

async function writeWhole(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: BufferSource | Blob | string,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable({ keepExistingData: false });
  try {
    await w.write(data);
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
  await w.close();
}

export class OpfsAssetStore implements AssetStore {
  readonly kind = 'opfs' as const;
  private dir: FileSystemDirectoryHandle | undefined;
  private readonly storage: StorageManager;

  constructor(storage?: StorageManager) {
    const s =
      storage ?? (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
    if (!s || typeof s.getDirectory !== 'function')
      throw new Error('OPFS (navigator.storage.getDirectory) is not available');
    this.storage = s;
  }

  async open(): Promise<void> {
    if (this.dir) return;
    const root = await this.storage.getDirectory();
    const base = await root.getDirectoryHandle(ROOT_DIR, { create: true });
    this.dir = await base.getDirectoryHandle(VERSION_DIR, { create: true });
  }

  private root(): FileSystemDirectoryHandle {
    if (!this.dir) throw new Error('store not open');
    return this.dir;
  }

  private async partDir(
    sha: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | undefined> {
    assertSha(sha);
    try {
      return await this.root().getDirectoryHandle(`${sha}.part`, { create });
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFoundError') return undefined;
      throw e;
    }
  }

  /** Chunk files of a part in sequence order with their sizes. */
  private async chunks(
    dir: FileSystemDirectoryHandle,
  ): Promise<{ name: string; size: number; handle: FileSystemFileHandle }[]> {
    const out: { name: string; size: number; handle: FileSystemFileHandle }[] = [];
    for (const [name, handle] of await listEntries(dir)) {
      if (handle.kind === 'file' && name.endsWith('.chunk')) {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.push({ name, size: file.size, handle: handle as FileSystemFileHandle });
      }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  async openPart(sha: string): Promise<void> {
    await this.partDir(sha, true);
  }

  async appendPart(sha: string, bytes: Uint8Array): Promise<void> {
    const dir = (await this.partDir(sha, true))!;
    const existing = await this.chunks(dir);
    const seq = existing.length ? Number(existing[existing.length - 1]!.name.slice(0, 6)) + 1 : 0;
    await writeWhole(dir, chunkName(seq), bytes as BufferSource);
  }

  async truncatePart(sha: string, length: number): Promise<void> {
    const dir = await this.partDir(sha, false);
    if (!dir) return;
    let kept = 0;
    for (const c of await this.chunks(dir)) {
      if (kept >= length) {
        await removeEntry(dir, c.name);
        continue;
      }
      const take = Math.min(c.size, length - kept);
      if (take < c.size) {
        const file = await c.handle.getFile();
        await writeWhole(dir, c.name, file.slice(0, take));
      }
      kept += take;
    }
  }

  async partLength(sha: string): Promise<number> {
    const dir = await this.partDir(sha, false);
    if (!dir) return 0;
    return (await this.chunks(dir)).reduce((n, c) => n + c.size, 0);
  }

  async *readPart(sha: string): AsyncIterable<Uint8Array> {
    const dir = await this.partDir(sha, false);
    if (!dir) return;
    for (const c of await this.chunks(dir)) {
      const file = await c.handle.getFile();
      yield new Uint8Array(await file.arrayBuffer());
    }
  }

  async partState(sha: string): Promise<PartState | undefined> {
    assertSha(sha);
    try {
      const fh = await this.root().getFileHandle(`${sha}.part.json`);
      const text = await (await fh.getFile()).text();
      const parsed = JSON.parse(text) as PartState;
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async writePartState(sha: string, state: PartState): Promise<void> {
    assertSha(sha);
    await writeWhole(this.root(), `${sha}.part.json`, JSON.stringify(state));
  }

  async removePart(sha: string): Promise<void> {
    assertSha(sha);
    await removeEntry(this.root(), `${sha}.part`, true);
    await removeEntry(this.root(), `${sha}.part.json`);
  }

  /** One chunk of swap-file transient while the chunks are streamed into `<sha>.bin`. */
  commitReserve(size: number, chunkSize: number): number {
    return Math.min(size, chunkSize);
  }

  async commit(sha: string): Promise<void> {
    const dir = await this.partDir(sha, false);
    if (!dir) throw new Error(`no part to commit for ${sha}`);
    const chunks = await this.chunks(dir);
    const root = this.root();
    const only = chunks.length === 1 ? (chunks[0]!.handle as MovableFileHandle) : undefined;
    let moved = false;
    if (only && typeof only.move === 'function') {
      try {
        await only.move(root, `${sha}.bin`);
        moved = true;
      } catch {
        moved = false; // fall back to streaming below; the chunk is untouched by a failed move
      }
    }
    if (!moved) {
      try {
        await this.concatenate(root, dir, chunks, sha);
      } catch (e) {
        // The chunks already streamed were removed, so this part cannot be resumed or committed
        // again. Leave neither a half-written file nor a dead part (and its state) behind.
        await removeEntry(root, `${sha}.bin`).catch(() => undefined);
        await this.removePart(sha).catch(() => undefined);
        throw e;
      }
    }
    await this.removePart(sha);
  }

  /**
   * Streams the chunks into `<sha>.bin`. After each chunk's bytes are in the writable's swap file
   * the chunk is removed, so storage never holds more than part + one chunk. On failure the swap
   * is discarded by abort(); the caller cleans up the rest.
   */
  private async concatenate(
    root: FileSystemDirectoryHandle,
    dir: FileSystemDirectoryHandle,
    chunks: { name: string; handle: FileSystemFileHandle }[],
    sha: string,
  ): Promise<void> {
    const fh = await root.getFileHandle(`${sha}.bin`, { create: true });
    const w = await fh.createWritable({ keepExistingData: false });
    try {
      for (const c of chunks) {
        await w.write(await c.handle.getFile());
        await removeEntry(dir, c.name);
      }
      await w.close();
    } catch (e) {
      await w.abort().catch(() => undefined);
      throw e;
    }
  }

  async readBlob(sha: string): Promise<Blob> {
    assertSha(sha);
    const fh = await this.root().getFileHandle(`${sha}.bin`);
    return fh.getFile();
  }

  async fileSize(sha: string): Promise<number | undefined> {
    assertSha(sha);
    try {
      const fh = await this.root().getFileHandle(`${sha}.bin`);
      return (await fh.getFile()).size;
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFoundError') return undefined;
      throw e;
    }
  }

  async remove(sha: string): Promise<void> {
    assertSha(sha);
    await removeEntry(this.root(), `${sha}.bin`);
  }

  async list(): Promise<StoreListing> {
    const bins: string[] = [];
    const binModified: Record<string, number> = {};
    const parts: string[] = [];
    const partStates: string[] = [];
    for (const [name, handle] of await listEntries(this.root())) {
      if (handle.kind === 'file' && name.endsWith('.bin')) {
        const sha = name.slice(0, -4);
        bins.push(sha);
        try {
          binModified[sha] = (await (handle as FileSystemFileHandle).getFile()).lastModified;
        } catch {
          // a file that vanished between listing and stat is not a problem for reconcile
        }
      } else if (handle.kind === 'directory' && name.endsWith('.part'))
        parts.push(name.slice(0, -5));
      else if (handle.kind === 'file' && name.endsWith('.part.json'))
        partStates.push(name.slice(0, -10));
    }
    return {
      bins: bins.filter((s) => SHA.test(s)),
      binModified,
      parts: parts.filter((s) => SHA.test(s)),
      partStates: partStates.filter((s) => SHA.test(s)),
    };
  }

  async readIndex(): Promise<IndexFile> {
    try {
      const fh = await this.root().getFileHandle('index.json');
      const parsed = JSON.parse(await (await fh.getFile()).text()) as Partial<IndexFile>;
      if (!parsed || parsed.version !== 1 || typeof parsed.rows !== 'object') return emptyIndex();
      return { version: 1, rows: parsed.rows ?? {}, manifests: parsed.manifests ?? {} };
    } catch {
      return emptyIndex();
    }
  }

  async writeIndex(index: IndexFile): Promise<void> {
    await writeWhole(this.root(), 'index.json', JSON.stringify(index));
  }

  async estimate(): Promise<StoreEstimate> {
    try {
      const e = await this.storage.estimate();
      const out: StoreEstimate = { usage: e.usage ?? 0 };
      if (typeof e.quota === 'number') out.quota = e.quota;
      return out;
    } catch {
      return { usage: 0 };
    }
  }
}
