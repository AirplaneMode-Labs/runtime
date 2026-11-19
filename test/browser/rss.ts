// The peak memory of a test Chrome (TD-49): the sum of the resident set size of the browser process and
// every process below it (GPU, utility, renderer), sampled from `ps` every 250 ms on macOS and Linux. The
// browser process is found by the --user-data-dir of the profile the test launched Chrome with, so another
// Chrome on the machine is never counted. This is the figure called "peak memory" in READMEs and benchmark
// rows; the wasm memory and the JS heap are reported only under their own names. Not measured on 8 GB.
// (On Windows the owner runbook samples WorkingSetSize through PowerShell instead; this file is not used there.)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface RssSample {
  peakBytes: number;
  samples: number;
  processes: number;
}

export function parsePs(text: string, profileDir: string): { bytes: number; processes: number } {
  const rows = new Map<number, { ppid: number; rssKb: number; command: string }>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), rssKb: Number(m[3]), command: m[4]! });
  }
  const needle = `--user-data-dir=${profileDir}`;
  const members = new Set<number>();
  for (const [pid, r] of rows) if (r.command.includes(needle)) members.add(pid);
  // descendants: repeat until no new process whose parent is a member appears
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, r] of rows)
      if (!members.has(pid) && members.has(r.ppid)) {
        members.add(pid);
        grew = true;
      }
  }
  let kb = 0;
  for (const pid of members) kb += rows.get(pid)!.rssKb;
  return { bytes: kb * 1024, processes: members.size };
}

async function readPs(): Promise<string> {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * One reading of the tree right now (not a peak): the figure before and after an unload (Sprint 6 B1). macOS and
 * Linux only (it reads `ps`); `readPsText` lets a test hand it a process table, so the unit test runs on every OS.
 */
export async function sampleOnce(
  profileDir: string,
  readPsText: () => Promise<string> = readPs,
): Promise<{ bytes: number; processes: number }> {
  return parsePs(await readPsText(), profileDir);
}

export function startRssSampler(
  profileDir: string,
  intervalMs = 250,
): { stop(): Promise<RssSample> } {
  let peak = 0;
  let samples = 0;
  let processes = 0;
  let busy = false;
  const take = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], {
        maxBuffer: 64 * 1024 * 1024,
      });
      const r = parsePs(stdout, profileDir);
      samples++;
      if (r.bytes > peak) {
        peak = r.bytes;
        processes = r.processes;
      }
    } catch {
      // a failed sample is a missing sample, never a made-up figure
    } finally {
      busy = false;
    }
  };
  void take();
  const timer = setInterval(() => void take(), intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await take();
      return { peakBytes: peak, samples, processes };
    },
  };
}
