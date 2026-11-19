// The ps parser behind the Chrome process-tree RSS figure (TD-49). The sampler itself is exercised by the
// local model run (test/browser/qwen06.spec.ts).
import { describe, expect, it } from 'vitest';
import { parsePs, sampleOnce } from './browser/rss';

const PROFILE = '/tmp/chrome-profile-x';
const PS = [
  `  100     1  50000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${PROFILE} --headless`,
  '  101   100  30000 Chrome Helper (GPU) --type=gpu-process',
  '  102   100  40000 Chrome Helper (Renderer) --type=renderer',
  '  103   102   5000 a child of the renderer',
  '  200     1  99999 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/other',
  '  201   200  88888 Chrome Helper (Renderer) --type=renderer',
  '  300     1   7000 node something',
].join('\n');

describe('parsePs', () => {
  it('sums the browser process and every descendant of the profile, and nothing else', () => {
    expect(parsePs(PS, PROFILE)).toEqual({
      bytes: (50000 + 30000 + 40000 + 5000) * 1024,
      processes: 4,
    });
  });
  it('is zero for a profile no process was started with', () => {
    expect(parsePs(PS, '/tmp/nope')).toEqual({ bytes: 0, processes: 0 });
  });
  it('ignores lines it cannot parse', () => {
    expect(parsePs('garbage\n\n', PROFILE)).toEqual({ bytes: 0, processes: 0 });
  });
});

describe('sampleOnce (Sprint 6, D1-04 f: the instantaneous tree figure behind the measured unload drop)', () => {
  it('reads the process table once and returns the profile tree, zero for a profile nobody started with', async () => {
    let reads = 0;
    const table = async () => {
      reads++;
      return PS;
    };
    expect(await sampleOnce(PROFILE, table)).toEqual({
      bytes: (50000 + 30000 + 40000 + 5000) * 1024,
      processes: 4,
    });
    expect(await sampleOnce('/tmp/chrome-profile-that-no-process-has-0000', table)).toEqual({
      bytes: 0,
      processes: 0,
    });
    expect(reads).toBe(2); // one read per reading, never a cached table
  });
});
