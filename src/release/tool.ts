/**
 * The release tool's four commands (manifest 0.1.4, "Release manifests"): manifest, sums, sign and verify.
 *
 * A command either returns (after printing its result) or throws. A ReleaseStop carries a token; cli.ts turns it
 * into exit 2 (usage) or exit 3 (refused) with classify(). Anything else that is thrown (a missing file, a
 * permission error, a manifest that does not parse in `sign` or `sums`) is exit 1: an I/O error never counts as a
 * refusal. The tool reads no key: the only key it can sign with is the published RFC 8032 TEST 1 key, for ids that
 * match REHEARSAL_ID_PATTERN (R1), and it never reads the environment (R3; the single environment read of the
 * bundle, SOURCE_DATE_EPOCH, is in bin.ts and arrives here as a parameter).
 */

import { join } from 'node:path';
import {
  MANIFEST_SPEC,
  SEMVER_PATTERN,
  type Manifest,
  type ManifestEntry,
} from '../../spec/manifest';
import {
  REHEARSAL_ID_PATTERN,
  REHEARSAL_PUBLISHER,
  REHEARSAL_TEST_KEY_NAME,
  RELEASE_ARTIFACT_NAME_PATTERN,
  RELEASE_DEFAULT_MEDIA_TYPE,
  RELEASE_ID_PATTERN,
  RELEASE_MANIFEST_NAME,
  RELEASE_MEDIA_TYPES,
  RELEASE_PUBLISHER,
  RELEASE_SOURCE_DATE_EPOCH_MAX,
  RELEASE_USAGE_SYNTAX_TOKEN,
  SHA256SUMS_NAME,
  TEST_KEY_SIGN_BANNER,
  TEST_KEY_VERIFY_BANNER,
} from '../../spec/release';
import {
  InMemoryManifestState,
  ManifestError,
  parseManifest,
  verifyManifest,
  type TrustSet,
} from '../manifest';
import {
  ReleaseStop,
  hashRegularFile,
  isRegular,
  listRegularMembers,
  lstatOrUndefined,
  readRegularFile,
  requireDirectory,
  writeRegularFile,
} from './fsutil';
import {
  TEST1_KEY_ID,
  TEST1_PUBLIC,
  isRfc8032TestKey,
  parseReleaseKeys,
  signWithTestKey1,
} from './keys';
import { byName, sumsText } from './sums';

export interface ToolIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** The manifest, SHA256SUMS and keys files are small; anything bigger is not one of ours. */
const MAX_SMALL_FILE = 4 * 1024 * 1024;

// ---- classification ---------------------------------------------------------------------------------------

/** Tokens that are always a usage error (exit 2), whatever the command. */
const USAGE_TOKENS: ReadonlySet<string> = new Set([
  'expect_id_required',
  'test_key_flag_misuse',
  'bad_release_id',
  'bad_artifact_name',
  'already_signed',
  'bad_trust_source',
  RELEASE_USAGE_SYNTAX_TOKEN,
]);
/** Tokens that are a refusal in `verify` and a usage error in the commands that build or sign. */
const COMMAND_DEPENDENT: ReadonlySet<string> = new Set([
  'not_regular_file',
  'test_key_release_id',
  'publisher_mismatch',
]);

/** 'usage' (exit 2) or 'refused' (exit 3) for a token raised by `command`. */
export function classify(command: string, token: string): 'usage' | 'refused' {
  if (USAGE_TOKENS.has(token)) return 'usage';
  if (COMMAND_DEPENDENT.has(token)) return command === 'verify' ? 'refused' : 'usage';
  return command === 'verify' ? 'refused' : 'usage';
}

// ---- shared pieces ----------------------------------------------------------------------------------------

const stop = (token: string, message: string): ReleaseStop => new ReleaseStop(token, message);

const SEMVER = new RegExp(SEMVER_PATTERN);

/** The member order of every release file: the order of the interfaces in spec/manifest.ts. */
export function manifestText(m: Manifest): string {
  const entries = m.entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    url: e.url,
    sha256: e.sha256,
    size: e.size,
    version: e.version,
    licence: e.licence,
    minProfile: e.minProfile,
    ...(e.mediaType !== undefined ? { mediaType: e.mediaType } : {}),
  }));
  const signatures = m.signatures.map((g) => ({
    alg: g.alg,
    keyId: g.keyId,
    ...(g.publicKey !== undefined ? { publicKey: g.publicKey } : {}),
    sig: g.sig,
    signedAt: g.signedAt,
  }));
  const body = {
    spec: m.spec,
    id: m.id,
    version: m.version,
    publisher: m.publisher,
    createdAt: m.createdAt,
    ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
    entries,
    signatures,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** createdAt from SOURCE_DATE_EPOCH (a decimal integer, 0..RELEASE_SOURCE_DATE_EPOCH_MAX), else the clock. */
export function createdAtFrom(sourceDateEpoch: string | undefined): string {
  let ms: number;
  if (sourceDateEpoch === undefined) ms = Date.now();
  else {
    if (
      !/^\d{1,12}$/.test(sourceDateEpoch) ||
      Number(sourceDateEpoch) > RELEASE_SOURCE_DATE_EPOCH_MAX
    )
      throw stop(
        RELEASE_USAGE_SYNTAX_TOKEN,
        `SOURCE_DATE_EPOCH must be a decimal integer from 0 to ${RELEASE_SOURCE_DATE_EPOCH_MAX}`,
      );
    ms = Number(sourceDateEpoch) * 1000;
  }
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mediaTypeOf(name: string): string {
  for (const [suffix, type] of RELEASE_MEDIA_TYPES) if (name.endsWith(suffix)) return type;
  return RELEASE_DEFAULT_MEDIA_TYPE;
}

async function readManifestFile(dir: string): Promise<Manifest> {
  const text = (await readRegularFile(join(dir, RELEASE_MANIFEST_NAME), MAX_SMALL_FILE)).toString(
    'utf8',
  );
  try {
    return parseManifest(text);
  } catch (e) {
    throw new Error(`${RELEASE_MANIFEST_NAME} is not a valid manifest: ${(e as Error).message}`);
  }
}

// ---- manifest ---------------------------------------------------------------------------------------------

export interface ManifestArgs {
  dir: string;
  id: string;
  version: string;
  licence: string;
  publisher: string;
  sourceDateEpoch: string | undefined;
}

/** Writes an unsigned release manifest of every regular file in the directory except the manifest and SHA256SUMS. */
export async function manifestCommand(a: ManifestArgs, io: ToolIO): Promise<void> {
  if (a.publisher !== 'release' && a.publisher !== 'rehearsal')
    throw stop(RELEASE_USAGE_SYNTAX_TOKEN, '--publisher must be "release" or "rehearsal"');
  const isRelease = RELEASE_ID_PATTERN.test(a.id);
  if (!isRelease && !REHEARSAL_ID_PATTERN.test(a.id))
    throw stop('bad_release_id', 'the id must be <package>-release or <package>-rehearsal');
  if (isRelease !== (a.publisher === 'release'))
    throw stop(
      'publisher_mismatch',
      'the publisher kind must match the id suffix (-release or -rehearsal)',
    );
  if (!SEMVER.test(a.version))
    throw stop(
      RELEASE_USAGE_SYNTAX_TOKEN,
      '--version must be strict SemVer 2.0 without build metadata',
    );
  if (a.licence.length === 0 || a.licence.length > 128)
    throw stop(
      RELEASE_USAGE_SYNTAX_TOKEN,
      '--licence must be an SPDX expression of 1 to 128 characters',
    );
  const createdAt = createdAtFrom(a.sourceDateEpoch);
  await requireDirectory(a.dir);
  const names = await listRegularMembers(a.dir);
  const artefacts = names.filter((n) => n !== RELEASE_MANIFEST_NAME && n !== SHA256SUMS_NAME);
  if (artefacts.length === 0)
    throw stop(RELEASE_USAGE_SYNTAX_TOKEN, 'the directory holds no artefact to list');
  for (const n of artefacts)
    if (!RELEASE_ARTIFACT_NAME_PATTERN.test(n))
      throw stop(
        'bad_artifact_name',
        `${JSON.stringify(n)} is not a lowercase file name of the entry grammar [a-z0-9][a-z0-9._-]{0,127}`,
      );
  const entries: ManifestEntry[] = [];
  for (const n of artefacts) {
    const { sha256, size } = await hashRegularFile(join(a.dir, n));
    entries.push({
      id: n,
      kind: 'other',
      url: n,
      sha256,
      size,
      version: a.version,
      licence: a.licence,
      minProfile: {},
      mediaType: mediaTypeOf(n),
    });
  }
  entries.sort((x, y) => byName(x.id, y.id));
  const manifest: Manifest = {
    spec: MANIFEST_SPEC,
    id: a.id,
    version: a.version,
    publisher: isRelease ? RELEASE_PUBLISHER : REHEARSAL_PUBLISHER,
    createdAt,
    entries,
    signatures: [],
  };
  try {
    parseManifest(manifest); // the schema, the calendar and the ordering rules, before anything is written
  } catch (e) {
    throw stop(
      RELEASE_USAGE_SYNTAX_TOKEN,
      `the manifest would not be valid: ${(e as Error).message}`,
    );
  }
  await writeRegularFile(
    join(a.dir, RELEASE_MANIFEST_NAME),
    Buffer.from(manifestText(manifest), 'utf8'),
  );
  io.stdout(
    `${JSON.stringify({ command: 'manifest', id: a.id, version: a.version, entries: entries.length })}\n`,
  );
}

// ---- sums -------------------------------------------------------------------------------------------------

/** Re-hashes every entry of the manifest and writes SHA256SUMS. A file that no longer matches is an error. */
export async function sumsCommand(a: { dir: string }, io: ToolIO): Promise<void> {
  await requireDirectory(a.dir);
  await listRegularMembers(a.dir);
  const manifest = await readManifestFile(a.dir);
  for (const e of manifest.entries) {
    const { sha256, size } = await hashRegularFile(join(a.dir, e.id));
    if (size !== e.size)
      throw new Error(`artifact_size_mismatch: ${e.id} no longer has the size in the manifest`);
    if (sha256 !== e.sha256)
      throw new Error(`artifact_hash_mismatch: ${e.id} no longer matches the manifest`);
  }
  await writeRegularFile(
    join(a.dir, SHA256SUMS_NAME),
    Buffer.from(sumsText(manifest.entries), 'latin1'),
  );
  io.stdout(`${JSON.stringify({ command: 'sums', entries: manifest.entries.length })}\n`);
}

// ---- sign -------------------------------------------------------------------------------------------------

/** Signs a -rehearsal manifest with the published RFC 8032 TEST 1 key. The only key the tool can sign with. */
export async function signCommand(
  a: { dir: string; testKey: string | undefined },
  io: ToolIO,
): Promise<void> {
  if (a.testKey !== REHEARSAL_TEST_KEY_NAME)
    throw stop(
      'test_key_flag_misuse',
      `--test-key must be ${REHEARSAL_TEST_KEY_NAME}: the tool signs rehearsals with that published key and with nothing else`,
    );
  await requireDirectory(a.dir);
  // the same member check as manifest and sums: a link, a subdirectory, a FIFO, listed or extra, is not_regular_file
  await listRegularMembers(a.dir);
  const manifest = await readManifestFile(a.dir);
  // R1: a test key never signs a release id (and a manifest of any other id is not a rehearsal either)
  if (!REHEARSAL_ID_PATTERN.test(manifest.id))
    throw stop(
      'test_key_release_id',
      'refusing to sign a release id with a published RFC 8032 test key',
    );
  if (manifest.signatures.length > 0)
    throw stop('already_signed', 'the manifest already has a signature');
  if (manifest.publisher !== REHEARSAL_PUBLISHER)
    throw stop('publisher_mismatch', 'a rehearsal manifest carries the rehearsal publisher');
  const signed: Manifest = { ...manifest, signatures: [signWithTestKey1(manifest)] };
  await writeRegularFile(
    join(a.dir, RELEASE_MANIFEST_NAME),
    Buffer.from(manifestText(signed), 'utf8'),
  );
  io.stderr(`${TEST_KEY_SIGN_BANNER}\n`);
  io.stdout(`${JSON.stringify({ command: 'sign', id: signed.id, keyId: TEST1_KEY_ID })}\n`);
}

// ---- verify -----------------------------------------------------------------------------------------------

export interface VerifyArgs {
  dir: string;
  expectId: string | undefined;
  trustFile: string | undefined;
  trustTestKey: boolean;
  allowTestKey: boolean;
  /** Epoch milliseconds, already parsed by cli.ts. */
  now: number | undefined;
}

/**
 * The checks that run after verifyManifest accepted the manifest:
 *  (a) a signature of an RFC 8032 test key on an id that is not a rehearsal id is `test_key_release_id` (unreachable
 *      from the command line, because --trust-test-key needs a rehearsal --expect-id and a trust file cannot hold a
 *      test key, but a defence that stays tested), then
 *  (b) for any key, the publisher must match the id suffix, otherwise `publisher_mismatch`.
 * `validKeys` are the keys of the signatures that verified.
 */
export function postVerifyChecks(
  manifest: Pick<Manifest, 'id' | 'publisher'>,
  validKeys: readonly { keyId: string; raw: Uint8Array }[],
): 'test_key_release_id' | 'publisher_mismatch' | undefined {
  if (
    validKeys.some((k) => isRfc8032TestKey(k.keyId, k.raw)) &&
    !REHEARSAL_ID_PATTERN.test(manifest.id)
  )
    return 'test_key_release_id';
  const expected = RELEASE_ID_PATTERN.test(manifest.id)
    ? RELEASE_PUBLISHER
    : REHEARSAL_ID_PATTERN.test(manifest.id)
      ? REHEARSAL_PUBLISHER
      : undefined;
  if (manifest.publisher !== expected) return 'publisher_mismatch';
  return undefined;
}

/** Verifies a release directory against a trust source and the id the caller expects. See MANIFEST.md, Verify. */
export async function verifyCommand(a: VerifyArgs, io: ToolIO): Promise<void> {
  // 0. usage
  if (a.expectId === undefined)
    throw stop(
      'expect_id_required',
      '--expect-id is required: say which manifest id this verification expects',
    );
  if ((a.trustFile !== undefined) === a.trustTestKey)
    throw stop('bad_trust_source', 'give exactly one of --trust-file and --trust-test-key');
  const rehearsalId = REHEARSAL_ID_PATTERN.test(a.expectId);
  if ((a.allowTestKey || a.trustTestKey) && !rehearsalId)
    throw stop(
      'test_key_flag_misuse',
      '--trust-test-key and --allow-test-key are for a rehearsal id (<package>-rehearsal) only',
    );
  if (a.allowTestKey && a.trustFile !== undefined)
    throw stop('test_key_flag_misuse', '--allow-test-key cannot be combined with --trust-file');
  if (!rehearsalId && !RELEASE_ID_PATTERN.test(a.expectId))
    throw stop('bad_release_id', '--expect-id must be <package>-release or <package>-rehearsal');
  await requireDirectory(a.dir);

  // 1. the two files
  const manifestPath = join(a.dir, RELEASE_MANIFEST_NAME);
  const sumsPath = join(a.dir, SHA256SUMS_NAME);
  const mSt = await lstatOrUndefined(manifestPath);
  if (mSt === undefined) throw stop('manifest_missing', `${RELEASE_MANIFEST_NAME} is missing`);
  const sSt = await lstatOrUndefined(sumsPath);
  if (sSt === undefined) throw stop('sums_missing', `${SHA256SUMS_NAME} is missing`);
  if (!isRegular(mSt) || !isRegular(sSt))
    throw stop(
      'not_regular_file',
      `${RELEASE_MANIFEST_NAME} and ${SHA256SUMS_NAME} must be regular files`,
    );

  // 2. the trust source
  let trust: TrustSet;
  if (a.trustTestKey) trust = new Map([[TEST1_KEY_ID, TEST1_PUBLIC]]);
  else {
    const keysText = (await readRegularFile(a.trustFile!, MAX_SMALL_FILE)).toString('utf8');
    trust = new Map(parseReleaseKeys(keysText).map((k) => [k.keyId, k.raw]));
  }

  // 3. the manifest: every manifest reason passes through unchanged. A fresh in-memory state: no run remembers another.
  const text = (await readRegularFile(manifestPath, MAX_SMALL_FILE)).toString('utf8');
  let result;
  try {
    result = await verifyManifest(text, trust, {
      expectId: a.expectId,
      allowTestKeys: a.allowTestKey,
      state: new InMemoryManifestState(),
      ...(a.now !== undefined ? { now: a.now } : {}),
    });
  } catch (e) {
    if (e instanceof ManifestError) throw stop(e.reason, e.message);
    throw e;
  }
  if (!result.ok) throw stop(result.reason, `the manifest was refused: ${result.reason}`);
  const manifest = result.manifest;

  // 4. after acceptance
  const validKeys = result.signatures
    .filter((s) => s.valid)
    .map((s) => ({ keyId: s.keyId, raw: trust.get(s.keyId) as Uint8Array }));
  const post = postVerifyChecks(manifest, validKeys);
  if (post === 'test_key_release_id')
    throw stop(post, 'a published RFC 8032 test key verified a manifest that is not a rehearsal');
  if (post === 'publisher_mismatch')
    throw stop(post, 'the publisher does not match the id suffix (-release or -rehearsal)');

  // 5. the members: any non-regular member, then every entry in order, then anything extra
  const names = await listRegularMembers(a.dir);
  const wanted = new Set<string>();
  for (const e of manifest.entries) {
    wanted.add(e.id);
    if (e.url !== e.id)
      throw stop(
        'artifact_missing',
        `entry ${e.id} has a url that is not its file name; release entries use the basename`,
      );
    if (!names.includes(e.id))
      throw stop(
        'artifact_missing',
        `${e.id} is listed in the manifest and is not in the directory`,
      );
    const st = await lstatOrUndefined(join(a.dir, e.id));
    if (st === undefined) throw stop('artifact_missing', `${e.id} is not in the directory`);
    if (st.size !== BigInt(e.size))
      throw stop('artifact_size_mismatch', `${e.id} does not have the size in the manifest`);
    const { sha256 } = await hashRegularFile(join(a.dir, e.id));
    if (sha256 !== e.sha256)
      throw stop('artifact_hash_mismatch', `${e.id} does not match its sha256 in the manifest`);
  }
  for (const n of names)
    if (n !== RELEASE_MANIFEST_NAME && n !== SHA256SUMS_NAME && !wanted.has(n))
      throw stop('artifact_extra', `${n} is in the directory and not in the manifest`);

  // 6. SHA256SUMS, byte for byte
  const sums = await readRegularFile(sumsPath, MAX_SMALL_FILE);
  if (!sums.equals(Buffer.from(sumsText(manifest.entries), 'latin1')))
    throw stop('sums_mismatch', `${SHA256SUMS_NAME} is not what the manifest entries give`);

  const testKey = validKeys.some((k) => isRfc8032TestKey(k.keyId, k.raw));
  io.stdout(
    `${JSON.stringify({ verdict: 'ok', id: manifest.id, version: manifest.version, entries: manifest.entries.length, testKey })}\n`,
  );
  if (testKey) io.stderr(`${TEST_KEY_VERIFY_BANNER}\n`);
}
