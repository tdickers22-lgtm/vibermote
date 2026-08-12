#!/usr/bin/env node
/**
 * `npm run health` — query a running server using the local token file.
 * Handy for confirming the bind address and Tailscale state without pasting
 * the token into a curl command (where it would land in shell history).
 */
import fs from 'node:fs';
import { TOKEN_PATH, PORT } from './config.js';
import { resolveBindAddress } from './net.js';

async function main() {
  let token;
  try {
    token = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    process.stderr.write(`no token at ${TOKEN_PATH} — start the server once to generate it\n`);
    process.exit(1);
  }

  let host;
  try {
    host = process.env.CCR_HOST || resolveBindAddress().host;
  } catch {
    host = '127.0.0.1';
  }

  const url = `http://${host}:${PORT}/api/health`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`could not reach ${url}: ${err.message}\n`);
    process.exit(1);
  }
}

main();
