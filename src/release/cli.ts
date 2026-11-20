/**
 * Command line of the release tool: `manifest`, `sums`, `sign` and `verify` (manifest 0.1.4, "Release manifests").
 *
 * Exit codes: 0 accepted, 1 an I/O error (never a refusal), 2 a usage error, 3 refused. A refusal prints
 * `{"verdict":"refused","reason":"<reason>"}` on stdout and `refused: <reason>` as the FIRST line of stderr; a usage
 * error prints `usage: <token>: <message>` on stderr and nothing on stdout. Every option is a command-line option:
 * R3, the flags that allow a test key (`--allow-test-key`, `--trust-test-key`) are never read from anywhere else, and
 * there is deliberately no option that reads a key.
 */

import { isCalendarValidRfc3339, ManifestError } from '../manifest';
import { RELEASE_EXIT, RELEASE_USAGE_SYNTAX_TOKEN } from '../../spec/release';
import { ReleaseStop } from './fsutil';
import {
  classify,
  manifestCommand,
  signCommand,
  sumsCommand,
  verifyCommand,
  type ToolIO,
} from './tool';

/** What a run may be told besides its arguments. `sourceDateEpoch` is the value of SOURCE_DATE_EPOCH, if set. */
export interface CliEnv {
  sourceDateEpoch?: string | undefined;
}

const VALUE_OPTIONS = {
  manifest: ['--dir', '--id', '--version', '--licence', '--publisher'],
  sums: ['--dir'],
  sign: ['--dir', '--test-key'],
  verify: ['--dir', '--expect-id', '--trust-file', '--now'],
} as const;
const FLAG_OPTIONS = {
  manifest: [],
  sums: [],
  sign: [],
  verify: ['--allow-test-key', '--trust-test-key'],
} as const;

type Command = keyof typeof VALUE_OPTIONS;
const isCommand = (c: string | undefined): c is Command =>
  c !== undefined && Object.prototype.hasOwnProperty.call(VALUE_OPTIONS, c);

const syntax = (message: string): ReleaseStop =>
  new ReleaseStop(RELEASE_USAGE_SYNTAX_TOKEN, message);

interface Parsed {
  values: Map<string, string>;
  flags: Set<string>;
}

/** Strict option parsing: only the options of the command, each at most once, a value never looks like an option. */
function parseOptions(command: Command, argv: readonly string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOpts: readonly string[] = VALUE_OPTIONS[command];
  const flagOpts: readonly string[] = FLAG_OPTIONS[command];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (flagOpts.includes(a)) {
      if (flags.has(a)) throw syntax(`${a} is given twice`);
      flags.add(a);
    } else if (valueOpts.includes(a)) {
      if (values.has(a)) throw syntax(`${a} is given twice`);
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw syntax(`${a} needs a value`);
      values.set(a, v);
    } else {
      throw syntax(`unknown option or argument ${JSON.stringify(a)} for ${command}`);
    }
  }
  return { values, flags };
}

const need = (p: Parsed, name: string): string => {
  const v = p.values.get(name);
  if (v === undefined) throw syntax(`${name} is required`);
  return v;
};

const USAGE_TEXT =
  'release-tool <manifest|sums|sign|verify> --dir <dir> [options]; see spec/tools/README.md';

/** Runs one command line. Never throws; returns the exit code. */
export async function runCli(
  argv: readonly string[],
  io: ToolIO,
  env: CliEnv = {},
): Promise<number> {
  const command = argv[0];
  try {
    if (!isCommand(command)) throw syntax(`unknown or missing command; ${USAGE_TEXT}`);
    const p = parseOptions(command, argv.slice(1));
    const dir = need(p, '--dir');
    switch (command) {
      case 'manifest':
        await manifestCommand(
          {
            dir,
            id: need(p, '--id'),
            version: need(p, '--version'),
            licence: need(p, '--licence'),
            publisher: need(p, '--publisher'),
            sourceDateEpoch: env.sourceDateEpoch,
          },
          io,
        );
        break;
      case 'sums':
        await sumsCommand({ dir }, io);
        break;
      case 'sign':
        await signCommand({ dir, testKey: p.values.get('--test-key') }, io);
        break;
      case 'verify': {
        const nowText = p.values.get('--now');
        if (nowText !== undefined && !isCalendarValidRfc3339(nowText))
          throw syntax('--now must be a calendar-valid RFC 3339 UTC time, YYYY-MM-DDTHH:MM:SSZ');
        await verifyCommand(
          {
            dir,
            expectId: p.values.get('--expect-id'),
            trustFile: p.values.get('--trust-file'),
            trustTestKey: p.flags.has('--trust-test-key'),
            allowTestKey: p.flags.has('--allow-test-key'),
            now: nowText === undefined ? undefined : Date.parse(nowText),
          },
          io,
        );
        break;
      }
    }
    return RELEASE_EXIT.ok;
  } catch (e) {
    return report(command ?? '', e, io);
  }
}

function report(command: string, e: unknown, io: ToolIO): number {
  let token: string | undefined;
  let message = '';
  if (e instanceof ReleaseStop) {
    token = e.token;
    message = e.message;
  } else if (e instanceof ManifestError && command === 'verify') {
    token = e.reason;
    message = e.message;
  }
  if (token !== undefined) {
    if (classify(command, token) === 'usage') {
      io.stderr(`usage: ${token}: ${message}\n`);
      return RELEASE_EXIT.usage;
    }
    io.stderr(`refused: ${token}\n${message}\n`);
    io.stdout(`${JSON.stringify({ verdict: 'refused', reason: token })}\n`);
    return RELEASE_EXIT.refused;
  }
  // anything else is an I/O error or a crash: exit 1, never a refusal
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  const text = e instanceof Error ? e.message : String(e);
  io.stderr(`error: ${code ? `${code}: ` : ''}${text}\n`);
  return RELEASE_EXIT.io;
}
