// Owner decision, 20 Nov 2026: every benchmark is published in the repo it measures. The raw results are the JSON
// files in docs/benchmarks/, the README tables are generated from them (scripts/bench-readme.mjs), and a figure
// quoted without a raw file is not done. This file runs the check as it is in the repository (so `npm run ci` fails on
// a README figure that no committed file backs) and proves, on mutated copies, that each part of the check can fail.
// Red run: this file against b3bc391 plus only scripts/bench-readme.mjs fails at collection (docs/benchmarks does not exist).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BENCH_DIR,
  CHECKED,
  LAPTOP_8GB,
  MAX_FILE_BYTES,
  applyTables,
  checkAll,
  figureTokens,
  loadBenchmarks,
  tables,
  unsupportedFigures,
  validateAll,
  validateEnvelope,
  type Bench,
  type Benches,
} from '../scripts/bench-readme.mjs';
import { repoDir } from './helpers';

const read = (rel: string) => readFileSync(resolve(repoDir, rel), 'utf8').replace(/\r\n?/g, '\n');
const benches = (): Benches => loadBenchmarks();
const clone = (b: Benches): Benches => structuredClone(b);
const index = () => read('docs/benchmarks/README.md');

const EXPECTED = [
  'asset-download-700mb',
  'asset-quota-eviction-700mb',
  'asset-resume-700mb',
  'demo-build-size',
  'devtools-load-phases',
  'idb-usage-reporting',
  'model-answer-smollm2',
  'model-hindi-smoke-qwen3-1.7b',
  'model-rss-smollm2',
  'opfs-snapshot-readback',
  'pack-size',
  'stop-button',
  'unload-memory',
  'worker-abort-long-task',
];

describe('docs/benchmarks: one raw file per benchmark', () => {
  it('holds the benchmark files the repository quotes, an index, and nothing over 5 MB', () => {
    const names = readdirSync(BENCH_DIR).sort();
    expect(names).toContain('README.md');
    expect(Object.keys(benches()).sort()).toEqual(EXPECTED);
    for (const n of names)
      expect(statSync(resolve(BENCH_DIR, n)).size, n).toBeLessThan(MAX_FILE_BYTES);
  });

  it('every file is well formed: date, commit, machine label, method, commands, the 8 GB phrase, raw output', () => {
    expect(validateAll(benches(), index())).toEqual([]);
    for (const b of Object.values(benches())) {
      expect(b.laptop8gb, b.id).toBe('not measured on 8 GB');
      expect(b.machine.label, b.id).toBe('Apple M5 Pro 48 GB');
      expect(b.files.length, b.id).toBeGreaterThan(0);
    }
  });

  it('the index carries the standing line and says how to reproduce every file', () => {
    const text = index().replace(/\s+/g, ' ');
    expect(text).toContain('Nothing here is measured on an 8 GB laptop unless a file says so');
    expect(text).toContain(
      'A figure quoted anywhere without a row in one of these files is not done',
    );
    for (const [id, b] of Object.entries(benches())) {
      expect(text, id).toContain(`${id}.json`);
      expect(b.measuredAt, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(text, `${id}: its date is in the index`).toContain(b.measuredAt);
      // a command of the file appears in the index row, or the row says the harness is not in the repository
      const row = index()
        .split('\n')
        .find((l) => l.includes(`[${id}.json]`))!;
      expect(row, id).toBeDefined();
      const named = b.commands.some((c) => row.includes(c.split('  (')[0]!));
      expect(named || /not in this repository/.test(row), id).toBe(true);
    }
  });

  it('runs before the first commit say so: recorded false, a base commit that exists in the history or null', () => {
    for (const b of Object.values(benches())) {
      if (b.commit.recorded) continue;
      expect(b.commit.note, b.id).toMatch(/No commit hash was recorded/);
      if (b.commit.base !== null) expect(b.commit.base, b.id).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it('every docs/benchmarks file a document cites exists', () => {
    const docs = [
      'README.md',
      'CHANGELOG.md',
      'demo/models.html',
      'demo/index.html',
      'test/browser/README.md',
    ].concat(
      readdirSync(resolve(repoDir, 'docs'))
        .filter((n) => n.endsWith('.md'))
        .map((n) => `docs/${n}`),
    );
    let cited = 0;
    for (const f of docs) {
      for (const m of read(f).matchAll(/docs\/benchmarks\/([\w.-]+\.(?:json|md))/g)) {
        cited++;
        expect(existsSync(resolve(BENCH_DIR, m[1]!)), `${f} cites docs/benchmarks/${m[1]}`).toBe(
          true,
        );
      }
      // docs/*.md link to benchmarks/<file>
      if (f.startsWith('docs/'))
        for (const m of read(f).matchAll(/\]\(benchmarks\/([\w.-]+\.(?:json|md))\)/g)) {
          cited++;
          expect(existsSync(resolve(BENCH_DIR, m[1]!)), `${f} links benchmarks/${m[1]}`).toBe(true);
        }
    }
    expect(cited).toBeGreaterThan(10);
  });
});

describe('the README is generated from the files and checked against them', () => {
  it('the whole check passes on the repository as it is', () => {
    expect(checkAll()).toEqual([]);
  });

  it('the two README tables are exactly what the files produce', () => {
    const readme = read('README.md');
    expect(applyTables(readme, tables(benches()))).toBe(readme);
    const start = readme.indexOf('\n## Benchmarks');
    const section = readme.slice(start, readme.indexOf('\n## ', start + 5));
    expect(section).toContain('](docs/benchmarks/README.md)');
    expect((section.match(/<!-- bench:start table-[ab] -->/g) ?? []).length).toBe(2);
  });

  it('every figure of the 700 MB and model rows is the value in its raw file', () => {
    const b = benches();
    const dl = b['asset-download-700mb']!.files.find(
      (f) => f.name === 'run1/download-big-opfs.json',
    )!.json as {
      wallMs: number;
      mbPerSecond: number;
    };
    const model = b['model-answer-smollm2']!.files[0]!.json as {
      webgpu: { loadMs: number };
      wasm: { loadMs: number };
    };
    const readme = read('README.md');
    expect(readme).toContain(`${dl.wallMs} ms, ${dl.mbPerSecond} MB/s`);
    expect(readme).toContain(`load ${model.webgpu.loadMs} ms including the verified download`);
    expect(readme).toContain(`load ${model.wasm.loadMs} ms (same download)`);
  });

  it('a README table figure edited by hand fails the check (4060 ms to 4061 ms)', () => {
    const readme = read('README.md');
    expect(readme).toContain('4060 ms');
    const edited = readme.replace('4060 ms', '4061 ms');
    expect(applyTables(edited, tables(benches()))).not.toBe(edited);
  });

  it('a raw file that contradicts the sentence it feeds stops the generator', () => {
    const noRange = clone(benches());
    const resume = noRange['asset-resume-700mb']!.files.find(
      (f) => f.name === 'run1/resume-big-opfs.json',
    )!.json as { request: { range: string } };
    resume.request.range = 'bytes=0-';
    expect(() => tables(noRange)).toThrow(/Range does not start at the bytes written/);

    const wrongEvict = clone(benches());
    const quota = wrongEvict['asset-quota-eviction-700mb']!.files.find(
      (f) => f.name === 'opfs-run1/t1-retest1-quota-opfs.json',
    )!.json as { evicts: { entryId: string }[] };
    quota.evicts[0]!.entryId = 'a';
    expect(() => tables(wrongEvict)).toThrow(/did not evict exactly b/);

    const wrongDigest = clone(benches());
    const d = wrongDigest['asset-download-700mb']!.files.find(
      (f) => f.name === 'run1/download-big-opfs.json',
    )!.json as { sha256: string };
    d.sha256 = '0'.repeat(64);
    expect(() => tables(wrongDigest)).toThrow(/differs from the independent digest/);
  });

  it('a missing benchmark file stops the generator', () => {
    const b = clone(benches());
    delete b['stop-button'];
    // stop-button feeds a prose figure, not a table row: removing it makes the prose figure unsupported instead
    expect(unsupportedFigures('The Stop button call took 289 ms.', b)).toEqual(['289 ms']);
    const c = clone(benches());
    delete c['model-answer-smollm2'];
    expect(() => tables(c)).toThrow(/model-answer-smollm2.json is missing/);
  });
});

describe('a timing figure in the prose needs raw data, an allowed reason, or "raw data not kept"', () => {
  const b = benches();

  it('finds timing and throughput figures, and MiB/GiB with a decimal, but not whole sizes or ranges', () => {
    const toks = figureTokens(
      'took 4060 ms, 10.9 tokens/s, 12 MB/s, 2.4 s, 726.7 MiB, 5 MiB, 0.35-0.42 GiB, 404s, 160 MiB/s',
    ).map((t) => t.text);
    expect(toks).toEqual(['4060 ms', '10.9 tokens/s', '12 MB/s', '2.4 s', '726.7 MiB']);
  });

  it('a backed figure passes, an unbacked one fails, and the unit has to match', () => {
    expect(unsupportedFigures('The download took 4060 ms and ran at 180.8 MB/s.', b)).toEqual([]);
    expect(unsupportedFigures('The download took 4071 ms.', b)).toEqual(['4071 ms']);
    // 180.8 is MB/s in the file: as tokens/s it backs nothing
    expect(unsupportedFigures('It ran at 180.8 tokens/s.', b)).toEqual(['180.8 tokens/s']);
  });

  it('an unrelated small number in a raw file does not back a figure (48.1 is a mono timestamp, 30 and 2.4 are nothing)', () => {
    expect(unsupportedFigures('An earlier run measured 48.1 tokens/s.', b)).toEqual([
      '48.1 tokens/s',
    ]);
    expect(unsupportedFigures('64 keys are checked in about 30 ms.', b)).toEqual(['30 ms']);
    expect(unsupportedFigures('The next load takes about 2.4 s.', b)).toEqual(['2.4 s']);
  });

  it('a figure in a sentence that says "raw data not kept" passes, the same figure further away does not', () => {
    expect(
      unsupportedFigures('An earlier run measured 48.1 tokens/s (raw data not kept).', b),
    ).toEqual([]);
    const far = `An earlier run measured 48.1 tokens/s. ${'x'.repeat(200)} (raw data not kept).`;
    expect(unsupportedFigures(far, b)).toEqual(['48.1 tokens/s']);
    // another paragraph does not count either
    expect(unsupportedFigures('It took 48.1 tokens/s.\n\n(raw data not kept)', b)).toEqual([
      '48.1 tokens/s',
    ]);
  });

  it('an allowed constant passes only where it is listed with its reason', () => {
    expect(unsupportedFigures('The worker gets 250 ms.', b)).toEqual(['250 ms']);
    expect(
      unsupportedFigures('The worker gets 250 ms.', b, { allow: CHECKED['README.md']!.allow }),
    ).toEqual([]);
    for (const [file, { allow }] of Object.entries(CHECKED))
      for (const [fig, why] of Object.entries(allow))
        expect(why.length, `${file}: ${fig}`).toBeGreaterThan(10);
  });

  it('fenced code and the generated tables are not read as prose, a figure typed under the tables is', () => {
    const readme = read('README.md');
    expect(unsupportedFigures(readme, b, CHECKED['README.md']!)).toEqual([]);
    const typed = readme.replace(
      '## Limitations\n',
      '## Limitations\n\nThe worker answered in 7777 ms.\n',
    );
    expect(unsupportedFigures(typed, b, CHECKED['README.md']!)).toEqual(['7777 ms']);
    expect(unsupportedFigures('```sh\nsleep 9999 ms\n```', b)).toEqual([]);
  });

  it('every checked document passes today, and each is in the list the check reads', () => {
    for (const [file, { profile, allow }] of Object.entries(CHECKED)) {
      expect(existsSync(resolve(repoDir, file)), file).toBe(true);
      expect(unsupportedFigures(read(file), b, { profile, allow }), file).toEqual([]);
    }
    expect(Object.keys(CHECKED)).toEqual(
      expect.arrayContaining([
        'README.md',
        'docs/memory-options.md',
        'docs/engine-load-retry.md',
        'CHANGELOG.md',
        'demo/models.html',
      ]),
    );
  });

  it('the figures marked "raw data not kept" are exactly the ones with no raw file, and each is still marked', () => {
    const marked = ['README.md', 'docs/memory-options.md', 'CHANGELOG.md'].map((f) =>
      read(f).replace(/\s+/g, ' '),
    );
    expect(marked[0]).toContain(
      'measured 48.1 tokens/s in an earlier run on the same machine; raw data not kept',
    );
    expect(marked[0]).toContain('0 bytes downloaded; raw data not kept');
    expect(marked[0]).toContain('a dockit measurement, raw data not kept');
    expect(marked[1]).toContain('a dockit measurement, raw data not kept');
    expect(marked[2]).toContain('about 30 ms (raw data not kept)');
    const idx = index().replace(/\s+/g, ' ');
    for (const s of ['48.1 tokens/s', 'about 2.4 s', 'about 1.8 s', 'about 30 ms'])
      expect(idx, s).toContain(s);
  });
});

describe('a benchmark file that is not well formed fails the check', () => {
  const good = (): Bench => structuredClone(benches()['stop-button']!);
  const problems = (mutate: (b: Record<string, unknown>) => void) => {
    const b = good() as unknown as Record<string, unknown>;
    mutate(b);
    return validateEnvelope(b, 'stop-button.json');
  };

  it('the unmodified file is clean', () => {
    expect(validateEnvelope(good(), 'stop-button.json')).toEqual([]);
  });

  it('refuses a missing date, commit note, method, command or raw output', () => {
    expect(problems((b) => (b['measuredAt'] = 'yesterday')).join()).toMatch(/measuredAt/);
    expect(problems((b) => delete b['commit']).join()).toMatch(/commit missing/);
    expect(problems((b) => ((b['commit'] as { note: string }).note = '')).join()).toMatch(
      /commit.note/,
    );
    expect(problems((b) => (b['method'] = 'short')).join()).toMatch(/method/);
    expect(problems((b) => (b['commands'] = [])).join()).toMatch(/commands/);
    expect(problems((b) => (b['files'] = [])).join()).toMatch(/files missing/);
    expect(problems((b) => delete (b['files'] as { sha256?: string }[])[0]!.sha256).join()).toMatch(
      /sha256/,
    );
  });

  it('refuses a laptop column that claims a measurement, and a machine label that is not model and RAM', () => {
    expect(problems((b) => (b['laptop8gb'] = '812 ms')).join()).toMatch(/laptop8gb/);
    expect(
      problems(
        (b) => ((b['machine'] as { label: string }).label = 'MacBookPro18,2 of someone'),
      ).join(),
    ).toMatch(/machine.label/);
    expect(
      problems(
        (b) => ((b['machine'] as { label: string }).label = 'Apple M5 Pro 48 GB, host mac-01'),
      ).join(),
    ).toMatch(/machine.label/);
  });

  it('refuses a personal or employer string anywhere in the file, a wrong id and a file over 5 MB', () => {
    expect(problems((b) => (b['method'] = `${'a'.repeat(40)} /Users/someone/work`)).join()).toMatch(
      /no personal or employer data/,
    );
    expect(problems((b) => (b['title'] = 'a title for the Tata Projects laptop')).join()).toMatch(
      /no personal or employer data/,
    );
    expect(
      problems(
        (b) =>
          (b['method'] = `${'a'.repeat(40)} chrome-extension://abcdefghijklmnopabcdefghijklmnop`),
      ).join(),
    ).toMatch(/no personal or employer data/);
    expect(
      problems(
        (b) => (b['method'] = `${'a'.repeat(40)} extension abcdefghijklmnopabcdefghijklmnop`),
      ).join(),
    ).toMatch(/no personal or employer data/);
    expect(
      problems(
        (b) => (b['method'] = `${'a'.repeat(40)} chrome-extension://<redacted-extension-id>`),
      ).join(),
    ).toBe('');
    expect(problems((b) => (b['id'] = 'other')).join()).toMatch(/id must equal/);
    const big = good() as unknown as Record<string, unknown>;
    Object.defineProperty(big, '__bytes', { value: MAX_FILE_BYTES + 1 });
    expect(validateEnvelope(big, 'stop-button.json').join()).toMatch(/over 5 MB/);
  });

  it('a file the index does not list, and an empty folder, fail', () => {
    expect(validateAll(benches(), '# Benchmarks\n').length).toBeGreaterThan(5);
    expect(validateAll({}, '')).toEqual(['docs/benchmarks/ holds no benchmark file']);
  });

  it('the 8 GB phrase is the one the README tables use', () => {
    expect(LAPTOP_8GB).toBe('not measured on 8 GB');
  });
});

describe('the demo page links to the files (CSP and the no-external-URL rule of models.html unchanged)', () => {
  it('index.html has a Benchmarks box with a plain link to the GitHub folder', () => {
    const html = read('demo/index.html');
    expect(html).toContain('id="benchmarks"');
    expect(html.replace(/\s+/g, ' ')).toContain(
      'href="https://github.com/AirplaneMode-Labs/runtime/tree/main/docs/benchmarks"',
    );
  });

  it('models.html links to that box with a relative link only', () => {
    const html = read('demo/models.html');
    expect(html).toContain('href="./index.html#benchmarks"');
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
  });

  it('no demo page cites a workspace evidence path for a figure any more', () => {
    for (const f of ['demo/index.html', 'demo/models.html'])
      expect(read(f), f).not.toMatch(
        /evidence\/sprint-\d+\/\S*(?:hindi-smoke|worker|stop-run|model-run)/,
      );
  });
});
