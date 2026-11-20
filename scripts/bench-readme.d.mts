// Types for scripts/bench-readme.mjs (the benchmark files check and the README table generator).

export interface BenchFile {
  name: string;
  origin?: string;
  source: string;
  sha256: string;
  json?: unknown;
  text?: string;
}

export interface Bench {
  schema: string;
  id: string;
  title: string;
  measuredAt: string;
  commit: { recorded: boolean; base?: string | null; sha?: string; dirty?: boolean; note: string };
  machine: { label: string; [k: string]: unknown };
  laptop8gb: string;
  method: string;
  commands: string[];
  files: BenchFile[];
  readonly __file?: string;
  readonly __bytes?: number;
}

export type Benches = Record<string, Bench>;

export const root: string;
export const BENCH_DIR: string;
export const SCHEMA: string;
export const LAPTOP_8GB: string;
export const NOT_KEPT: string;
export const MAX_FILE_BYTES: number;
export const CHECKED: Record<string, { profile: 'timing' | 'all'; allow: Record<string, string> }>;

export function loadBenchmarks(dir?: string): Benches;
export function validateEnvelope(env: unknown, fileName?: string): string[];
export function validateAll(benches: Benches, indexText?: string): string[];
export function part(bench: Bench, name: string): unknown;
export function packFigure(bench: Bench): string;
export function tableRows(benches: Benches): { a: string[][]; b: string[][] };
export function mdTable(header: string[], rows: string[][]): string;
export function tables(benches: Benches): Record<'table-a' | 'table-b', string>;
export function applyTables(readme: string, built: Record<string, string>): string;
export function proseOf(text: string, file?: string): string;
export function figureTokens(
  text: string,
  profile?: 'timing' | 'all',
): { text: string; number: string; unit: string; index: number }[];
export function supportedNumbers(benches: Benches): Record<string, Set<string>>;
export function unsupportedFigures(
  text: string,
  benches: Benches,
  options?: { profile?: 'timing' | 'all'; allow?: Record<string, string> },
): string[];
export function checkAll(dir?: string): string[];
