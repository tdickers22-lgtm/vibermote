/**
 * Bind-address resolution.
 *
 * Hard rule: this server must never be reachable from the public internet.
 * We bind to the Tailscale interface address (100.64.0.0/10, the CGNAT range
 * Tailscale assigns) when it exists, and otherwise to loopback. 0.0.0.0 is
 * rejected even when explicitly requested.
 */
import os from 'node:os';
import { HOST_OVERRIDE } from './config.js';
import { log } from './util.js';

const WILDCARD = new Set(['0.0.0.0', '::', '*', '']);

/** True for IPv4 addresses inside 100.64.0.0/10 (Tailscale's CGNAT range). */
export function isTailscaleIPv4(addr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr || '');
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  // 100.64.0.0/10 spans second octets 64..127.
  return a === 100 && b >= 64 && b <= 127;
}

/** Find the machine's Tailscale IPv4, or null if Tailscale is not up. */
export function findTailscaleIP() {
  const ifaces = os.networkInterfaces();
  // Prefer the conventional utun/tailscale interfaces, but accept any match.
  const names = Object.keys(ifaces).sort((a, b) => {
    const score = (n) => (/^tailscale/i.test(n) ? 0 : /^utun/i.test(n) ? 1 : 2);
    return score(a) - score(b);
  });

  for (const name of names) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal && isTailscaleIPv4(info.address)) {
        return { ip: info.address, iface: name };
      }
    }
  }
  return null;
}

/**
 * Decide what to bind to.
 * @returns {{host: string, reason: string, tailscaleIP: string|null, iface: string|null}}
 */
export function resolveBindAddress() {
  const ts = findTailscaleIP();

  if (HOST_OVERRIDE) {
    if (WILDCARD.has(HOST_OVERRIDE)) {
      throw new Error(
        `refusing to bind to "${HOST_OVERRIDE}" — that exposes a shell to every network ` +
          `this machine is on. Use a Tailscale address or 127.0.0.1.`,
      );
    }
    const loopback = HOST_OVERRIDE === '127.0.0.1' || HOST_OVERRIDE === '::1' || HOST_OVERRIDE === 'localhost';
    if (!loopback && !isTailscaleIPv4(HOST_OVERRIDE)) {
      throw new Error(
        `refusing to bind to "${HOST_OVERRIDE}" — only loopback or a Tailscale ` +
          `(100.64.0.0/10) address is allowed.`,
      );
    }
    return {
      host: HOST_OVERRIDE,
      reason: 'CCR_HOST override',
      tailscaleIP: ts?.ip ?? null,
      iface: ts?.iface ?? null,
    };
  }

  if (ts) {
    return { host: ts.ip, reason: `tailscale interface ${ts.iface}`, tailscaleIP: ts.ip, iface: ts.iface };
  }

  log.warn(
    'Tailscale interface not found — binding to 127.0.0.1. The phone will not be able ' +
      'to reach this server until Tailscale is up; re-run after `tailscale up`.',
  );
  return { host: '127.0.0.1', reason: 'loopback fallback (no tailscale)', tailscaleIP: null, iface: null };
}
