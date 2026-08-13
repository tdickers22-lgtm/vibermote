/**
 * Web Push on the phone: capability detection, the permission gesture, the
 * subscription lifecycle, and the settings sheet.
 *
 * ┌─ THE iOS RULES, WHICH ARE THE WHOLE DIFFICULTY HERE ───────────────────┐
 * │ 1. Push works ONLY in a PWA installed to the Home Screen. In a plain    │
 * │    Safari tab `window.PushManager` does not exist at all, so the toggle │
 * │    must explain "add me to your Home Screen" rather than fail.          │
 * │ 2. Notification.requestPermission() must be called from a user gesture. │
 * │    Anything awaited before it costs the gesture and iOS silently        │
 * │    refuses — hence requestPermission() is the FIRST await in enable().  │
 * │ 3. Subscriptions expire. The server cannot re-establish one on its own, │
 * │    so sync() re-registers whatever the browser currently holds on every │
 * │    launch, and the service worker nudges an open page when iOS rotates  │
 * │    the subscription underneath us.                                      │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Anything that cannot work degrades to a sentence saying why. A toggle that
 * flips and then does nothing is worse than no toggle.
 */

import { api } from './api.js';
import { h, icon, sheet, toast } from './ui.js';

/* ------------------------------------------------------------------ *
 * Capability detection
 * ------------------------------------------------------------------ */

function isStandalone() {
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.matchMedia?.('(display-mode: fullscreen)')?.matches ||
    // The non-standard iOS Safari flag, which is the only reliable one there.
    window.navigator.standalone === true,
  );
}

function isApple() {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports itself as a Mac; the touch point count is what separates
  // an iPad from a desktop Safari, where push works in an ordinary tab.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * @returns {{ok: boolean, reason: string|null, message: string}}
 * `reason` is a stable code the UI branches on; `message` is what the user reads.
 */
export function pushSupport() {
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: 'insecure',
      message: 'Notifications need an HTTPS connection. Reach this server through its Tailscale ' +
        'HTTPS address rather than its raw IP.',
    };
  }
  if (!('serviceWorker' in navigator)) {
    return { ok: false, reason: 'no-sw', message: 'This browser has no service worker support.' };
  }
  if (isApple() && !isStandalone()) {
    return {
      ok: false,
      reason: 'ios-not-installed',
      message: 'iOS only allows notifications in an installed app. Tap Share, then ' +
        '“Add to Home Screen”, and open Vibermote from there.',
    };
  }
  if (!('Notification' in window) || !('PushManager' in window)) {
    return { ok: false, reason: 'unsupported', message: 'This browser cannot receive push notifications.' };
  }
  return { ok: true, reason: null, message: '' };
}

/** base64url VAPID key -> the BufferSource `subscribe()` wants. */
function decodeKey(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(subscription, publicKey) {
  const applied = subscription?.options?.applicationServerKey;
  if (!applied) return false;
  const a = new Uint8Array(applied);
  const b = decodeKey(publicKey);
  if (a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

async function currentSubscription() {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return (await registration?.pushManager?.getSubscription()) || null;
  } catch {
    return null;
  }
}

/**
 * Everything the sheet needs to render, in one call.
 * @returns {Promise<{ok, reason, message, permission, subscribed, devices}>}
 */
export async function pushState() {
  const support = pushSupport();
  if (!support.ok) return { ...support, permission: 'default', subscribed: false, devices: 0 };

  const subscription = await currentSubscription();
  let devices = 0;
  try {
    devices = (await api.pushStatus())?.count ?? 0;
  } catch {
    /* the server list is a nicety; the local subscription is the truth */
  }

  return {
    ...support,
    permission: Notification.permission,
    subscribed: Boolean(subscription),
    devices,
  };
}

/* ------------------------------------------------------------------ *
 * Enable / disable
 * ------------------------------------------------------------------ */

/**
 * Turn notifications on for this device. MUST be called synchronously from a
 * user gesture — see rule 2 at the top of this file.
 */
export async function enablePush() {
  const support = pushSupport();
  if (!support.ok) throw new Error(support.message);

  // First await, deliberately: iOS spends the user gesture on anything awaited
  // before this and then refuses the prompt without an error.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    throw new Error('Notifications are blocked for this app. Turn them back on in iOS Settings › Notifications › Vibermote.');
  }
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');

  const { publicKey } = await api.pushKey();
  if (!publicKey) throw new Error('The server did not return a notification key.');

  const registration = await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  // A subscription made against a previous server key can never be decrypted by
  // this server, and the browser will not re-key one in place.
  if (subscription && !sameKey(subscription, publicKey)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      // Required by every browser, and honoured: sw.js shows a notification for
      // every push it receives.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(publicKey),
    });
  }

  await api.pushSubscribe(subscription.toJSON());
  return true;
}

/** Turn notifications off for this device only; other phones keep theirs. */
export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return false;
  // Tell the server first, while the endpoint still exists to identify the row.
  await api.pushUnsubscribe(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
  return true;
}

/**
 * Re-register whatever subscription the browser currently holds.
 *
 * Cheap and idempotent, and it is the only thing that heals an expired or
 * rotated subscription — the server has no way to do it and the service worker
 * has no token. Called on every launch, so the worst case is that notifications
 * resume the next time the user opens the app.
 */
export async function syncPush() {
  if (!pushSupport().ok || Notification.permission !== 'granted') return false;
  const subscription = await currentSubscription();
  if (!subscription) return false;
  try {
    await api.pushSubscribe(subscription.toJSON());
    return true;
  } catch {
    return false;
  }
}

/**
 * iOS rotates subscriptions on its own. The service worker cannot re-register
 * one (it has no bearer token and must never be given one), so it forwards the
 * event to whichever page is open and we re-subscribe from here.
 */
export function initPushMessaging() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'cr:push-resync') return;
    enablePush().catch(() => syncPush());
  });
}

/* ------------------------------------------------------------------ *
 * Settings sheet
 * ------------------------------------------------------------------ */

/** One line for the menu row, before the async state lands. */
export function pushSummary(state) {
  if (!state) return 'Checking…';
  if (!state.ok) {
    return state.reason === 'ios-not-installed' ? 'Add to Home Screen first' : 'Not available here';
  }
  if (state.permission === 'denied') return 'Blocked in Settings';
  if (!state.subscribed) return 'Off';
  return state.devices > 1 ? `On · ${state.devices} devices` : 'On for this device';
}

const WHAT_IT_SENDS = [
  'A session’s process finished or crashed',
  'A session went quiet and looks like it is waiting for you',
];

export function openPushSheet() {
  sheet({
    title: 'Notifications',
    build(body, close) {
      const status = h('p', { class: 'sheet-note' }, 'Checking…');
      const actions = h('div');

      body.append(
        status,
        actions,
        h('div', { class: 'sheet-field' },
          h('span', { class: 'field-label' }, 'You will be told when'),
          h('ul', {
            style: {
              margin: '6px 0 0', paddingLeft: '18px', fontSize: '13px',
              color: 'var(--fg-dim)', lineHeight: '1.6',
            },
          }, ...WHAT_IT_SENDS.map((line) => h('li', null, line))),
        ),
        // Said plainly, because it is the reason the payloads look sparse.
        h('p', { class: 'sheet-note' },
          'Notifications show on the lock screen, so they carry only a session name ' +
          'and a status — never command text or output.'),
      );

      const render = async () => {
        let state;
        try {
          state = await pushState();
        } catch (err) {
          status.textContent = err?.message || 'Could not read notification state.';
          return;
        }

        while (actions.firstChild) actions.removeChild(actions.firstChild);

        if (!state.ok) {
          status.textContent = state.message;
          return;
        }
        if (state.permission === 'denied') {
          status.textContent =
            'Notifications are blocked for this app. Turn them back on in iOS Settings › ' +
            'Notifications › Vibermote, then come back here.';
          return;
        }

        status.textContent = state.subscribed
          ? `On for this device${state.devices > 1 ? ` · ${state.devices} devices subscribed` : ''}.`
          : 'Off. This Mac will not notify you when a session finishes or needs input.';

        const busy = (button, label) => {
          button.disabled = true;
          button.textContent = label;
        };

        if (!state.subscribed) {
          const enable = h('button', { class: 'btn btn-primary', type: 'button' }, 'Turn on notifications');
          // The click handler itself is the gesture; enablePush() calls
          // requestPermission() before awaiting anything else.
          enable.addEventListener('click', async () => {
            busy(enable, 'Asking…');
            try {
              await enablePush();
              toast('Notifications on');
              await render();
            } catch (err) {
              status.textContent = err?.message || 'Could not turn notifications on.';
              enable.disabled = false;
              enable.textContent = 'Turn on notifications';
            }
          });
          actions.append(enable);
          return;
        }

        const test = h('button', { class: 'btn', type: 'button', style: { marginBottom: '8px' } }, 'Send a test notification');
        test.addEventListener('click', async () => {
          busy(test, 'Sending…');
          try {
            const result = await api.pushTest();
            toast(result?.sent ? 'Test sent — check your lock screen' : 'The push service did not accept it', {
              error: !result?.sent,
            });
          } catch (err) {
            toast(err?.message || 'Could not send a test', { error: true });
          } finally {
            test.disabled = false;
            test.textContent = 'Send a test notification';
          }
        });

        const off = h('button', { class: 'btn', type: 'button' }, 'Turn off on this device');
        off.addEventListener('click', async () => {
          busy(off, 'Turning off…');
          try {
            await disablePush();
            toast('Notifications off');
            await render();
          } catch (err) {
            toast(err?.message || 'Could not turn notifications off', { error: true });
            off.disabled = false;
            off.textContent = 'Turn off on this device';
          }
        });

        actions.append(test, off);
      };

      render();
      // `close` is unused: the sheet closes on the backdrop like every other one.
      void close;
    },
  });
}

/** The row that opens the sheet, for the sessions menu. */
export function pushMenuRow(onOpen) {
  const desc = h('div', { class: 'sheet-item-desc' }, 'Checking…');
  const row = h('div', {
    class: 'sheet-item', role: 'button', tabindex: '0', onClick: onOpen,
  },
    icon('info', 19),
    h('div', { class: 'sheet-item-main' },
      h('div', { class: 'sheet-item-name' }, 'Notifications'),
      desc,
    ),
  );
  pushState().then((state) => { desc.textContent = pushSummary(state); }).catch(() => {
    desc.textContent = 'Unavailable';
  });
  return row;
}
