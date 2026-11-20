#!/usr/bin/env node
// Owner decision, 20 Nov 2026: every benchmark is published in the repo it measures. The raw results are the
// JSON files in docs/benchmarks/ (one per benchmark: date, commit, machine, method, commands and the raw output
// copied unchanged), and no figure in a README table is typed by hand.
//
//   node scripts/bench-readme.mjs           rewrite the two Benchmarks tables of README.md from the files
//   node scripts/bench-readme.mjs --check   exit 1 unless the README holds exactly those tables, every file is
//                                           well formed, and no figure in the checked prose has no raw data
//
// The check has three parts (all in this file so that test/bench-readme.test.ts can run and mutate them):
//   1. validateEnvelope: the shape of every file in docs/benchmarks/ (date, commit, machine label, method,
//      commands, the 8 GB phrase, no file over 5 MB, no personal or employer string);
//   2. tables: the README tables between <!-- bench:start --> and <!-- bench:end --> markers are built from the
//      raw output inside those files, and the build throws when a raw file contradicts the sentence it feeds
//      (a resume that was not one Range request, an eviction of anything but b, a digest that differs);
//   3. unsupportedFigures: every timing or throughput figure in the prose of the checked documents (and every
//      MiB or GiB figure with a decimal) must occur in a committed raw file, be on the short allow-list below
//      with its reason, or sit in a sentence that says "raw data not kept".
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BENCH_DIR = join(root, 'docs', 'benchmarks');
export const SCHEMA = 'airplanemode.runtime.benchmark/1';
export const LAPTOP_8GB = 'not measured on 8 GB';
export const NOT_KEPT = 'raw data not kept';
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// ---- loading and validating the files ------------------------------------------------------------------------

/** Every docs/benchmarks/*.json parsed, keyed by id. Throws on a file that is not JSON. */
export function loadBenchmarks(dir = BENCH_DIR) {
  const out = {};
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`${name}: not JSON (${e.message})`);
    }
    Object.defineProperty(json, '__file', { value: name, enumerable: false });
    Object.defineProperty(json, '__bytes', { value: statSync(path).size, enumerable: false });
    out[basename(name, '.json')] = json;
  }
  return out;
}

// A Chrome unpacked-extension id (32 letters a-p) is derived from the local install path, which holds the user
// name, so it counts as personal: copies say <redacted-extension-id> instead.
const PRIVATE =
  /\/Users\/|\/home\/|[A-Za-z]:\\Users|tusharpatekar|jtushar|@gmail\.|tataprojects|tata projects|nirmaan|scantix|chrome-extension:\/\/(?!<redacted)|(?<![a-z0-9])[a-p]{32}(?![a-z0-9])/i;
const MACHINE_LABEL = /^[A-Za-z][A-Za-z0-9 .+-]{2,60} \d{1,4} GB$/;
const HEX = /^[0-9a-f]+$/;

/** The problems of one parsed file (an empty list when it is well formed). */
export function validateEnvelope(env, fileName = env?.__file ?? '?') {
  const p = [];
  const bad = (m) => p.push(`${fileName}: ${m}`);
  if (typeof env !== 'object' || env === null || Array.isArray(env))
    return [`${fileName}: not an object`];
  if (env.schema !== SCHEMA) bad(`schema must be ${SCHEMA}`);
  if (env.id !== basename(fileName, '.json')) bad('id must equal the file name');
  if (typeof env.title !== 'string' || env.title.length < 10) bad('title missing');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(env.measuredAt ?? '')) bad('measuredAt must be YYYY-MM-DD');
  const c = env.commit;
  if (typeof c !== 'object' || c === null) bad('commit missing');
  else {
    if (typeof c.recorded !== 'boolean') bad('commit.recorded must be a boolean');
    if (typeof c.note !== 'string' || c.note.length < 10)
      bad('commit.note must say how the commit relates to the run');
    if (c.recorded === true && !(HEX.test(c.sha ?? '') && c.sha.length >= 7))
      bad('commit.sha must be a hex hash when recorded');
    if (c.recorded === false && c.base !== null && !(HEX.test(c.base ?? '') && c.base.length >= 7))
      bad('commit.base must be null or a hex hash');
  }
  const m = env.machine;
  if (typeof m !== 'object' || m === null) bad('machine missing');
  else if (!MACHINE_LABEL.test(m.label ?? ''))
    bad('machine.label must be "<model> <N> GB" (model and RAM only)');
  if (env.laptop8gb !== LAPTOP_8GB) bad(`laptop8gb must read "${LAPTOP_8GB}"`);
  if (typeof env.method !== 'string' || env.method.length < 40) bad('method missing');
  if (
    !Array.isArray(env.commands) ||
    env.commands.length === 0 ||
    env.commands.some((x) => typeof x !== 'string' || !x)
  )
    bad('commands must be a non-empty list of strings');
  if (!Array.isArray(env.files) || env.files.length === 0) bad('files missing');
  else {
    const names = new Set();
    for (const f of env.files) {
      if (typeof f.name !== 'string' || !f.name) bad('a file entry has no name');
      else if (names.has(f.name)) bad(`duplicate file name ${f.name}`);
      else names.add(f.name);
      if (typeof f.source !== 'string' || !f.source) bad(`${f.name}: source missing`);
      if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? ''))
        bad(`${f.name}: sha256 of the original bytes missing`);
      if ('json' in f === 'text' in f) bad(`${f.name}: exactly one of json and text`);
    }
  }
  if (env.__bytes !== undefined && env.__bytes > MAX_FILE_BYTES) bad('file is over 5 MB');
  const hit = PRIVATE.exec(JSON.stringify(env));
  if (hit) bad(`contains "${hit[0]}": no personal or employer data in a benchmark file`);
  return p;
}

/** The problems of the whole folder: every file, and that docs/benchmarks/README.md indexes every file. */
export function validateAll(benches, indexText) {
  const problems = Object.values(benches).flatMap((b) => validateEnvelope(b));
  if (Object.keys(benches).length === 0) problems.push('docs/benchmarks/ holds no benchmark file');
  if (indexText !== undefined)
    for (const id of Object.keys(benches))
      if (!indexText.includes(`${id}.json`))
        problems.push(`docs/benchmarks/README.md does not index ${id}.json`);
  return problems;
}

/** One embedded file of an envelope, by name. */
export function part(bench, name) {
  const f = bench?.files?.find((x) => x.name === name);
  if (!f) throw new Error(`${bench?.id ?? '?'}: no embedded file ${name}`);
  return f.json ?? f.text;
}

// ---- the README tables -----------------------------------------------------------------------------------------

const thousands = (n) => n.toLocaleString('en-US');
const one = (x) => String(Number(x.toFixed(1)));
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

function digestOf(b, run) {
  const text = part(b, `${run}/asset-digest-big.txt`);
  const first = text.split('\n')[0].trim();
  const m = /^[0-9a-f]{64}$/.exec(first);
  assert(m, `${b.id}: ${run}/asset-digest-big.txt does not start with a sha256`);
  return first;
}

function downloadRow(b, store, label, tail) {
  const d = part(b, `run1/download-big-${store}.json`);
  assert(d.bytes === 734003200, `${b.id}: ${store} did not download 734003200 B`);
  assert(
    d.sha256 === digestOf(b, 'run1'),
    `${b.id}: ${store} sha256 differs from the independent digest`,
  );
  const mb = (d.peakJsHeapBytes / 1e6).toFixed(2);
  return [label, `${d.wallMs} ms, ${d.mbPerSecond} MB/s, peak JS heap ${mb} MB; ${tail}`];
}

function resumeRow(b, store, label, resultFor) {
  const r = part(b, `run1/resume-big-${store}.json`);
  assert(r.resumed === true, `${b.id}: ${store} did not resume`);
  assert(
    r.request.method === 'GET' && r.request.status === 206,
    `${b.id}: ${store} resume was not one 206 GET`,
  );
  assert(
    r.request.range === `bytes=${r.bytesWrittenAtReload}-`,
    `${b.id}: ${store} Range does not start at the bytes written`,
  );
  assert(/^"[^"]+"$/.test(r.request.ifRange), `${b.id}: ${store} If-Range is not a strong ETag`);
  assert(
    r.request.bytesSent === r.size - r.bytesWrittenAtReload,
    `${b.id}: ${store} bytes sent is not the remainder`,
  );
  const pct = ((r.bytesWrittenAtReload / r.size) * 100).toFixed(1);
  return [
    `700 MB, ${label}: reload at ${pct} % (${r.bytesWrittenAtReload} B written) then resume`,
    resultFor(r),
  ];
}

function quotaAsserts(b, q, who) {
  assert(
    q.evicts.length === 1 && q.evicts[0].entryId === 'b' && q.evicts[0].reason === 'quota',
    `${b.id}: ${who} did not evict exactly b for quota`,
  );
  assert(
    q.rows.map((r) => r.entryId).join() === 'a,c' && q.rows.every((r) => r.verifiedAt),
    `${b.id}: ${who} index is not exactly a and c, verified`,
  );
  assert(q.partLeftovers.length === 0, `${b.id}: ${who} left a .part`);
  assert(q.cResult.ok === true, `${b.id}: ${who} c did not complete`);
}

function modelLeg(b, key, label, tail) {
  const leg = part(b, 'model-run.json')[key];
  assert(leg.outputText && /paris/i.test(leg.outputText), `${b.id}: ${key} did not answer Paris`);
  assert(leg.verifyOk.length === 7, `${b.id}: ${key} did not verify seven entries`);
  return [label, tail(leg)];
}

function longestRow(b) {
  const w = part(b, 'worker-run.json');
  assert(
    w.longTaskDuringAnswer.all.length === 0,
    'worker-abort-long-task: a long task was reported',
  );
  return [
    'Longest main-thread long task during a 32-token WebAssembly answer with the engine in the worker (worker-abort-long-task.json)',
    `none over 50 ms reported (longest ${w.longTaskDuringAnswer.longestMs} ms); the Sprint 2 main-thread adapter froze the tab for the whole answer`,
  ];
}

function abortRow(b) {
  const w = part(b, 'worker-run.json');
  assert(
    w.abortRuns.length === 5 &&
      w.abortRuns.every((r) => r.finishReason === 'abort' && r.refcounts.every((c) => c === 0)),
    'worker-abort-long-task: abort runs are not 5 clean aborts',
  );
  const ms = w.abortRuns.map((r) => one(r.latencyMs));
  return [
    'Abort from a timer on the WebAssembly rung, 5 runs (worker-abort-long-task.json)',
    `${ms.slice(0, 4).join(', ')} and ${ms[4]} ms to \`finishReason: 'abort'\` (the 250 ms grace, then the worker is terminated); the asset holds were released in all 5`,
  ];
}

function devtoolsRows(b) {
  const d = part(b, 'devtools-figures.json');
  const ph = d.pagePhases;
  const bytes = /Acquire[^\n]*\t([\d,]+) B/.exec(d.panelText);
  assert(bytes, 'devtools-load-phases: no acquire byte count in the panel text');
  const heap = d.panelMemory.filter((m) => m.api === 'performance.memory').map((m) => m.used);
  assert(heap.length === 3, 'devtools-load-phases: expected three page heap samples');
  return [
    [
      'Load of SmolLM2-135M (q4) on forced WebAssembly, engine in a worker, phases shown by the DevTools panel (devtools-load-phases.json)',
      `acquire ${one(ph.acquire)} ms (${bytes[1]} B over loopback), verify ${one(ph.verify)} ms, hand-off ${one(ph.handoff)} ms, session ${one(ph.session)} ms, first token ${one(ph.first_token)} ms, under one load id`,
    ],
    [
      'Page JS heap at before-load, after-session and after-first-token, same load (`performance.memory`, coarse; worker figures are null)',
      heap.join(', '),
    ],
  ];
}

function packRow(b) {
  const p = part(b, 'npm-pack.json')[0];
  return [
    `Packed tarball \`${p.filename}\` (pack-size.json)`,
    `${packFigure(b)}, installed offline into a fresh empty directory`,
  ];
}

/** "about N KiB in F files (U B unpacked)": the sentence pack-figure.test.ts compares with a fresh pack. */
export function packFigure(b) {
  const p = part(b, 'npm-pack.json')[0];
  return `about ${Math.round(p.size / 1024)} KiB in ${p.files.length} files (${thousands(p.unpackedSize)} B unpacked)`;
}

function buildSizeRow(b) {
  const t = part(b, 'dist-size.txt');
  const mib = (re) => {
    const m = re.exec(t);
    assert(m, `demo-build-size: ${re} not found in dist-size.txt`);
    return m[1];
  };
  return [
    '`DEMO_MODELS=1` demo build (demo-build-size.json)',
    `${mib(/^total ([\d.]+) MiB/m)} MiB in total: ${mib(/([\d.]+) MiB\s+demo\/dist\/models\/smollm2-135m-instruct\n/)} MiB of model weights, ${mib(/([\d.]+) MiB\s+demo\/dist\/models\/ort\n/)} MiB of ONNX Runtime wasm, ${mib(/([\d.]+) MiB\s+demo\/dist\/fixture\n/)} MiB of synthetic fixture streams`,
  ];
}

/** The two tables, as [scenario, result] rows. Throws when the raw data contradicts a sentence. */
export function tableRows(benches) {
  const need = (id) => {
    const b = benches[id];
    assert(b, `docs/benchmarks/${id}.json is missing`);
    return b;
  };
  const dl = need('asset-download-700mb');
  const rs = need('asset-resume-700mb');
  const qt = need('asset-quota-eviction-700mb');
  const ma = need('model-answer-smollm2');
  const hs = need('model-hindi-smoke-qwen3-1.7b');
  const rss = need('model-rss-smollm2');

  const opfsQ = part(qt, 'opfs-run1/t1-retest1-quota-opfs.json');
  const idbQ = part(qt, 'indexeddb/t1-retest2-quota-indexeddb.json');
  quotaAsserts(qt, opfsQ, 'opfs');
  quotaAsserts(qt, idbQ, 'indexeddb');
  assert(
    idbQ.quotaEvents[0].usageSource === 'accounted',
    `${qt.id}: the IndexedDB quota event is not usageSource accounted`,
  );
  const qEvent = idbQ.quotaEvents[0];
  const acc = idbQ.accounting;

  const hindi = part(hs, 'hindi-smoke.json');
  const reps = (kind) =>
    rss.files.filter((f) => f.name.endsWith(`-${kind}.json`)).map((f) => f.json.peakRssKiB);
  const gib = (kib) => kib / 1048576;
  const wg = reps('webgpu');
  const wa = reps('wasm');
  assert(wg.length === 3 && wa.length === 3, `${rss.id}: expected three repetitions per path`);
  const lo = (a, k) => Math.min(...a.map((r) => r[k]));
  const hi = (a, k) => Math.max(...a.map((r) => r[k]));
  const rssText = `SmolLM2-135M q4, same prompt: about ${one(gib(hi(wg, 'renderer')))} GiB on the WebGPU path and about ${one(gib(hi(wa, 'renderer')))} GiB on the WebAssembly path (renderer process); GPU process ${gib(lo(wg, 'gpu')).toFixed(2)}-${gib(hi(wg, 'gpu')).toFixed(2)} GiB on the WebGPU path. Includes WebAssembly memory, not a GPU-memory figure; Apple-silicon placeholder (\`model-rss-smollm2.json\`: \`rep1-webgpu.json\` to \`rep3-webgpu.json\`, \`rep1-wasm.json\`)`;

  const a = [
    downloadRow(
      dl,
      'opfs',
      '700 MB (734003200 B) full download and SHA-256 verify, OPFS',
      'sha256 equals `node test/tools/asset-digest.mjs big 734003200`',
    ),
    downloadRow(
      dl,
      'indexeddb',
      '700 MB full download and SHA-256 verify, IndexedDB',
      'same sha256',
    ),
    resumeRow(
      rs,
      'opfs',
      'OPFS',
      (r) =>
        `exactly one \`Range: ${r.request.range}\` request with \`If-Range\` = strong ETag, 206, ${r.request.bytesSent} B sent; wall time of the resume leg not measured`,
    ),
    resumeRow(
      rs,
      'indexeddb',
      'IndexedDB',
      (r) =>
        `exactly one \`Range: ${r.request.range}\` request, 206, ${r.request.bytesSent} B sent; resume leg ${r.resumeLegWallMs} ms including the reload`,
    ),
    [
      '`detectCapabilities()` wall time in Chrome',
      'under 2 s (test/browser/capability.spec.ts passes; exact figure not measured)',
    ],
    [
      'Quota eviction at a 1.5 GiB origin quota (CDP `Storage.overrideQuotaForOrigin`), OPFS',
      `${opfsQ.wallMs} ms wall for 700 MB (a) + 400 MB (b), \`getBlob(a)\`, then 500 MB (c): exactly one \`asset.evict\` for b with reason \`quota\`, a and c verified, index exactly a and c, no \`.part\` left (asset-quota-eviction-700mb.json)`,
    ],
    [
      'Quota eviction at a 1.5 GiB `quotaBytes`, IndexedDB',
      `${idbQ.wallMs} ms wall for 700 MB (a) + 400 MB (b), \`getBlob(a)\`, then 500 MB (c): exactly one \`asset.evict\` for b with reason \`quota\`, \`asset.quota\` usage ${qEvent.usage} B with \`usageSource\` \`${qEvent.usageSource}\` (estimate ${acc.estimateUsageAfterAB} B, ratio ${acc.ratioAfterAB}), a and c verified, ${idbQ.storedBytesAfter} B left stored (asset-quota-eviction-700mb.json); Apple-silicon placeholder`,
    ],
    modelLeg(
      ma,
      'webgpu',
      'Sprint 2 done-when: SmolLM2-135M-Instruct (q4), prompt "What is the capital of France? Answer in one word.", maxTokens 16, temperature 0, **WebGPU** path, Chrome (channel "chrome")',
      (l) =>
        `load ${l.loadMs} ms including the verified download of ${thousands(l.bytesDownloaded)} B (${l.verifyOk.length} signed entries) over loopback; prefill ${l.prefillMs} ms, decode ${l.decodeMs} ms, ${one(l.tokensPerSecond)} tokens/s; ${l.usage.completionTokens} tokens generated; peak JS heap ${thousands(l.peakJsHeapUsedSizeBytes)} B; output "${l.outputText}" (\`model-answer-smollm2.json\`, key \`webgpu\`); one run, Apple-silicon placeholder`,
    ),
    modelLeg(
      ma,
      'wasm',
      "the same, forced **WebAssembly** path (`forceRung: 'wasm'`, executionProviders `['wasm']`)",
      (l) =>
        `load ${l.loadMs} ms (same download); prefill ${l.prefillMs} ms, decode ${l.decodeMs} ms, ${one(l.tokensPerSecond)} tokens/s; peak JS heap ${thousands(l.peakJsHeapUsedSizeBytes)} B; output "${l.outputText}" (\`model-answer-smollm2.json\`, key \`wasm\`); one thread, no COOP/COEP; Apple-silicon placeholder`,
    ),
    [
      'Local Hindi smoke run: Qwen3-1.7B q4f16 on WebGPU, five synthetic Hindi prompts, up to 128 new tokens, temperature 0, thinking off (`model-hindi-smoke-qwen3-1.7b.json`)',
      `load ${hindi.loadMs} ms including the verified download of ${thousands(hindi.bytesDownloaded)} B; mean ${one(hindi.tokensPerSecondMean)} tokens/s; peak JS heap ${thousands(hindi.peakJsHeapUsedSizeBytes)} B; outputs recorded verbatim and **unscored**; only with \`graphOptimizationLevel: 'disabled'\` (the default level fails with \`std::bad_alloc\`); Apple-silicon placeholder`,
    ],
    ['renderer process RSS peak (proxy, placeholder)', rssText],
  ];
  assert(
    hindi.prompts.length === 5 && hindi.maxTokens === 128,
    `${hs.id}: not five prompts at 128 tokens`,
  );

  const b = [
    ...devtoolsRows(need('devtools-load-phases')),
    longestRow(need('worker-abort-long-task')),
    abortRow(need('worker-abort-long-task')),
    [
      'A WebGPU rung that fails after its worker started (malformed ONNX), then a WebAssembly answer in the same page',
      'answered without a reload, two worker lifecycles, no reload sentence',
    ],
    packRow(need('pack-size')),
    buildSizeRow(need('demo-build-size')),
  ];
  return { a, b };
}

/** A prettier-compatible padded markdown table (printWidth does not apply: proseWrap is preserve). */
export function mdTable(header, rows) {
  const all = [header, ...rows];
  const w = header.map((_, i) => Math.max(3, ...all.map((r) => r[i].length)));
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(w[i])).join(' | ')} |`;
  return [line(header), `| ${w.map((n) => '-'.repeat(n)).join(' | ')} |`, ...rows.map(line)].join(
    '\n',
  );
}

export function tables(benches) {
  const { a, b } = tableRows(benches);
  const na = '8 GB laptop';
  return {
    'table-a': mdTable(
      ['Scenario', 'Result', na],
      a.map((r) => [...r, LAPTOP_8GB]),
    ),
    'table-b': mdTable(
      ['Scenario', 'Apple silicon', na],
      b.map((r) => [...r, LAPTOP_8GB]),
    ),
  };
}

const blockRe = (name) =>
  new RegExp(`(<!-- bench:start ${name} -->)\\n[\\s\\S]*?\\n(<!-- bench:end ${name} -->)`);

/** README text with each generated block replaced; throws when a marker pair is missing. */
export function applyTables(readme, built) {
  let out = readme;
  for (const [name, table] of Object.entries(built)) {
    const re = blockRe(name);
    if (!re.test(out))
      throw new Error(
        `README.md has no <!-- bench:start ${name} --> / <!-- bench:end ${name} --> pair`,
      );
    out = out.replace(re, (_m, s, e) => `${s}\n\n${table}\n\n${e}`);
  }
  return out;
}

// ---- figures in prose ------------------------------------------------------------------------------------------

/** The text of a document with the generated blocks and the fenced code removed (tags removed from HTML). */
export function proseOf(text, file = '') {
  let t = text.replace(/\r\n?/g, '\n');
  t = t.replace(/<!-- bench:start ([\w-]+) -->[\s\S]*?<!-- bench:end \1 -->/g, ' ');
  if (file.endsWith('.html')) t = t.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
  const lines = [];
  let fenced = false;
  for (const l of t.split('\n')) {
    if (/^\s*```/.test(l)) fenced = !fenced;
    else if (!fenced) lines.push(l);
  }
  return lines.join('\n');
}

const TOKEN =
  /(?<![\w.,/-])(\d[\d,]*(?:\.\d+)?)(?: (s)(?![\w/])|\s?(ms|tokens\/s|MB\/s|MiB|GiB|KiB)(?![\w/]))/g;

/** Figures like "4060 ms", "10.9 tokens/s", "726.7 MiB", "2.4 s" in prose. profile "timing" skips whole-number MiB/GiB/KiB. */
export function figureTokens(text, profile = 'timing') {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    const unit = m[2] ?? m[3];
    const num = m[1];
    if (profile === 'timing' && /^(MiB|GiB|KiB)$/.test(unit) && !num.includes('.')) continue;
    out.push({ text: `${num} ${unit}`, number: num.replace(/,/g, ''), unit, index: m.index });
  }
  return out;
}

const rounded = (v) => {
  const s = new Set();
  for (const d of [0, 1, 2, 3]) {
    const f = 10 ** d;
    s.add(String(Math.round(v * f) / f));
  }
  return s;
};
const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const toNumber = (t) => Number(t.replace(/,/g, ''));

/**
 * For each unit, the numbers a committed raw file can back. A JSON number counts only under a key that says what it
 * is (a *Ms key for ms, tokensPerSecond, mbPerSecond, a byte-count key for MiB/GiB/KiB, a *KiB key); a number in a
 * text file counts when the unit follows it, or when it is a bare byte count. So an unrelated 30 or 2.4 backs nothing.
 */
export function supportedNumbers(benches) {
  const sets = {
    ms: new Set(),
    s: new Set(),
    'tokens/s': new Set(),
    'MB/s': new Set(),
    MiB: new Set(),
    GiB: new Set(),
    KiB: new Set(),
  };
  const add = (unit, v) => rounded(v).forEach((x) => sets[unit].add(x));
  const bytes = (v) => {
    add('KiB', v / 1024);
    add('MiB', v / 1048576);
    add('GiB', v / 1073741824);
  };
  const fromKib = (v) => {
    add('KiB', v);
    add('MiB', v / 1024);
    add('GiB', v / 1048576);
  };
  const BYTE_KEY =
    /(bytes|size|usage|quota|peak|needed|rss|stored|written|sent|received|heap|drop)/i;
  const leaf = (key, v, path) => {
    if (/KiB$/.test(key)) fromKib(v);
    else if (/(ms|Ms)$/.test(key) || path.includes('pagePhases')) add('ms', v);
    else if (/tokensPerSecond/i.test(key)) add('tokens/s', v);
    else if (/mbPerSecond/i.test(key)) add('MB/s', v);
    else if (BYTE_KEY.test(key) && Math.abs(v) >= 1024) bytes(v);
  };
  const text = (t) => {
    for (const m of t.matchAll(
      new RegExp(
        String.raw`(?<![\w.])(${NUM})(?: (s)(?![\w/])|\s?(ms|tokens/s|MB/s|MiB|GiB|KiB)(?![\w/]))`,
        'g',
      ),
    ))
      add(m[2] ?? m[3], toNumber(m[1]));
    for (const m of t.matchAll(new RegExp(String.raw`"\w*(?:ms|Ms)":\s*(${NUM})`, 'g')))
      add('ms', toNumber(m[1]));
    for (const m of t.matchAll(
      new RegExp(
        String.raw`"(?:${'stored|estimateUsage|cdpUsage|cdpIdb|expectedSize|snapshotSize'})":\s*(${NUM})`,
        'g',
      ),
    ))
      bytes(toNumber(m[1]));
  };
  const walk = (o, path = []) => {
    if (typeof o === 'number' && Number.isFinite(o)) leaf(path.at(-1) ?? '', o, path);
    else if (typeof o === 'string') text(o);
    else if (Array.isArray(o)) o.forEach((x) => walk(x, path));
    else if (o && typeof o === 'object')
      for (const [k, v] of Object.entries(o)) walk(v, [...path, k]);
  };
  for (const b of Object.values(benches)) b.files.forEach((f) => walk(f.json ?? f.text));
  return sets;
}

/**
 * Figures the prose states that no committed file backs. A figure passes when its number occurs in a raw file,
 * when it is listed in allow (an exact "number unit" string, each with its reason), or when "raw data not kept"
 * stands within 160 characters of it in the same paragraph.
 */
export function unsupportedFigures(text, benches, { profile = 'timing', allow = {} } = {}) {
  const sets = supportedNumbers(benches);
  const prose = proseOf(text);
  const bad = [];
  for (const t of figureTokens(prose, profile)) {
    if (sets[t.unit]?.has(t.number) || Object.hasOwn(allow, t.text)) continue;
    const from = Math.max(prose.lastIndexOf('\n\n', t.index) + 1, t.index - 160);
    const to = Math.min(
      prose.indexOf('\n\n', t.index) === -1 ? prose.length : prose.indexOf('\n\n', t.index),
      t.index + 160,
    );
    if (prose.slice(from, to).replace(/\s+/g, ' ').includes(NOT_KEPT)) continue;
    bad.push(t.text);
  }
  return bad;
}

/**
 * The documents the check reads, each with the profile it is read with and its allow-list. An allowed figure is
 * a constant of the design or a parameter of the scenario, not a result; each says which.
 */
export const CHECKED = {
  'README.md': {
    profile: 'timing',
    allow: {
      '250 ms':
        'ABORT_GRACE_MS: the 250 ms the worker gets to answer an abort before it is terminated (src/backends/worker-adapter.ts), a design constant',
      '60 s':
        'the age under which reconcile() leaves a file alone (src/asset-manager.ts), a design constant',
      '1.5 GiB': 'the quota override of the 700 MB scenario, a parameter of the benchmark',
    },
  },
  'docs/memory-options.md': {
    profile: 'all',
    allow: {
      '3 s': 'the settle time the unload test waits, a parameter (it is also in the raw log)',
    },
  },
  'docs/engine-load-retry.md': {
    profile: 'all',
    allow: {
      '8 MiB': 'the chunk size of the store commit path, a design constant',
      '1.5 s': 'how long the "read later" variant waits, a parameter of the test',
      '1500 ms': 'LOAD_RETRY_PAUSE_MS in dockit, a constant of another repository',
    },
  },
  'docs/model-choice.md': { profile: 'timing', allow: {} },
  'docs/writeup-0.3.0-beta.2-draft.md': { profile: 'timing', allow: {} },
  'CHANGELOG.md': {
    profile: 'timing',
    allow: {
      '250 ms': 'the abort grace, a design constant',
      '1.5 GiB': 'the quota of the benchmark scenario, a parameter',
      '10 s': 'the timeout of a test (release-tool file handling), a parameter',
      '60 s': 'the age under which reconcile() leaves a file alone, a design constant',
    },
  },
  'demo/index.html': { profile: 'timing', allow: {} },
  'demo/models.html': {
    profile: 'timing',
    allow: {
      '250 ms':
        'the abort grace, a design constant (the measured 252 to 253 ms are in worker-abort-long-task.json)',
    },
  },
};

/** Run every check against the files under dir (the repository root by default). Returns the problem list. */
export function checkAll(dir = root) {
  const bench = join(dir, 'docs', 'benchmarks');
  const benches = loadBenchmarks(bench);
  let indexText;
  try {
    indexText = readFileSync(join(bench, 'README.md'), 'utf8');
  } catch {
    return ['docs/benchmarks/README.md is missing'];
  }
  const problems = validateAll(benches, indexText);
  if (problems.length) return problems;
  const readme = readFileSync(join(dir, 'README.md'), 'utf8').replace(/\r\n?/g, '\n');
  let want;
  try {
    want = applyTables(readme, tables(benches));
  } catch (e) {
    return [`README tables: ${e.message}`];
  }
  if (want !== readme)
    problems.push(
      'README.md Benchmarks tables differ from the files: run node scripts/bench-readme.mjs',
    );
  for (const [file, { profile, allow }] of Object.entries(CHECKED)) {
    let text;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      problems.push(`${file}: missing`);
      continue;
    }
    for (const fig of unsupportedFigures(text, benches, { profile, allow }))
      problems.push(
        `${file}: "${fig}" has no raw data in docs/benchmarks/ (add the file, or say "${NOT_KEPT}" beside it)`,
      );
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  if (check) {
    const problems = checkAll();
    if (problems.length) {
      console.error(problems.map((p) => `- ${p}`).join('\n'));
      process.exit(1);
    }
    console.log(
      'benchmarks: every file is well formed, the README tables equal the files, every prose figure has raw data',
    );
  } else {
    const path = join(root, 'README.md');
    const readme = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
    const next = applyTables(readme, tables(loadBenchmarks()));
    if (next !== readme) writeFileSync(path, next);
    console.log(next === readme ? 'README tables already match' : 'README tables rewritten');
  }
}
