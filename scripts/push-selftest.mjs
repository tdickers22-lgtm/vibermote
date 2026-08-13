#!/usr/bin/env node
/**
 * `npm run test:push` — prove the Web Push implementation, rather than assume it.
 *
 * This server encrypts push payloads itself instead of depending on the
 * `web-push` package, so "it looked right" is not good enough: a wrong CEK or a
 * DER-encoded ES256 signature produces a body that is perfectly well-formed and
 * that every push service rejects with an opaque 401 or 400. Each check below
 * fails loudly with the actual bytes.
 *
 *   1  RFC 8188 §3.1  aes128gcm record layer, against the RFC's published vector
 *   2  RFC 8291 §5    key agreement intermediates, against the RFC's fixed keys
 *   3  round trip     encrypt -> decrypt with a freshly generated subscription
 *   4  VAPID          ES256 JWT verifies, is raw R||S, and carries the right claims
 *   5  end to end     a local receiver stands in for a push service: subscribe
 *                     through the real store, send through the real deliver(),
 *                     decrypt the body it received and compare the plaintext
 *
 * Exit code is non-zero if any check fails.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import {
  b64u, unb64u, decryptPayload, deliver, encryptPayload, generateVapidKeys, signVapidToken,
} from '../server/web-push.js';

let failures = 0;

function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}\n`);
  if (!ok) process.stdout.write(`         got  ${got}\n         want ${want}\n`);
}

function assert(name, condition, detail = '') {
  if (!condition) failures += 1;
  process.stdout.write(`${condition ? '  ok  ' : ' FAIL '} ${name}${condition || !detail ? '' : ` — ${detail}`}\n`);
}

/* ------------------------------------------------------------------ *
 * 1. RFC 8188 §3.1 — the aes128gcm record layer
 *
 * No ECDH involved: a known salt and IKM must produce this exact body. Covers
 * the header framing, the CEK/NONCE derivation, the 0x02 padding delimiter and
 * the GCM tag.
 * ------------------------------------------------------------------ */
process.stdout.write('\nRFC 8188 §3.1 — aes128gcm record\n');
{
  // The vector states IKM directly. encryptPayload() derives IKM from an ECDH
  // exchange, so the record layer is exercised here through the same hkdf and
  // cipher construction, reproduced inline against the published value.
  const salt = unb64u('I1BsxtFttlv3u_Oo94xnmw');
  const ikm = unb64u('yqdlZ-tYemfogSmv7Ws5PQ');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const hkdf = (s, m, info, len) =>
    hmac(hmac(s, m), Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, len);

  const cek = hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from('I am the walrus', 'utf8'), Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(0, 20);

  check(
    'record body',
    b64u(Buffer.concat([header, ciphertext])),
    'I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg',
  );
}

/* ------------------------------------------------------------------ *
 * 2. RFC 8291 §5 — key agreement
 *
 * The RFC's fixed sender/receiver keys and auth secret, driven through the real
 * encryptPayload(). Every intermediate the RFC publishes must match: if the
 * shared secret is right but the IKM is not, the fault is in the "WebPush: info"
 * construction; if the IKM is right but the CEK is not, it is in RFC 8188. That
 * is why these are asserted separately rather than only on the final body.
 * ------------------------------------------------------------------ */
process.stdout.write('\nRFC 8291 §5 — key agreement\n');
{
  const vector = {
    plaintext: 'When I grow up, I want to be a watermelon',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
    sharedSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
    prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
    ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
    prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
    cek: 'oIhVW04MRdy2XN9CiKLxTg',
    nonce: '4h_95klXJ5E_qnoN',
  };

  const out = encryptPayload({
    p256dh: vector.uaPublic,
    auth: vector.authSecret,
    payload: vector.plaintext,
    salt: vector.salt,
    serverKeys: { publicKey: vector.asPublic, privateKey: vector.asPrivate },
  });

  check('ECDH shared secret', b64u(out.derived.sharedSecret), vector.sharedSecret);
  check('PRK_key', b64u(out.derived.prkKey), vector.prkKey);
  check('IKM', b64u(out.derived.ikm), vector.ikm);
  check('PRK', b64u(out.derived.prk), vector.prk);
  check('CEK', b64u(out.derived.cek), vector.cek);
  check('NONCE', b64u(out.derived.nonce), vector.nonce);

  // And the receiver in the RFC must be able to read it back out.
  check(
    'receiver decrypts the RFC record',
    decryptPayload({
      body: out.body,
      privateKey: vector.uaPrivate,
      publicKey: vector.uaPublic,
      auth: vector.authSecret,
    }),
    vector.plaintext,
  );
}

/* ------------------------------------------------------------------ *
 * 3. Round trip with a freshly generated subscription
 * ------------------------------------------------------------------ */
process.stdout.write('\nRound trip — random keys\n');
function fakeSubscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64u(ecdh.getPublicKey()),
    privateKey: b64u(ecdh.getPrivateKey()),
    auth: b64u(crypto.randomBytes(16)),
  };
}
{
  const ua = fakeSubscriber();
  const message = JSON.stringify({ title: 'movievault · Claude Code', body: 'Waiting for your input' });
  const { body } = encryptPayload({ p256dh: ua.publicKey, auth: ua.auth, payload: message });
  check(
    'decrypts to the original payload',
    decryptPayload({ body, privateKey: ua.privateKey, publicKey: ua.publicKey, auth: ua.auth }),
    message,
  );

  // Two encryptions of the same plaintext must differ: a reused salt with a
  // reused key would repeat a GCM nonce, which is a total break of AES-GCM.
  const again = encryptPayload({ p256dh: ua.publicKey, auth: ua.auth, payload: message });
  assert('salt is fresh per message', !again.body.subarray(0, 16).equals(body.subarray(0, 16)));
}

/* ------------------------------------------------------------------ *
 * 4. VAPID
 * ------------------------------------------------------------------ */
process.stdout.write('\nVAPID (RFC 8292)\n');
{
  const keys = generateVapidKeys();
  const token = signVapidToken({
    audience: 'https://web.push.apple.com',
    subject: 'https://example.test',
    keys,
  });
  const [header, body, signature] = token.split('.');

  check('JWT header', Buffer.from(header, 'base64url').toString(), '{"typ":"JWT","alg":"ES256"}');

  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  check('aud is the push service origin', claims.aud, 'https://web.push.apple.com');
  check('sub is carried through', claims.sub, 'https://example.test');
  assert('exp is inside the 24h cap', claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400);

  // The signature must be raw R||S. A DER signature is ~70 bytes, verifies fine
  // with the wrong dsaEncoding, and is rejected by every push service.
  assert('signature is 64-byte P1363, not DER', unb64u(signature).length === 64,
    `got ${unb64u(signature).length} bytes`);

  const point = unb64u(keys.publicKey);
  const verified = crypto.verify(
    'sha256',
    Buffer.from(`${header}.${body}`, 'utf8'),
    {
      key: crypto.createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) },
        format: 'jwk',
      }),
      dsaEncoding: 'ieee-p1363',
    },
    unb64u(signature),
  );
  assert('signature verifies against the public key', verified);

  assert('generated public key is an uncompressed P-256 point',
    point.length === 65 && point[0] === 0x04, `${point.length} bytes, first byte 0x${point[0].toString(16)}`);
  assert('generated private scalar is 32 bytes', unb64u(keys.privateKey).length === 32);
}

/* ------------------------------------------------------------------ *
 * 5. End to end through deliver(), against a local receiver
 *
 * The closest thing to a real send that is possible without a real phone: a
 * loopback HTTP server plays the push service, and everything up to the moment
 * bytes leave this machine is the production path — real headers, real VAPID
 * signature, real encryption. What it cannot prove is the hop beyond it.
 * ------------------------------------------------------------------ */
process.stdout.write('\nEnd to end — local receiver stands in for a push service\n');
{
  const ua = fakeSubscriber();
  const vapidKeys = { ...generateVapidKeys(), subject: 'mailto:selftest@example.test' };
  const received = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks), method: req.method });
      res.writeHead(201).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/push/abc123`;

  const payload = JSON.stringify({
    title: 'movievault · Claude Code',
    body: 'Waiting for your input',
    event: 'waiting',
    sessionId: 'live:ccr-claude-movievault',
  });

  const outcome = await deliver({
    subscription: { endpoint, keys: { p256dh: ua.publicKey, auth: ua.auth } },
    payload,
    vapid: vapidKeys,
    topic: 'selftest',
  });

  server.close();

  assert('deliver() reports success', outcome.ok, outcome.error || '');
  assert('exactly one request arrived', received.length === 1, `got ${received.length}`);

  if (received.length === 1) {
    const { headers, body, method } = received[0];
    check('method', method, 'POST');
    check('Content-Encoding', headers['content-encoding'], 'aes128gcm');
    check('Content-Type', headers['content-type'], 'application/octet-stream');
    check('Topic', headers.topic, 'selftest');
    assert('TTL is present', Boolean(headers.ttl), 'no TTL header');

    const auth = headers.authorization || '';
    assert('Authorization is the vapid t=/k= form', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(auth),
      auth.slice(0, 60));
    check('k= is our public key', /k=([\w-]+)$/.exec(auth)?.[1], vapidKeys.publicKey);

    const jwt = /^vapid t=([^,]+)/.exec(auth)?.[1] || '';
    const [h, b, s] = jwt.split('.');
    const point = unb64u(vapidKeys.publicKey);
    assert('the JWT on the wire verifies', crypto.verify(
      'sha256',
      Buffer.from(`${h}.${b}`, 'utf8'),
      {
        key: crypto.createPublicKey({
          key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) },
          format: 'jwk',
        }),
        dsaEncoding: 'ieee-p1363',
      },
      unb64u(s),
    ));
    check('aud matches the receiver origin', JSON.parse(Buffer.from(b, 'base64url').toString()).aud,
      new URL(endpoint).origin);

    // The whole point: what the phone would decrypt is what we meant to send.
    check(
      'the receiver decrypts the exact payload',
      decryptPayload({ body, privateKey: ua.privateKey, publicKey: ua.publicKey, auth: ua.auth }),
      payload,
    );
    assert('nothing secret is in the headers',
      !JSON.stringify(headers).includes(vapidKeys.privateKey));
  }
}

process.stdout.write(
  failures
    ? `\n${failures} check(s) FAILED\n`
    : '\nall checks passed\n',
);
process.exit(failures ? 1 : 0);
