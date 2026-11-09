// Types for test/tools/fetch-model.mjs (the CLI itself has no TypeScript consumers).
export interface ModelFileEntry {
  path: string;
  size: number;
  sha256?: string;
  gitBlobSha1?: string;
}
export interface ModelEntry {
  repo: string;
  revision: string;
  licence?: string;
  files: ModelFileEntry[];
  [k: string]: unknown;
}
export interface ModelsJson {
  schema: number;
  models: Record<string, ModelEntry>;
  reference?: unknown;
}
export type FetchModelCode =
  | 'unknown_model'
  | 'bad_models_json'
  | 'bad_path'
  | 'dest_escape'
  | 'missing_sha256'
  | 'unpinnable'
  | 'not_https'
  | 'http_status'
  | 'size_mismatch'
  | 'sha256_mismatch'
  | 'git_blob_mismatch'
  | 'ort_missing'
  | 'ort_pin_mismatch';
export class FetchModelError extends Error {
  readonly code: FetchModelCode;
  constructor(code: FetchModelCode, message: string);
}
export interface FetchModelOptions {
  name: string;
  models: ModelsJson;
  dest: string;
  pin?: boolean;
  modelsPath?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}
export interface FetchModelResult {
  files: { path: string; status: 'downloaded' | 'cached' | 'pinned'; size: number }[];
  pinned: number;
}
export function validateModelPath(path: string): void;
export function gitBlobSha1(bytes: Uint8Array): string;
export function fetchModel(opts: FetchModelOptions): Promise<FetchModelResult>;
export interface CopyOrtOptions {
  dest: string;
  distDir: string;
  pinsPath: string;
  log?: (line: string) => void;
}
export function copyOrtFiles(opts: CopyOrtOptions): Promise<{ copied: string[]; checked: boolean }>;
export function main(argv: string[]): Promise<number>;
