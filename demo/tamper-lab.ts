// The Tamper lab of the runtime demo (manifest spec v0.1, spec release 0.6.0): fifteen buttons, each one
// runs the real verifier or the real asset manager over bytes copied verbatim from spec/vectors/tamper
// and spec/vectors/tamper-assets (demo/tools/tamper-fixture.mjs fails the build if a copy differs), and
// shows the verdict, the reason code, the per-signature reasons and the stage exactly as the library
// returns them.
//
// ISOLATION (security finding S1): this module builds its own trust set (RFC 8032 TEST 1 and TEST 2
// only) and gives every case its own in-memory ManifestStateStore. Every asset case gets a separate
// AssetManager on a fresh MEMORY store. It never touches the page's fixture trust set, the pasted trust
// roots, the persistent OPFS or IndexedDB store 'airplanemode-runtime', or the page's downgrade state.
// `allowTestKeys: true` is a literal in this module only: it is not read from the URL, from storage or
// from any input. The vectors are signed with public RFC 8032 test keys, so the library, whose default
// is false, would refuse them; the lab says so on the page.
//
// Every case is evaluated at the vectors' fixed clock (2026-11-14T00:00:00Z) so a result never changes
// when the base manifest's expiresAt (2027-11-01) passes.
//
// Counters: a PerformanceObserver (type 'resource') counts the requests the page makes. A manifest
// refusal must be followed by 0 requests; an asset case fetches its asset exactly once, then refuses it.

import {
  AssetError,
  AssetManager,
  InMemoryManifestState,
  ManifestError,
  RFC8032_TEST_KEY_IDS,
  RFC8032_TEST_PUBLIC_KEYS_HEX,
  verifyManifest,
} from '../src/index.ts';
import type { Manifest, SignatureCheck } from '../src/index.ts';

type Kind = 'manifest' | 'asset' | 'valid' | 'expect-id' | 'weak-key';

interface LabCase {
  id: string;
  kind: Kind;
  /** vectors/<file> for a manifest case, assets/<file> (the manifest) for an asset case. */
  file: string;
  /** assets/<file>: the asset an asset case fetches. */
  bin?: string;
}

const CASES: readonly LabCase[] = [
  { id: 'tamper-01', kind: 'manifest', file: 'tamper-01-entry-sha-byte.json' },
  { id: 'tamper-02', kind: 'manifest', file: 'tamper-02-entry-size.json' },
  { id: 'tamper-03', kind: 'manifest', file: 'tamper-03-sig-bitflip.json' },
  { id: 'tamper-04', kind: 'manifest', file: 'tamper-04-swapped-key.json' },
  { id: 'tamper-05', kind: 'manifest', file: 'tamper-05-publickey-mismatch.json' },
  { id: 'tamper-06', kind: 'manifest', file: 'tamper-06-untrusted-key.json' },
  { id: 'tamper-07', kind: 'manifest', file: 'tamper-07-truncated.txt' },
  { id: 'tamper-08', kind: 'manifest', file: 'tamper-08-rollback.json' },
  { id: 'tamper-10', kind: 'manifest', file: 'tamper-10-expired.json' },
  { id: 'tamper-15', kind: 'manifest', file: 'tamper-15-noncanonical-s.json' },
  { id: 'asset-flip', kind: 'asset', file: 'manifest-flip.json', bin: 'asset-flip.bin' },
  {
    id: 'asset-truncated',
    kind: 'asset',
    file: 'manifest-truncated.json',
    bin: 'asset-truncated.bin',
  },
  // tamper-14 is the unmodified, validly signed base manifest ("tamper-base"): the refusal in the
  // vector table comes from allowTestKeys false, which the lab sets true on purpose.
  { id: 'valid', kind: 'valid', file: 'tamper-14-test-key-refused.json' },
  // manifest 0.1.2: the validly signed base manifest (id 'tamper-base') meets a page that expects another id
  { id: 'other-product', kind: 'expect-id', file: 'tamper-14-test-key-refused.json' },
  // manifest 0.1.3 (S1-113): a trust set that holds the identity point as a key meets the forged manifest
  // (signature R = identity, S = 0): the verifier refuses the TRUST SET before it parses the manifest
  { id: 'weak-key', kind: 'weak-key', file: 'forged-identity.manifest.json' },
];

const BASE_FILE = 'tamper-14-test-key-refused.json';
const VECTOR_NOW = Date.parse('2026-11-14T00:00:00Z');
/** The lab waits this long after a verdict before it counts requests that followed it. */
const SETTLE_MS = 400;

const TRUST_NAMES: Record<string, number> = { 'rfc8032-1': 0, 'rfc8032-2': 1 };

interface TamperRow {
  file: string;
  trust: string[];
  expect: { valid: boolean; stage?: string; reason?: string; signatures?: string[] };
}
interface AssetExpect {
  informative: { runtimeCode: string | null; runtimeReason: string | null };
}

const PARSE_STAGE_REASONS = new Set([
  'invalid_json',
  'lone_surrogate',
  'float',
  'bigint',
  'digit_key',
  'invalid_key',
  'bad_spec',
  'bad_url',
  'schema',
  'unsorted_entries',
  'duplicate_entries',
]);
const stageOf = (reason: string): string => (PARSE_STAGE_REASONS.has(reason) ? 'parse' : 'verify');

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
};

/** The lab's own trust set: only the named RFC 8032 test keys, never anything the page holds. */
function labTrust(names: readonly string[]): Map<string, Uint8Array> {
  const trust = new Map<string, Uint8Array>();
  for (const name of names) {
    const i = TRUST_NAMES[name];
    const keyId = i === undefined ? undefined : RFC8032_TEST_KEY_IDS[i];
    const hex = i === undefined ? undefined : RFC8032_TEST_PUBLIC_KEYS_HEX[i];
    if (keyId === undefined || hex === undefined) throw new Error(`unknown trust name ${name}`);
    trust.set(keyId, hexToBytes(hex));
  }
  return trust;
}

const perSignature = (sigs: SignatureCheck[]): string[] =>
  sigs.map((c) => (c.valid ? 'valid' : (c.reason ?? 'invalid')));

// --- request counter -----------------------------------------------------------------------------

const seen: PerformanceResourceTiming[] = [];
let observer: PerformanceObserver | undefined;
function startObserver(): void {
  if (observer || typeof PerformanceObserver === 'undefined') return;
  observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) seen.push(e as PerformanceResourceTiming);
  });
  observer.observe({ type: 'resource', buffered: true });
}
function flush(): void {
  if (!observer) return;
  for (const e of observer.takeRecords()) seen.push(e as PerformanceResourceTiming);
}
/** Requests that started at or after `t` (performance.now()), optionally only those whose URL matches. */
function countSince(t: number, match?: (url: string) => boolean): number {
  flush();
  return seen.filter((e) => e.startTime >= t && (!match || match(e.name))).length;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- fixture ---------------------------------------------------------------------------------------

const FIXTURE = new URL('./tamper/', location.href);
async function fetchText(path: string): Promise<string> {
  const res = await fetch(new URL(path, FIXTURE).href, {
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.text();
}

let table: Promise<{ rows: TamperRow[]; assets: Record<string, AssetExpect> }> | undefined;
function loadTables(): Promise<{ rows: TamperRow[]; assets: Record<string, AssetExpect> }> {
  table ??= (async () => ({
    rows: JSON.parse(await fetchText('vectors/tamper.json')) as TamperRow[],
    assets: JSON.parse(await fetchText('assets/expect.json')) as Record<string, AssetExpect>,
  }))();
  return table;
}

// --- cells -----------------------------------------------------------------------------------------

function rowOf(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`#tamper-lab [data-case="${id}"]`);
  if (!el) throw new Error(`missing lab row ${id}`);
  return el;
}
function setCell(id: string, name: string, text: string): void {
  const cell = rowOf(id).querySelector<HTMLElement>(`[data-cell="${name}"]`);
  if (cell) cell.textContent = text;
}
const CELLS = [
  'verdict',
  'reason',
  'signatures',
  'stage',
  'asset',
  'bytes',
  'assetRequests',
  'after',
  'match',
] as const;
function clearCells(id: string): void {
  for (const name of CELLS) setCell(id, name, '');
}

interface Outcome {
  verdict: 'Refused' | 'Accepted';
  reason: string;
  signatures: string[];
  stage: string;
  /** performance.now() when the verdict was reached. */
  at: number;
  asset?: { code: string; reason: string | null };
  bytes?: { toConsumer: number; getBlobRejected: boolean; blobUrls: number };
  match: string;
}

// --- cases -----------------------------------------------------------------------------------------

async function runManifestCase(c: LabCase): Promise<Outcome> {
  const { rows } = await loadTables();
  const row = rows.find((r) => r.file === c.file);
  if (!row) throw new Error(`no row for ${c.file} in tamper.json`);
  const text = await fetchText(`vectors/${c.file}`);
  const trust = labTrust(row.trust);
  // a fresh in-memory downgrade store per case
  const state = new InMemoryManifestState();
  if (c.id === 'tamper-08') {
    // rollback: first accept the unmodified, validly signed base (version 1.1.0) in the lab's own store
    const seeded = await verifyManifest(await fetchText(`vectors/${BASE_FILE}`), trust, {
      allowTestKeys: true,
      now: VECTOR_NOW,
      state,
    });
    if (!seeded.ok) throw new Error('the lab could not seed its state from the base manifest');
  }
  const r = await verifyManifest(text, trust, { allowTestKeys: true, now: VECTOR_NOW, state });
  const at = performance.now();
  if (r.ok) {
    return {
      verdict: 'Accepted',
      reason: 'none',
      signatures: perSignature(r.signatures),
      stage: 'accepted',
      at,
      match: row.expect.valid ? 'matches the vector table' : 'DIFFERS from the vector table',
    };
  }
  const sigs = perSignature(r.signatures);
  const want = row.expect;
  const same =
    !want.valid &&
    want.reason === r.reason &&
    (want.signatures === undefined || want.signatures.join(',') === sigs.join(','));
  return {
    verdict: 'Refused',
    reason: r.reason,
    signatures: sigs,
    stage: stageOf(r.reason),
    at,
    match: same
      ? 'matches the vector table'
      : `DIFFERS from the vector table (${want.reason ?? 'accepted'})`,
  };
}

async function runValidCase(c: LabCase): Promise<Outcome> {
  const text = await fetchText(`vectors/${c.file}`);
  const r = await verifyManifest(text, labTrust(['rfc8032-1']), {
    allowTestKeys: true,
    now: VECTOR_NOW,
    state: new InMemoryManifestState(),
  });
  const at = performance.now();
  if (!r.ok)
    return {
      verdict: 'Refused',
      reason: r.reason,
      signatures: perSignature(r.signatures),
      stage: stageOf(r.reason),
      at,
      match: 'DIFFERS: the unmodified base manifest must be accepted',
    };
  return {
    verdict: 'Accepted',
    reason: 'none',
    signatures: perSignature(r.signatures),
    stage: 'accepted',
    at,
    match: 'matches: the unmodified base manifest is accepted',
  };
}

interface ExpectIdRow {
  file: string;
  expectId: string;
  expect: { valid: boolean; stage?: string; reason?: string };
}

/**
 * Case 'other-product' (manifest 0.1.2): the unmodified, validly signed base manifest is verified by a page that
 * expects the id 'other-product' (row 02 of vectors/expect-id/expect-id.json). The verdict must be
 * unexpected_id at stage verify, and the lab's state store must be neither read nor written for it.
 */
async function runExpectIdCase(c: LabCase): Promise<Outcome> {
  const rows = JSON.parse(await fetchText('vectors/expect-id.json')) as ExpectIdRow[];
  const row = rows.find(
    (r) => r.file === 'tamper/tamper-base.json' && r.expectId === 'other-product',
  );
  if (!row) throw new Error('no other-product row in expect-id.json');
  const text = await fetchText(`vectors/${c.file}`);
  let touched = 0;
  const inner = new InMemoryManifestState();
  const state = {
    get: async (id: string) => {
      touched++;
      return inner.get(id);
    },
    set: async (id: string, s: { version: string; createdAt: string }) => {
      touched++;
      return inner.set(id, s);
    },
  };
  const r = await verifyManifest(text, labTrust(['rfc8032-1']), {
    allowTestKeys: true,
    now: VECTOR_NOW,
    state,
    expectId: row.expectId,
  });
  const at = performance.now();
  const sigs = perSignature(r.signatures);
  if (r.ok)
    return {
      verdict: 'Accepted',
      reason: 'none',
      signatures: sigs,
      stage: 'accepted',
      at,
      match: 'DIFFERS from the vector table (the manifest of another product was accepted)',
    };
  const same = !row.expect.valid && row.expect.reason === r.reason && touched === 0;
  return {
    verdict: 'Refused',
    reason: r.reason,
    signatures: sigs,
    stage: stageOf(r.reason),
    at,
    match: same
      ? `matches the vector table (expectId ${row.expectId}; the downgrade state was read or written ${touched} times)`
      : `DIFFERS from the vector table (${row.expect.reason ?? 'accepted'}; state accesses ${touched})`,
  };
}

interface WeakVerifyRow {
  manifest: string;
  trust: { keyIdHex: string; publicKeyHex: string }[];
  expect: { throws: string };
}

/**
 * Case 'weak-key' (manifest 0.1.3): row 1 of vectors/weak-keys/verify.json. The lab's trust set holds the identity
 * point, filed under its own key id, and the verifier is handed the forged manifest (R = identity, S = 0). The
 * verifier must THROW weak_key_refused before it parses anything: no verdict on the document, nothing requested.
 * Nothing but the lab's own in-memory data is involved, and allowTestKeys stays the literal true of this module.
 */
async function runWeakKeyCase(c: LabCase): Promise<Outcome> {
  const rows = JSON.parse(await fetchText('vectors/weak-keys-verify.json')) as WeakVerifyRow[];
  const row = rows.find((r) => r.manifest === `weak-keys/${c.file}`);
  if (!row) throw new Error('no forged-identity row in weak-keys-verify.json');
  const text = await fetchText(`vectors/${c.file}`);
  const trust = new Map<string, Uint8Array>(
    row.trust.map((k) => [k.keyIdHex, hexToBytes(k.publicKeyHex)]),
  );
  let thrown: unknown;
  let accepted = false;
  try {
    const r = await verifyManifest(text, trust, {
      allowTestKeys: true,
      now: VECTOR_NOW,
      state: new InMemoryManifestState(),
    });
    accepted = r.ok;
  } catch (e) {
    thrown = e;
  }
  const at = performance.now();
  if (thrown instanceof ManifestError) {
    const same = thrown.reason === row.expect.throws;
    return {
      verdict: 'Refused',
      reason: thrown.reason,
      signatures: [],
      stage: 'trust set, before parse',
      at,
      match: same
        ? 'matches the vector table (row 1 of weak-keys/verify.json: the verifier throws before it reads the manifest)'
        : `DIFFERS from the vector table (${row.expect.throws})`,
    };
  }
  return {
    verdict: accepted ? 'Accepted' : 'Refused',
    reason: accepted ? 'none' : 'unexpected',
    signatures: [],
    stage: accepted ? 'accepted' : 'verify',
    at,
    match: `DIFFERS from the vector table (${row.expect.throws}): the weak key was not refused`,
  };
}

async function runAssetCase(c: LabCase): Promise<Outcome> {
  const { assets } = await loadTables();
  const informative = assets[c.file]?.informative;
  const text = await fetchText(`assets/${c.file}`);
  const trust = labTrust(['rfc8032-1']);
  const verified = await verifyManifest(text, trust, {
    allowTestKeys: true,
    now: VECTOR_NOW,
    state: new InMemoryManifestState(),
  });
  if (!verified.ok) {
    return {
      verdict: 'Refused',
      reason: verified.reason,
      signatures: perSignature(verified.signatures),
      stage: stageOf(verified.reason),
      at: performance.now(),
      match: 'DIFFERS: the asset manifests are validly signed',
    };
  }
  // a separate AssetManager on a fresh memory store: nothing persists and nothing is shared
  const mgr = new AssetManager({
    store: 'memory',
    allowTestKeys: true,
    allowedOrigins: [location.origin],
    headroomBytes: 0,
    progressIntervalMs: 0,
  });
  await mgr.loadManifest(JSON.parse(text) as Manifest, trust, {
    baseUrl: new URL(`assets/${c.file}`, FIXTURE).href,
    now: VECTOR_NOW,
  });
  let blobUrls = 0;
  const original = URL.createObjectURL;
  URL.createObjectURL = (obj: Blob | MediaSource): string => {
    blobUrls++;
    return original.call(URL, obj);
  };
  let failure: unknown;
  let toConsumer = 0;
  let getBlobRejected = false;
  try {
    try {
      await mgr.ensure('asset-ok');
    } catch (e) {
      failure = e;
    }
    try {
      toConsumer = (await mgr.getBlob('asset-ok')).size;
    } catch {
      getBlobRejected = true;
    }
  } finally {
    URL.createObjectURL = original;
  }
  const at = performance.now();
  const code = failure instanceof AssetError ? String(failure.code) : 'none';
  const reason = failure instanceof AssetError ? (failure.reason ?? null) : null;
  const refused = failure !== undefined && toConsumer === 0 && getBlobRejected && blobUrls === 0;
  const sameCode =
    informative !== undefined &&
    informative.runtimeCode === code &&
    informative.runtimeReason === reason;
  return {
    verdict: refused ? 'Refused' : 'Accepted',
    reason: refused ? 'asset_refused' : 'none',
    signatures: perSignature(verified.signatures),
    stage: 'asset',
    at,
    asset: { code, reason },
    bytes: { toConsumer, getBlobRejected, blobUrls },
    match: sameCode
      ? 'matches expect.json (the code is runtime-specific; the normative fields are the bytes and the URL)'
      : 'DIFFERS from expect.json',
  };
}

async function runCase(c: LabCase): Promise<void> {
  clearCells(c.id);
  setCell(c.id, 'verdict', 'Running');
  const start = performance.now();
  let outcome: Outcome;
  try {
    outcome = await (c.kind === 'manifest'
      ? runManifestCase(c)
      : c.kind === 'asset'
        ? runAssetCase(c)
        : c.kind === 'expect-id'
          ? runExpectIdCase(c)
          : c.kind === 'weak-key'
            ? runWeakKeyCase(c)
            : runValidCase(c));
  } catch (e) {
    const message = e instanceof ManifestError ? `${e.reason}: ${e.message}` : String(e);
    setCell(c.id, 'verdict', 'Error');
    setCell(c.id, 'reason', message);
    return;
  }
  setCell(c.id, 'verdict', outcome.verdict);
  setCell(c.id, 'reason', outcome.reason);
  setCell(c.id, 'signatures', outcome.signatures.join(', ') || '(none)');
  setCell(c.id, 'stage', outcome.stage);
  if (outcome.asset)
    setCell(
      c.id,
      'asset',
      `AssetError ${outcome.asset.code}${outcome.asset.reason ? ` (${outcome.asset.reason})` : ''}, runtime-specific`,
    );
  if (outcome.bytes)
    setCell(
      c.id,
      'bytes',
      `Bytes to consumer: ${outcome.bytes.toConsumer}; getBlob: ${
        outcome.bytes.getBlobRejected ? 'rejected' : 'resolved'
      }; blob: URLs created: ${outcome.bytes.blobUrls}`,
    );
  setCell(c.id, 'match', outcome.match);
  // count what the page requested after the verdict (it must be nothing) and the asset requests of the case
  await sleep(SETTLE_MS);
  const asset = c.bin;
  const assetRequests = countSince(start, (url) =>
    asset === undefined
      ? /\/tamper\/assets\/asset-/.test(url)
      : url.endsWith(`/tamper/assets/${asset}`),
  );
  const after = countSince(outcome.at);
  setCell(c.id, 'assetRequests', `Asset requests: ${assetRequests}`);
  setCell(c.id, 'after', `Requests after refusal: ${after}`);
}

/** Wires the lab's buttons. Called once by main.ts. */
export function initTamperLab(): void {
  startObserver();
  const buttons = document.querySelectorAll<HTMLButtonElement>(
    '#tamper-lab button[data-action="run"]',
  );
  for (const button of buttons) {
    const id = button.closest<HTMLElement>('[data-case]')?.dataset['case'];
    const c = CASES.find((x) => x.id === id);
    if (!c) continue;
    button.addEventListener('click', () => {
      button.disabled = true;
      void runCase(c).finally(() => {
        button.disabled = false;
      });
    });
  }
  document.getElementById('lab-run-all')?.addEventListener('click', async (ev) => {
    const all = ev.currentTarget as HTMLButtonElement;
    all.disabled = true;
    try {
      for (const c of CASES) await runCase(c);
    } finally {
      all.disabled = false;
    }
  });
}
