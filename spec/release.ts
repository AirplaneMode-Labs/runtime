/**
 * Release manifests (manifest 0.1.4, spec release 0.6.1; normative prose: MANIFEST.md, "Release manifests").
 *
 * A release manifest is an ordinary manifest (wire string `airplanemode.manifest/0.1`, schema body unchanged)
 * that lists the artefacts of one package release, and a rehearsal manifest is the same document signed with a
 * published RFC 8032 test key to prove the release path in CI. This file holds the constants and types every
 * implementation shares: runtime's own reference tool (spec/tools/release-tool.mjs, built from src/release/),
 * control-plane's cp-sign, and the vendored copies in pagetriage, glyphsift and localdata.
 *
 * The rules (MANIFEST.md, "Release manifests"):
 *  - R1: an RFC 8032 test key never signs an id that matches RELEASE_ID_PATTERN.
 *  - R2: a release verification never allows test keys, and `--expect-id` is mandatory.
 *  - R3: the allow flag exists only on the command line: never the environment, a manifest, a URL, a file or
 *    stored state.
 *  - R4 (S1-127): a release key signs only -release ids and is never placed in an application trust set.
 *  - R5 (TD-121): release manifests carry no expiresAt.
 *
 * Both patterns use `$` without the `m` flag. In JavaScript that matches only at the very end of the input
 * ('x-release\n' does not match); an implementation in another language MUST give the same answer for that
 * input (Rust: `\z`, never `$`). spec/vectors/release/ids.json is the shared table.
 */

/** The packages that publish releases, in release order. Each id gives `<id>-release` and `<id>-rehearsal`. */
export const PACKAGE_IDS = Object.freeze([
  'runtime',
  'localdata',
  'glyphsift',
  'pagetriage',
  'control-plane',
] as const);
export type PackageId = (typeof PACKAGE_IDS)[number];

/** The manifest id of a real release: `<package>-release`. 127 characters at most, the manifest id limit. */
export const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,118}-release$/;

/** The manifest id of a rehearsal: `<package>-rehearsal`. The only id a test key may sign. */
export const REHEARSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,116}-rehearsal$/;

/** `publisher` of a -release manifest. */
export const RELEASE_PUBLISHER = 'Airplane Mode Labs' as const;

/** `publisher` of a -rehearsal manifest. */
export const REHEARSAL_PUBLISHER =
  'Airplane Mode Labs REHEARSAL: signed with the published RFC 8032 test key; not a release' as const;

/** `spec` of docs/release-keys.json, the owner's list of release public keys in each repo. */
export const RELEASE_KEYS_SPEC = 'airplanemode.release-keys/0.1' as const;
/** At most this many keys in a release-keys file; more is `bad_release_keys`. */
export const RELEASE_KEYS_MAX = 8;

/** The release-keys file: exactly the members `spec` and `keys`, each key exactly `keyId` and `publicKey`. */
export interface ReleaseKeysFile {
  spec: typeof RELEASE_KEYS_SPEC;
  keys: { keyId: string; publicKey: string }[];
}

/** File name of the checksum list (artefacts only, never the manifest itself). */
export const SHA256SUMS_NAME = 'SHA256SUMS' as const;
/** File name of the release manifest inside the release directory. */
export const RELEASE_MANIFEST_NAME = 'release-manifest.json' as const;
/** The sibling directory of the release directory that receives reports. Never inside the release directory. */
export const RELEASE_REPORT_DIR = 'dist-release-report' as const;

/** The only `--test-key` value any release tool accepts. */
export const REHEARSAL_TEST_KEY_NAME = 'rfc8032-1' as const;

/** First stderr line (besides the verdict) of every test-key signing, in every implementation. */
export const TEST_KEY_SIGN_BANNER =
  'TEST KEY SIGNATURE (RFC 8032 TEST 1, published): rehearsal only, NOT A RELEASE' as const;
/** Stderr line of a verification that was accepted by a published test key. */
export const TEST_KEY_VERIFY_BANNER =
  'VERIFIED WITH THE PUBLISHED RFC 8032 TEST KEY: rehearsal only, not a release' as const;
/** The cp-sign stderr line (exit 1) for signing a release id with a test key: `<token>: <this text>`. */
export const TEST_KEY_RELEASE_ID_MESSAGE =
  'refusing to sign a release id with a published RFC 8032 test key' as const;

/**
 * Reasons `verify` refuses (exit 3). The first stderr line is `refused: <reason>` and stdout is
 * `{"verdict":"refused","reason":"<reason>"}`. Manifest-level reasons (ManifestRejectReason, including
 * test_key_refused and weak_key_refused) pass through unchanged and are not repeated here.
 */
export const RELEASE_REJECT_REASONS = Object.freeze([
  'manifest_missing',
  'sums_missing',
  'not_regular_file',
  'bad_release_keys',
  'no_trusted_key',
  'test_key_release_id',
  'publisher_mismatch',
  'artifact_missing',
  'artifact_extra',
  'artifact_size_mismatch',
  'artifact_hash_mismatch',
  'sums_mismatch',
] as const);
export type ReleaseRejectReason = (typeof RELEASE_REJECT_REASONS)[number];

/**
 * Tokens of a usage error (exit 2): `usage: <token>: <message>` on stderr, nothing on stdout. A usage error is
 * a mistake in the command, not a verdict on an artefact. test_key_release_id, not_regular_file and
 * publisher_mismatch also exist as verify reasons (exit 3); which exit code applies depends on the command.
 */
export const RELEASE_USAGE_REASONS = Object.freeze([
  'expect_id_required',
  'test_key_flag_misuse',
  'test_key_release_id',
  'bad_release_id',
  'bad_artifact_name',
  'not_regular_file',
  'publisher_mismatch',
  'already_signed',
  'bad_trust_source',
] as const);
export type ReleaseUsageReason = (typeof RELEASE_USAGE_REASONS)[number];

/**
 * The token of a command-line syntax error (an unknown command or option, a repeated or missing option, a
 * malformed value). It is a usage error (exit 2) and deliberately not a member of RELEASE_USAGE_REASONS: it
 * says nothing about releases.
 */
export const RELEASE_USAGE_SYNTAX_TOKEN = 'bad_arguments' as const;

/** Exit codes of a release tool. An I/O error (1) is never a refusal. */
export const RELEASE_EXIT = Object.freeze({
  ok: 0,
  io: 1,
  usage: 2,
  refused: 3,
} as const);

/** `mediaType` of an entry, by file name suffix (longest suffix first); anything else is the default. */
export const RELEASE_MEDIA_TYPES: readonly (readonly [suffix: string, mediaType: string])[] =
  Object.freeze([
    ['.tar.gz', 'application/gzip'],
    ['.tgz', 'application/gzip'],
    ['.crate', 'application/gzip'],
    ['.whl', 'application/zip'],
    ['.zip', 'application/zip'],
  ] as const);
export const RELEASE_DEFAULT_MEDIA_TYPE = 'application/octet-stream' as const;

/** The grammar of an entry id, and therefore of an artefact file name (already lowercase). */
export const RELEASE_ARTIFACT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** Largest SOURCE_DATE_EPOCH (9999-12-31T23:59:59Z) a release tool accepts for createdAt. */
export const RELEASE_SOURCE_DATE_EPOCH_MAX = 253402300799;
