// A tiny in-memory OPFS for node tests of OpfsAssetStore: just the slice index.json needs (nested
// directories, file handles, createWritable/write/close, getFile().text()). Not a conformance
// implementation: the real thing is exercised in installed Chrome by the browser specs.

class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

class FakeFile {
  constructor(
    private readonly data: Uint8Array,
    readonly lastModified: number,
  ) {}
  get size(): number {
    return this.data.length;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(this.data);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.slice().buffer;
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;
  data = new Uint8Array(0);
  modified = Date.now();
  constructor(readonly name: string) {}
  async getFile(): Promise<FakeFile> {
    return new FakeFile(this.data, this.modified);
  }
  async createWritable(): Promise<{
    write(d: BufferSource | Blob | string): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    let next = new Uint8Array(0);
    return {
      write: async (d) => {
        next =
          typeof d === 'string'
            ? new TextEncoder().encode(d)
            : d instanceof Blob || d instanceof FakeFile
              ? new Uint8Array(await d.arrayBuffer())
              : new Uint8Array(d as ArrayBuffer);
      },
      close: async () => {
        this.data = next;
        this.modified = Date.now();
      },
      abort: async () => undefined,
    };
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  private readonly children = new Map<string, FakeDirectoryHandle | FakeFileHandle>();
  constructor(readonly name: string) {}
  async getDirectoryHandle(
    name: string,
    opts: { create?: boolean } = {},
  ): Promise<FakeDirectoryHandle> {
    const e = this.children.get(name);
    if (e instanceof FakeDirectoryHandle) return e;
    if (e || !opts.create) throw new NotFoundError(`no directory ${name}`);
    const d = new FakeDirectoryHandle(name);
    this.children.set(name, d);
    return d;
  }
  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeFileHandle> {
    const e = this.children.get(name);
    if (e instanceof FakeFileHandle) return e;
    if (e || !opts.create) throw new NotFoundError(`no file ${name}`);
    const f = new FakeFileHandle(name);
    this.children.set(name, f);
    return f;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) throw new NotFoundError(`no entry ${name}`);
  }
  async *entries(): AsyncGenerator<[string, FakeDirectoryHandle | FakeFileHandle]> {
    for (const e of this.children) yield e;
  }
}

export interface FakeStorageManager {
  getDirectory(): Promise<FakeDirectoryHandle>;
  root: FakeDirectoryHandle;
}

export function fakeStorageManager(): FakeStorageManager {
  const root = new FakeDirectoryHandle('');
  return { root, getDirectory: async () => root };
}

/** Writes `text` as `<airplanemode-runtime>/<v1>/index.json`, the file OpfsAssetStore reads. */
export async function writeOpfsIndexText(sm: FakeStorageManager, text: string): Promise<void> {
  const base = await sm.root.getDirectoryHandle('airplanemode-runtime', { create: true });
  const v = await base.getDirectoryHandle('v1', { create: true });
  const fh = await v.getFileHandle('index.json', { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}
