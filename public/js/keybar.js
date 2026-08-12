/**
 * The mobile keyboard bar.
 *
 * Phone keyboards have no Esc, Ctrl, Tab or arrows, and Claude Code needs all
 * four. This bar sits directly above the soft keyboard and supplies them, plus
 * a sticky Ctrl modifier that also applies to letters typed on the real
 * keyboard (tap Ctrl, then "r" -> 0x12).
 *
 * Every key fires on `pointerdown` with preventDefault so focus never leaves
 * the terminal's textarea — otherwise the soft keyboard would close on each tap.
 */

import { h, icon, sheet, toast } from './ui.js';
import { getKind } from './kinds.js';

const ESC = '\x1b';

/** ctrl state: 0 = off, 1 = armed for one key, 2 = locked */
const OFF = 0, ARMED = 1, LOCKED = 2;

export function createKeybar(host, ctx) {
  let ctrl = OFF;
  let ctrlKeyEl = null;
  let kbKeyEl = null;
  let paletteKeyEl = null;

  /* ------------------------------------------------------- ctrl handling */

  function setCtrl(next) {
    ctrl = next;
    if (!ctrlKeyEl) return;
    ctrlKeyEl.classList.toggle('armed', ctrl === ARMED);
    ctrlKeyEl.classList.toggle('locked', ctrl === LOCKED);
    ctrlKeyEl.setAttribute('aria-pressed', ctrl !== OFF ? 'true' : 'false');
  }

  function cycleCtrl() {
    setCtrl(ctrl === OFF ? ARMED : ctrl === ARMED ? LOCKED : OFF);
  }

  function consumeCtrl() {
    if (ctrl === ARMED) setCtrl(OFF);
  }

  /** Map a printable character to its control code. */
  function toControlChar(ch) {
    if (ch === ' ') return '\x00';
    if (ch === '?') return '\x7f';
    const code = ch.toUpperCase().charCodeAt(0);
    // @ A-Z [ \ ] ^ _  ->  0x00-0x1f
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
    return ch;
  }

  /**
   * Applied to everything typed on the real keyboard. Only single characters
   * are transformed, so a paste or an IME commit is never mangled.
   */
  function transform(data) {
    if (ctrl === OFF || data.length !== 1) return data;
    const out = toControlChar(data);
    consumeCtrl();
    return out;
  }

  /* ---------------------------------------------------------- key wiring */

  function bindKey(el, action, { repeat = false } = {}) {
    let firedFromPointer = false;
    let holdTimer = 0;
    let repeatTimer = 0;

    const stopRepeat = () => {
      clearTimeout(holdTimer);
      clearInterval(repeatTimer);
      holdTimer = 0;
      repeatTimer = 0;
      el.classList.remove('pressed');
    };

    el.addEventListener('pointerdown', (ev) => {
      // Keeps the terminal textarea focused: no focus change, no keyboard flicker.
      ev.preventDefault();
      firedFromPointer = true;
      el.classList.add('pressed');
      action();
      if (repeat) {
        holdTimer = setTimeout(() => {
          repeatTimer = setInterval(action, 60);
        }, 400);
      }
      setTimeout(() => { firedFromPointer = false; }, 500);
    });

    el.addEventListener('pointerup', stopRepeat);
    el.addEventListener('pointercancel', stopRepeat);
    el.addEventListener('pointerleave', stopRepeat);

    // Desktop keyboard activation (Enter/Space on a focused button).
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (firedFromPointer) return;
      action();
    });
  }

  function key(label, action, opts = {}) {
    const el = h('button', {
      class: `key${opts.class ? ` ${opts.class}` : ''}`,
      type: 'button',
      'aria-label': opts.aria || (typeof label === 'string' ? label : opts.name),
    }, typeof label === 'string' ? label : label);
    bindKey(el, action, opts);
    return el;
  }

  /** A key that sends a fixed sequence, with an optional Ctrl-modified variant. */
  function seqKey(label, seq, opts = {}) {
    return key(label, () => {
      if (ctrl !== OFF && opts.ctrlSeq) {
        ctx.send(opts.ctrlSeq);
        consumeCtrl();
      } else {
        ctx.send(seq);
      }
      if (opts.after) opts.after();
    }, opts);
  }

  /* ------------------------------------------------------------- palette */

  /**
   * The palette is the one part of the keybar that is NOT universal. Claude's
   * `/model` does nothing in a Codex session and `/approvals` does nothing in
   * Claude, so the list is driven entirely by the active session's kind — never
   * a merged superset.
   */
  function openPalette() {
    const kind = getKind(ctx.getKind());
    const commands = kind.commands || [];

    sheet({
      title: kind.commands.length ? `${kind.name} · ${kind.paletteTitle}` : kind.name,
      build(body, close) {
        if (!commands.length) {
          body.append(
            h('p', { class: 'sheet-note' },
              `No shortcuts are defined for ${kind.name}. Use the keys below to drive it directly.`),
          );
          return;
        }

        for (const { cmd, desc } of commands) {
          const send = h('button', {
            class: 'sheet-send',
            type: 'button',
            'aria-label': `Insert and run ${cmd}`,
            onClick: (ev) => {
              ev.stopPropagation();
              ctx.send(`${cmd}\r`);
              close();
            },
          }, icon('enter', 16));

          body.append(
            h('div', {
              class: 'sheet-item',
              role: 'button',
              tabindex: '0',
              onClick: () => { ctx.send(cmd); close(); ctx.focus(); },
            },
              h('div', { class: 'sheet-item-main' },
                h('div', { class: 'sheet-item-cmd' }, cmd),
                h('div', { class: 'sheet-item-desc' }, desc),
              ),
              send,
            ),
          );
        }

        body.append(
          h('p', { class: 'sheet-note' },
            kind.slash
              ? 'Tap a command to insert it into the prompt. Tap ⏎ to insert and run it.'
              : 'Tap a snippet to type it at the shell. Tap ⏎ to type and run it.'),
        );
      },
    });
  }

  /** Retitle the palette key when the active session's kind changes. */
  function syncKind() {
    if (!paletteKeyEl) return;
    const kind = getKind(ctx.getKind());
    paletteKeyEl.textContent = kind.paletteKey;
    paletteKeyEl.setAttribute(
      'aria-label',
      kind.slash ? `${kind.name} slash commands` : `${kind.name} shortcuts`,
    );
  }

  /* --------------------------------------------------------------- paste */

  async function doPaste() {
    // navigator.clipboard needs a secure context; plain http:// over Tailscale
    // is not one, so fall back to a real field the user can long-press into.
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) { ctx.send(text); ctx.focus(); return; }
      } catch { /* denied or unavailable -> fallback */ }
    }
    pasteSheet();
  }

  function pasteSheet() {
    sheet({
      title: 'Paste',
      build(body, close) {
        const input = h('textarea', {
          class: 'paste-field',
          rows: '4',
          placeholder: 'Long-press here and choose Paste…',
          autocapitalize: 'none',
          autocorrect: 'off',
          spellcheck: 'false',
          style: {
            width: '100%', padding: '12px', borderRadius: '12px',
            background: 'var(--bg)', border: '1px solid var(--line)',
            color: 'var(--fg)', font: '16px var(--font-mono)', outline: 'none',
            resize: 'none', marginBottom: '12px',
          },
        });
        body.append(
          input,
          h('button', {
            class: 'btn btn-primary',
            onClick: () => {
              const text = input.value;
              close();
              if (text) { ctx.send(text); ctx.focus(); }
            },
          }, 'Send to terminal'),
        );
        setTimeout(() => input.focus(), 260);
      },
    });
  }

  /* ------------------------------------------------------------- keyboard */

  function toggleKeyboard() {
    if (ctx.isFocused()) ctx.blur();
    else ctx.focus();
    setTimeout(syncKeyboardKey, 120);
  }

  function syncKeyboardKey() {
    if (!kbKeyEl) return;
    kbKeyEl.classList.toggle('toggled', ctx.isFocused());
  }

  /* ----------------------------------------------------------------- build */

  paletteKeyEl = key('/ cmds', openPalette, { class: 'key-wide', aria: 'Command palette' });

  const quickRow = h('div', { class: 'keyrow' },
    paletteKeyEl,
    key('^C', () => { ctx.send('\x03'); setCtrl(OFF); },
      { class: 'key-wide key-danger', aria: 'Ctrl+C interrupt' }),
    key('⇧⇥', () => ctx.send(`${ESC}[Z`), { aria: 'Shift Tab' }),
    key(icon('clipboard', 17), doPaste, { aria: 'Paste' }),
    key(icon('keyboard', 17), toggleKeyboard, { aria: 'Toggle keyboard' }),
  );
  kbKeyEl = quickRow.lastElementChild;

  ctrlKeyEl = key('ctrl', cycleCtrl, { aria: 'Sticky Ctrl modifier' });
  ctrlKeyEl.setAttribute('aria-pressed', 'false');

  const mainRow = h('div', { class: 'keyrow' },
    seqKey('esc', ESC, { aria: 'Escape' }),
    seqKey('tab', '\t', { aria: 'Tab' }),
    ctrlKeyEl,
    seqKey(icon('arrowLeft', 17), `${ESC}[D`, { ctrlSeq: `${ESC}[1;5D`, aria: 'Left', repeat: true }),
    seqKey(icon('arrowDown', 17), `${ESC}[B`, { ctrlSeq: `${ESC}[1;5B`, aria: 'Down', repeat: true }),
    seqKey(icon('arrowUp', 17), `${ESC}[A`, { ctrlSeq: `${ESC}[1;5A`, aria: 'Up', repeat: true }),
    seqKey(icon('arrowRight', 17), `${ESC}[C`, { ctrlSeq: `${ESC}[1;5C`, aria: 'Right', repeat: true }),
    seqKey(icon('enter', 17), '\r', { aria: 'Enter' }),
  );

  host.append(quickRow, mainRow);
  syncKind();

  document.addEventListener('focusin', syncKeyboardKey);
  document.addEventListener('focusout', () => setTimeout(syncKeyboardKey, 80));

  return {
    transform,
    resetModifiers: () => setCtrl(OFF),
    openPalette,
    syncKeyboardKey,
    syncKind,
  };
}
