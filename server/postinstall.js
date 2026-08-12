#!/usr/bin/env node
/**
 * Repair node-pty's prebuilt `spawn-helper` permissions.
 *
 * node-pty ships its darwin prebuilds with mode 0644 on `spawn-helper`, the
 * small binary it execs to set up the child's controlling terminal. Without the
 * execute bit every pty.spawn() fails with a bare "posix_spawnp failed", which
 * looks like a broken native module rather than a permission problem.
 *
 * This runs on every install so a fresh `npm install` works on a clean machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const prebuilds = path.join(here, '..', 'node_modules', 'node-pty', 'prebuilds');

let fixed = 0;
let checked = 0;

try {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (!fs.existsSync(helper)) continue;
    checked += 1;
    const mode = fs.statSync(helper).mode;
    if ((mode & 0o111) === 0) {
      fs.chmodSync(helper, 0o755);
      fixed += 1;
      process.stdout.write(`node-pty: made ${dir}/spawn-helper executable\n`);
    }
  }
  if (checked === 0) {
    process.stdout.write('node-pty: no spawn-helper found (fine on Windows-only installs)\n');
  } else if (fixed === 0) {
    process.stdout.write('node-pty: spawn-helper permissions already correct\n');
  }
} catch (err) {
  // Never fail the install over this; the server surfaces a clear error later.
  process.stdout.write(`node-pty: could not check spawn-helper permissions (${err.message})\n`);
}
