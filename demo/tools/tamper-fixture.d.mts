export interface TamperFixtureFile {
  /** Relative to spec/vectors. */
  from: string;
  /** Relative to the fixture directory. */
  to: string;
}
export const TAMPER_FIXTURE_FILES: readonly TamperFixtureFile[];
export const SPEC_VECTORS_DIR: string;
export const DEFAULT_TAMPER_OUT: string;
export function copyTamperFixture(opts: { vectorsDir: string; outDir: string }): void;
export function verifyTamperFixture(opts: { vectorsDir: string; outDir: string }): void;
export function buildTamperFixture(opts: { vectorsDir: string; outDir: string }): number;
