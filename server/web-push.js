/**
 * Web Push protocol: RFC 8291 payload encryption, RFC 8292 VAPID, RFC 8030 POST.
 *
 * Implemented directly on node:crypto rather than pulling in the `web-push`
 * package. The whole protocol is three HKDF calls, one ECDH, one AES-128-GCM
 * record and one ES256 JWT — all primitives Node 20 ships — and this server has
 * kept its dependency list to node-pty and ws deliberately, because everything
 * here runs unattended under launchd on the user's own machine.
 *
 * "Do not half-implement encryption and hope" — so it is checked against the
 * published test vectors rather than against a round trip with itself:
 *
 *   RFC 8188 §3.1  the aes128gcm record layer (header framing, CEK/NONCE
 *                  derivation, padding delimiter, GCM tag) reproduces byte for
 *                  byte from a known salt and IKM.
 *   RFC 8291 §5    the key agreement (ECDH secret, PRK_key, IKM, PRK, CEK,
 *                  NONCE) reproduces byte for byte from the RFC's fixed keys.
 *
 * `npm run test:push` runs both, plus an end-to-end send through a local
 * receiver that decrypts what this module produced. See scripts/push-selftest.mjs.
 *
 * This module is pure protocol: it never touches the filesystem and holds no
 * state. Key persistence and the subscription store live in push.js.
 */
import crypto from 'node:crypto';
import { PUSH_TTL_SECONDS } from './config.js';

const CURVE = 'prime256v1'; // P-256, the only curve Web Push defines

/** Uncompressed P-256 point: 0x04 || X(32) || Y(32). */
const PUBLIC_KEY_BYTES = 65;

/**
 * Largest plaintext we will encrypt. Push services cap the *encrypted* body at
 * 4096 bytes; the header is 86 bytes and GCM adds a delimiter and a 16-byte tag.
 * Notification payloads here are a couple of hundred bytes, so this bound only
 * ever fires on a programming mistake.
 */
export const MAX_PAYLOAD_BYTES = 3800;

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (value) => Buffer.from(String(value), 'base64url');

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * HKDF-SHA256 with a single expand block.
 *
 * Every output Web Push needs is at most 32 bytes, so the counter never leaves
 * 0x01 and the iteration in the general algorithm would be dead code. Returns
 * the intermediate PRK too, because the test vectors assert on it.
 */
function hkdf(salt, ikm, info, length) {
  if (length > 32) throw new Error('hkdf: this single-block form tops out at 32 bytes');
  const prk = hmac(salt, ikm);
  const okm = hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])]));
  return { prk, okm: okm.subarray(0, length) };
}

/**
 * Encrypt one push payload into a complete aes128gcm body (RFC 8291 + RFC 8188).
 *
 * `salt` and `serverKeys` are injectable only so the self-test can drive the
 * RFC's fixed values through the exact code path production uses; leaving them
 * out generates fresh random ones per message, which is what RFC 8291 requires
 * (a reused salt with a reused key would repeat a GCM nonce).
 *
 * @param {object}  opts
 * @param {string}  opts.p256dh   subscriber public key, base64url (65 bytes)
 * @param {string}  opts.auth     subscriber auth secret, base64url (16 bytes)
 * @param {string|Buffer} opts.payload  the plaintext to encrypt
 * @returns {{body: Buffer, salt: Buffer, serverPublicKey: Buffer}}
 */
export function encryptPayload({ p256dh, auth, payload, salt, serverKeys } = {}) {
  const uaPublic = Buffer.isBuffer(p256dh) ? p256dh : unb64u(p256dh);
  const authSecret = Buffer.isBuffer(auth) ? auth : unb64u(auth);

  if (uaPublic.length !== PUBLIC_KEY_BYTES || uaPublic[0] !== 0x04) {
    throw new Error(`subscription p256dh must be a ${PUBLIC_KEY_BYTES}-byte uncompressed P-256 point`);
  }
  if (authSecret.length !== 16) {
    throw new Error('subscription auth secret must be 16 bytes');
  }

  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`push payload is ${plaintext.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }

  // The ephemeral sender keypair. One per message: RFC 8291 §3.1.
  const ecdh = crypto.createECDH(CURVE);
  let asPublic;
  if (serverKeys) {
    ecdh.setPrivateKey(Buffer.isBuffer(serverKeys.privateKey) ? serverKeys.privateKey : unb64u(serverKeys.privateKey));
    asPublic = Buffer.isBuffer(serverKeys.publicKey) ? serverKeys.publicKey : unb64u(serverKeys.publicKey);
  } else {
    ecdh.generateKeys();
    asPublic = ecdh.getPublicKey();
  }

  const recordSalt = salt
    ? (Buffer.isBuffer(salt) ? salt : unb64u(salt))
    : crypto.randomBytes(16);
  if (recordSalt.length !== 16) throw new Error('record salt must be 16 bytes');

  const sharedSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.4: mix the shared secret with the subscription's auth secret so
  // that knowing the ECDH result alone is not enough to decrypt.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const { prk: prkKey, okm: ikm } = hkdf(authSecret, sharedSecret, keyInfo, 32);

  // RFC 8188 §2.2: content encryption key and nonce for record sequence 0.
  const { prk, okm: cek } = hkdf(recordSalt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const { okm: nonce } = hkdf(recordSalt, ikm, 'Content-Encoding: nonce\0', 12);

  // One record, so the padding delimiter is 0x02 ("last record") rather than 0x01.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // Header: salt(16) || record size(4, BE) || key id length(1) || key id.
  // The key id is the sender's ephemeral public key, which is how the browser
  // knows which point to run its own ECDH against.
  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  recordSalt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return {
    body: Buffer.concat([header, ciphertext]),
    salt: recordSalt,
    serverPublicKey: asPublic,
    // Intermediates, asserted on by the RFC 8291 §5 vector in the self-test.
    derived: { sharedSecret, prkKey, ikm, prk, cek, nonce },
  };
}

/**
 * Decrypt an aes128gcm body. Not used in production — the browser does this —
 * but the self-test needs it to prove that what we put on the wire is what the
 * phone will read back out, so it lives beside the encryptor it mirrors.
 */
export function decryptPayload({ body, privateKey, publicKey, auth }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const recordSalt = buf.subarray(0, 16);
  const idLen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idLen);
  const ciphertext = buf.subarray(21 + idLen);

  const ecdh = crypto.createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.isBuffer(privateKey) ? privateKey : unb64u(privateKey));
  const uaPublic = Buffer.isBuffer(publicKey) ? publicKey : unb64u(publicKey);
  const authSecret = Buffer.isBuffer(auth) ? auth : unb64u(auth);

  const sharedSecret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const { okm: ikm } = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const { okm: cek } = hkdf(recordSalt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const { okm: nonce } = hkdf(recordSalt, ikm, 'Content-Encoding: nonce\0', 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);

  // Strip the padding delimiter (0x02 for the last record) and any zero padding.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (end < 0 || (padded[end] !== 1 && padded[end] !== 2)) {
    throw new Error('decrypt: missing record padding delimiter');
  }
  return padded.subarray(0, end).toString('utf8');
}

/* ------------------------------------------------------------------ *
 * VAPID (RFC 8292)
 * ------------------------------------------------------------------ */

/** Generate a VAPID keypair in the base64url form browsers and push services use. */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKey: b64u(ecdh.getPublicKey()),   // 65 bytes, uncompressed
    privateKey: b64u(ecdh.getPrivateKey().length === 32
      ? ecdh.getPrivateKey()
      // Node can hand back a short scalar when the leading byte is zero; pad it
      // so the JWK `d` is always the fixed 32 bytes P-256 requires.
      : Buffer.concat([Buffer.alloc(32 - ecdh.getPrivateKey().length), ecdh.getPrivateKey()])),
  };
}

/** Rebuild a signing key from the stored base64url scalar and point. */
function privateKeyObject({ publicKey, privateKey }) {
  const point = unb64u(publicKey);
  if (point.length !== PUBLIC_KEY_BYTES || point[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
      d: privateKey,
    },
    format: 'jwk',
  });
}

/**
 * Sign a VAPID JWT for one push service origin.
 *
 * ES256 signatures on the wire are the raw R||S pair, not the DER sequence
 * Node produces by default — hence `dsaEncoding: 'ieee-p1363'`. A DER signature
 * here is the classic silent failure: it is a perfectly valid ECDSA signature
 * that every push service rejects with a bare 401.
 */
export function signVapidToken({ audience, subject, keys, expiresInSeconds = 12 * 3600 }) {
  // Real push services are https without exception. The loopback carve-out is
  // the same one push.js makes on subscription endpoints, and for the same
  // reason: it lets the self-test drive this exact signing path against a local
  // receiver instead of against a mock. It is not a privilege boundary.
  if (!isPushOrigin(audience)) throw new Error(`VAPID audience must be an https origin: ${audience}`);
  if (!/^(mailto:|https:\/\/)/.test(subject || '')) {
    throw new Error('VAPID subject must be a mailto: or https: URL');
  }
  // RFC 8292 §2 caps the lifetime at 24 hours.
  const exp = Math.floor(Date.now() / 1000) + Math.min(expiresInSeconds, 23 * 3600);

  const signingInput =
    `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.` +
    `${b64u(JSON.stringify({ aud: audience, exp, sub: subject }))}`;

  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKeyObject(keys),
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${b64u(signature)}`;
}

/** `https://web.push.apple.com/xyz` -> `https://web.push.apple.com` */
export function audienceOf(endpoint) {
  return new URL(endpoint).origin;
}

/** https anywhere, or plain http on loopback for the self-test receiver. */
function isPushOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
}

/* ------------------------------------------------------------------ *
 * Delivery (RFC 8030)
 * ------------------------------------------------------------------ */

/**
 * How a push service answered, folded into the only three outcomes a caller
 * needs to act on:
 *
 *   ok    delivered to the service (never "delivered to the phone" — nothing
 *         in this protocol tells the sender that, which is why the report on
 *         this feature can only ever claim as much as this status line does)
 *   gone  404/410: the subscription is dead and must be forgotten
 *   else  transient or our fault; the error text is kept for the status route
 */
export async function deliver({ subscription, payload, vapid, ttl = PUSH_TTL_SECONDS, topic, timeoutMs = 10_000 }) {
  const { endpoint, keys } = subscription;
  const { body } = encryptPayload({ p256dh: keys.p256dh, auth: keys.auth, payload });

  const token = signVapidToken({
    audience: audienceOf(endpoint),
    subject: vapid.subject,
    keys: { publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  });

  const headers = {
    // RFC 8292 §3.1 single-header form. Both halves are required: `t` proves we
    // hold the private key, `k` says which public key to check it against.
    Authorization: `vapid t=${token}, k=${vapid.publicKey}`,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    TTL: String(Math.max(0, Math.floor(ttl))),
    Urgency: 'normal',
  };
  // A topic replaces an older undelivered message with the same one, so a phone
  // that was off for an hour wakes to the latest state of a session, not five
  // stale copies.
  if (topic) headers.Topic = topic;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      gone: res.status === 404 || res.status === 410,
      error: res.ok ? null : `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      gone: false,
      error: err?.name === 'AbortError' ? 'push request timed out' : (err?.message || 'push request failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}
