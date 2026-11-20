// Preload for the release-tool race test (POSIX only). After the tool's Nth lstat of AMT_SWAP_TARGET returns, the
// file is replaced exactly once by a FIFO (mkfifo), i.e. between the lstat and the open. Modelled on the T2 hook.
// Environment: AMT_SWAP_TARGET (absolute path), AMT_SWAP_NTH (default 1), AMT_SWAP_MARK (a file written when swapped).
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const target = process.env.AMT_SWAP_TARGET;
const nth = Number(process.env.AMT_SWAP_NTH || 1);
const mark = process.env.AMT_SWAP_MARK;
let n = 0;
let done = false;
const orig = fsp.lstat;
fsp.lstat = async function (p, ...rest) {
  const r = await orig.call(this, p, ...rest);
  if (String(p) === target) n++;
  if (!done && String(p) === target && n === nth) {
    done = true;
    fs.unlinkSync(target);
    execFileSync('mkfifo', [target]);
    fs.writeFileSync(mark, 'swapped\n');
  }
  return r;
};
syncBuiltinESMExports();
