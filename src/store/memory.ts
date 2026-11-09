import {
  emptyIndex,
  type AssetStore,
  type IndexFile,
  type PartState,
  type StoreEstimate,
  type StoreListing,
} from './types';

/** In-memory AssetStore for tests and for environments without any persistent storage. */
export class MemoryAssetStore implements AssetStore {
  readonly kind = 'memory' as const;
  private readonly bins = new Map<string, Uint8Array[]>();
  private readonly parts = new Map<string, Uint8Array[]>();
  private readonly partStates = new Map<string, PartState>();
  private index: IndexFile | undefined;
  private readonly quota: number | undefined;

  constructor(options: { quota?: number } = {}) {
    this.quota = options.quota;
  }

  async open(): Promise<void> {}

  async openPart(sha: string): Promise<void> {
    if (!this.parts.has(sha)) this.parts.set(sha, []);
  }

  async appendPart(sha: string, bytes: Uint8Array): Promise<void> {
    let chunks = this.parts.get(sha);
    if (!chunks) {
      chunks = [];
      this.parts.set(sha, chunks);
    }
    chunks.push(bytes.slice());
  }

  async truncatePart(sha: string, length: number): Promise<void> {
    const chunks = this.parts.get(sha);
    if (!chunks) return;
    let kept = 0;
    const out: Uint8Array[] = [];
    for (const c of chunks) {
      if (kept >= length) break;
      const take = Math.min(c.length, length - kept);
      out.push(take === c.length ? c : c.slice(0, take));
      kept += take;
    }
    this.parts.set(sha, out);
  }

  async partLength(sha: string): Promise<number> {
    return (this.parts.get(sha) ?? []).reduce((n, c) => n + c.length, 0);
  }

  async *readPart(sha: string): AsyncIterable<Uint8Array> {
    for (const c of this.parts.get(sha) ?? []) yield c;
  }

  async partState(sha: string): Promise<PartState | undefined> {
    const s = this.partStates.get(sha);
    return s ? { ...s } : undefined;
  }

  async writePartState(sha: string, state: PartState): Promise<void> {
    this.partStates.set(sha, { ...state });
  }

  async removePart(sha: string): Promise<void> {
    this.parts.delete(sha);
    this.partStates.delete(sha);
  }

  commitReserve(_size: number, _chunkSize: number): number {
    return 0; // commit only moves references
  }

  async commit(sha: string): Promise<void> {
    const chunks = this.parts.get(sha);
    if (!chunks) throw new Error(`no part to commit for ${sha}`);
    this.bins.set(sha, chunks);
    this.parts.delete(sha);
    this.partStates.delete(sha);
  }

  async readBlob(sha: string): Promise<Blob> {
    const chunks = this.bins.get(sha);
    if (!chunks) throw new Error(`no committed file for ${sha}`);
    return new Blob(chunks as BlobPart[]);
  }

  async fileSize(sha: string): Promise<number | undefined> {
    const chunks = this.bins.get(sha);
    return chunks ? chunks.reduce((n, c) => n + c.length, 0) : undefined;
  }

  async remove(sha: string): Promise<void> {
    this.bins.delete(sha);
  }

  async list(): Promise<StoreListing> {
    return {
      bins: [...this.bins.keys()],
      parts: [...this.parts.keys()],
      partStates: [...this.partStates.keys()],
    };
  }

  async readIndex(): Promise<IndexFile> {
    return structuredClone(this.index ?? emptyIndex());
  }

  async writeIndex(index: IndexFile): Promise<void> {
    this.index = structuredClone(index);
  }

  async estimate(): Promise<StoreEstimate> {
    let usage = 0;
    for (const chunks of this.bins.values()) for (const c of chunks) usage += c.length;
    for (const chunks of this.parts.values()) for (const c of chunks) usage += c.length;
    const est: StoreEstimate = { usage };
    if (this.quota !== undefined) est.quota = this.quota;
    return est;
  }

  /** TEST ONLY: replaces the committed bytes of `sha` to simulate on-disk corruption. */
  corruptBin(sha: string, bytes: Uint8Array): void {
    if (!this.bins.has(sha)) throw new Error(`no committed file for ${sha}`);
    this.bins.set(sha, [bytes.slice()]);
  }
}
