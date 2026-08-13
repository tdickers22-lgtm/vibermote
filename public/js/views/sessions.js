/**
 * Home screen: every terminal session on the Mac, whatever CLI is running in
 * it, as a tab switcher.
 *
 * The scannability problem this solves: with a dozen sessions across four kinds
 * and half a dozen projects, a flat list of directory names is unreadable. So
 * every row carries a kind badge in a fixed colour, and the list narrows by
 * kind, by project and by free text — three cheap filters that compose.
 */

import { api, ApiError, clearToken } from '../api.js';
import { allKinds, getKind, kindsReported, selectableKinds } from '../kinds.js';
import { defaultCwd, homeDir, rememberCwd } from '../env.js';
import { openPushSheet, pushMenuRow } from '../push.js';
import {
  h, clear, icon, toast, sheet, confirmSheet,
  relativeTime, timestampOf, prettyPath, projectName, sanitizePreview,
} from '../ui.js';

const POLL_INTERVAL = 5000;
const ALL = '\u0000all'; // sentinel that can never collide with a real kind/cwd

export function createSessionsView({ onOpen }) {
  const listBody = document.getElementById('list-body');
  const listScroll = document.getElementById('list-scroll');
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  const filterBar = document.getElementById('filterbar');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnNew = document.getElementById('btn-new');
  const btnMenu = document.getElementById('btn-menu');
  const btnShell = document.getElementById('btn-shell');
  const btnShellDir = document.getElementById('btn-shell-dir');
  const shellDirLabel = document.getElementById('qs-dir');

  let sessions = [];
  let projects = [];      // recent dirs from /api/projects, when available
  let commands = [];      // the user's saved one-tap commands
  let filter = '';
  let kindFilter = ALL;
  let projectFilter = ALL;
  let loadedOnce = false;
  let inFlight = false;
  let pollTimer = 0;
  let visible = false;
  let shellCwd = '';      // where the one-tap shell will start
  let startingShell = false;

  btnRefresh.append(icon('refresh'));
  btnNew.append(icon('plus'));
  btnMenu.append(icon('more'));
  btnShellDir.append(icon('folder', 18));
  searchClear.append(icon('x', 16));

  /* ------------------------------------------------------------- loading */

  async function load({ quiet = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    if (!quiet) btnRefresh.classList.add('spinning');
    try {
      const list = await api.listSessions();
      list.sort((a, b) => {
        if (b.live !== a.live) return Number(b.live) - Number(a.live);
        return timestampOf(b.lastActivity) - timestampOf(a.lastActivity);
      });
      sessions = list;
      loadedOnce = true;
      pruneFilters();
      render();
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) return; // main.js handles the bounce
      if (!quiet) toast(err.message || 'Could not load sessions', { error: true });
      if (!loadedOnce) renderError(err);
    } finally {
      inFlight = false;
      btnRefresh.classList.remove('spinning');
    }
  }

  /** Recent project dirs, for the new-session picker. Best-effort. */
  async function loadProjects() {
    try {
      projects = await api.listProjects();
    } catch {
      projects = [];
    }
  }

  /**
   * The user's saved commands. Best-effort for the same reason as projects: an
   * empty list must degrade to "type the command each time", never to a sheet
   * that refuses to open.
   */
  async function loadCommands() {
    try {
      commands = await api.listCommands();
    } catch {
      commands = [];
    }
    return commands;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (visible && !document.hidden) await load({ quiet: true });
      schedulePoll();
    }, POLL_INTERVAL);
  }

  /* ------------------------------------------------------------- filters */

  /** A filter pinned to something that no longer exists silently hides everything. */
  function pruneFilters() {
    if (kindFilter !== ALL && !sessions.some((s) => s.kind === kindFilter)) kindFilter = ALL;
    if (projectFilter !== ALL && !sessions.some((s) => s.cwd === projectFilter)) projectFilter = ALL;
  }

  function kindCounts() {
    const counts = new Map();
    for (const s of sessions) counts.set(s.kind, (counts.get(s.kind) || 0) + 1);
    return counts;
  }

  function projectCounts() {
    const counts = new Map();
    for (const s of sessions) {
      if (!s.cwd) continue;
      counts.set(s.cwd, (counts.get(s.cwd) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  function matches(session) {
    if (kindFilter !== ALL && session.kind !== kindFilter) return false;
    if (projectFilter !== ALL && session.cwd !== projectFilter) return false;
    if (!filter) return true;
    const needle = filter.toLowerCase();
    return (
      projectName(session).toLowerCase().includes(needle) ||
      String(session.cwd || '').toLowerCase().includes(needle) ||
      String(session.preview || '').toLowerCase().includes(needle) ||
      getKind(session.kind).name.toLowerCase().includes(needle) ||
      String(session.kind || '').toLowerCase().includes(needle) ||
      String(session.id || '').toLowerCase().includes(needle)
    );
  }

  function renderFilters() {
    clear(filterBar);
    if (!sessions.length) { filterBar.hidden = true; return; }
    filterBar.hidden = false;

    const projList = projectCounts();

    // Project selector first: it is the coarsest cut, and with many projects a
    // chip per project would never fit, so it opens a sheet instead.
    if (projList.length > 1) {
      const label = projectFilter === ALL
        ? 'All projects'
        : (prettyPath(projectFilter).split('/').pop() || prettyPath(projectFilter));
      filterBar.append(h('button', {
        class: `fchip fchip-menu${projectFilter === ALL ? '' : ' on'}`,
        type: 'button',
        onClick: () => openProjectPicker(projList),
      }, label, h('span', { class: 'fchip-caret' }, '⌄')));
    }

    const counts = kindCounts();
    filterBar.append(chip('All', sessions.length, kindFilter === ALL, null, () => {
      kindFilter = ALL;
      render();
    }));

    // Only kinds actually present — an empty "codex" chip is noise.
    for (const kind of allKinds()) {
      const count = counts.get(kind.id);
      if (!count) continue;
      filterBar.append(chip(kind.name, count, kindFilter === kind.id, kind.color, () => {
        kindFilter = kindFilter === kind.id ? ALL : kind.id;
        render();
      }));
    }

    // Kinds the registry does not know about, so nothing is unreachable.
    const known = new Set(allKinds().map((k) => k.id));
    for (const [id, count] of counts) {
      if (known.has(id)) continue;
      filterBar.append(chip(id, count, kindFilter === id, getKind(id).color, () => {
        kindFilter = kindFilter === id ? ALL : id;
        render();
      }));
    }
  }

  function chip(label, count, active, color, onClick) {
    return h('button', {
      class: `fchip${active ? ' on' : ''}`,
      type: 'button',
      style: color ? { '--k': color } : null,
      'aria-pressed': active ? 'true' : 'false',
      onClick,
    },
      color ? h('span', { class: 'fchip-dot' }) : null,
      label,
      h('span', { class: 'fchip-n' }, String(count)),
    );
  }

  function openProjectPicker(projList) {
    sheet({
      title: 'Filter by project',
      build(body, close) {
        const pick = (cwd) => { projectFilter = cwd; close(); render(); };
        body.append(pickerRow('All projects', `${sessions.length} sessions`,
          projectFilter === ALL, () => pick(ALL)));
        for (const [cwd, count] of projList) {
          body.append(pickerRow(
            cwd.split('/').filter(Boolean).pop() || cwd,
            `${prettyPath(cwd)} · ${count} session${count === 1 ? '' : 's'}`,
            projectFilter === cwd,
            () => pick(cwd),
          ));
        }
      },
    });
  }

  function pickerRow(name, desc, active, onClick) {
    return h('div', {
      class: `sheet-item${active ? ' on' : ''}`, role: 'button', tabindex: '0', onClick,
    },
      h('div', { class: 'sheet-item-main' },
        h('div', { class: 'sheet-item-name' }, name),
        h('div', { class: 'sheet-item-desc' }, desc),
      ),
      active ? h('span', { class: 'sheet-tick' }, '✓') : null,
    );
  }

  /* ----------------------------------------------------------- rendering */

  function render() {
    renderQuickstart();
    renderFilters();
    clear(listBody);

    if (!loadedOnce) { renderSkeletons(); return; }

    if (!sessions.length) {
      listBody.append(emptyState(
        'No sessions yet',
        'Run any command, or start Claude Code, Codex or a shell — it shows up here.',
        h('button', { class: 'btn btn-primary', onClick: () => openNewSheet() }, 'New session'),
      ));
      return;
    }

    const shown = sessions.filter(matches);

    if (!shown.length) {
      listBody.append(emptyState(
        'No matches',
        describeActiveFilters(),
        h('button', { class: 'btn', onClick: resetFilters }, 'Clear filters'),
      ));
      return;
    }

    const live = shown.filter((s) => s.live);
    const dormant = shown.filter((s) => !s.live);

    if (live.length) {
      listBody.append(groupHead('Live', live.length, true));
      for (const s of live) listBody.append(sessionRow(s));
    }
    if (dormant.length) {
      listBody.append(groupHead('Resumable', dormant.length, false));
      for (const s of dormant) listBody.append(sessionRow(s));
    }
  }

  function describeActiveFilters() {
    const parts = [];
    if (filter) parts.push(`matching “${filter}”`);
    if (kindFilter !== ALL) parts.push(`in ${getKind(kindFilter).name}`);
    if (projectFilter !== ALL) parts.push(`under ${prettyPath(projectFilter)}`);
    return parts.length ? `No sessions ${parts.join(' ')}.` : 'Nothing matches.';
  }

  function resetFilters() {
    searchInput.value = '';
    filter = '';
    kindFilter = ALL;
    projectFilter = ALL;
    searchClear.hidden = true;
    render();
  }

  function groupHead(label, count, isLive) {
    return h('div', { class: `group-head${isLive ? ' live-head' : ''}` },
      label, h('span', { class: 'count' }, String(count)));
  }

  function renderSkeletons() {
    for (let i = 0; i < 6; i++) listBody.append(h('div', { class: 'skeleton' }));
  }

  function renderError(err) {
    clear(listBody);
    listBody.append(emptyState(
      'Cannot reach the server',
      err?.message || 'Check that the Mac is awake and on the tailnet.',
      h('button', { class: 'btn btn-primary', onClick: () => load() }, 'Retry'),
    ));
  }

  function emptyState(title, sub, action) {
    return h('div', { class: 'state' },
      h('p', { class: 'state-title' }, title),
      h('p', { class: 'state-sub' }, sub),
      action,
    );
  }

  function kindBadge(kindId) {
    const kind = getKind(kindId);
    return h('span', {
      class: 'kbadge',
      style: { '--k': kind.color },
      title: kind.name,
    }, kind.id);
  }

  function sessionRow(session) {
    const preview = sanitizePreview(session.preview);
    const kind = getKind(session.kind);

    // Live sessions can be killed. A dormant row is a transcript on disk, not a
    // process, so offering "kill" there would be a lie.
    const trailing = session.live
      ? h('button', {
        class: 'srow-kill',
        type: 'button',
        'aria-label': `Kill ${projectName(session)}`,
        onClick: (ev) => { ev.stopPropagation(); confirmKill(session); },
      }, icon('stop', 18))
      : null;

    return h('button', {
      class: `srow${session.live ? ' live' : ''}`,
      type: 'button',
      style: { '--k': kind.color },
      onClick: () => onOpen(session),
    },
      h('span', { class: 'srow-dot' }),
      h('span', { class: 'srow-body' },
        h('span', { class: 'srow-top' },
          kindBadge(session.kind),
          h('span', { class: 'srow-name' }, projectName(session)),
          h('span', { class: 'srow-time' }, relativeTime(session.lastActivity)),
        ),
        h('span', { class: 'srow-path' }, prettyPath(session.cwd) || session.id),
        preview ? h('span', { class: 'srow-preview' }, preview) : null,
      ),
      trailing,
    );
  }

  /* ------------------------------------------------------------- actions */

  async function confirmKill(session) {
    const kind = getKind(session.kind);
    const ok = await confirmSheet({
      title: 'Kill session',
      message: `End ${projectName(session)}? The ${kind.name} process and its tmux window are terminated. Unsaved work in that session is lost.`,
      confirmLabel: 'Kill session',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.killSession(session.id);
      toast('Session killed');
      sessions = sessions.filter((s) => s.id !== session.id);
      render();
      load({ quiet: true });
    } catch (err) {
      toast(err.message || 'Could not kill session', { error: true });
    }
  }

  /* ---------------------------------------------------------- quick shell *
   * "I want to do terminal work on my computer from my phone, fully."
   *
   * A plain shell was always supported and always buried: open the sheet, find
   * the Shell tile among the tool presets, type an absolute path on a phone
   * keyboard. This is the same launch, one tap, in a directory that is visible
   * and changeable. The presets keep their place behind the + button. */

  function renderQuickstart() {
    if (!shellCwd) shellCwd = defaultCwd(sessions.find((s) => s.cwd)?.cwd);
    shellDirLabel.textContent = prettyPath(shellCwd) || 'home';
  }

  async function startShell() {
    if (startingShell) return;
    startingShell = true;
    btnShell.classList.add('busy');
    try {
      // An empty cwd is not a broken request: the server starts in its own
      // $HOME, which is exactly the right answer when we never learned one.
      const cwd = shellCwd || defaultCwd();
      const { id, session } = await api.createSession({ kind: 'shell', cwd: cwd || undefined });
      if (cwd) rememberCwd(cwd);
      await load({ quiet: true });
      onOpen(sessions.find((s) => s.id === id) || session || {
        id, kind: 'shell', cwd, live: true,
      });
    } catch (err) {
      toast(err.message || 'Could not start a shell', { error: true });
    } finally {
      startingShell = false;
      btnShell.classList.remove('busy');
    }
  }

  function openShellDirSheet() {
    sheet({
      title: 'Start shells in',
      build(body, close) {
        const input = h('input', {
          type: 'text',
          value: shellCwd,
          placeholder: homeDir() || '/Users/you/project',
          autocapitalize: 'none',
          autocorrect: 'off',
          spellcheck: 'false',
          enterkeyhint: 'done',
          'aria-label': 'Working directory for new shells',
        });

        const pick = (cwd) => {
          shellCwd = cwd;
          rememberCwd(cwd);
          renderQuickstart();
          close();
        };

        const apply = () => {
          const value = input.value.trim();
          if (!value) { toast('Enter a working directory', { error: true }); return; }
          pick(value);
        };

        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') apply(); });

        body.append(
          h('div', { class: 'sheet-field' },
            h('span', { class: 'field-label' }, 'Directory'),
            input,
          ),
          h('button', { class: 'btn btn-primary', style: { marginBottom: '14px' }, onClick: apply },
            'Use this directory'),
        );

        const home = homeDir();
        if (home) {
          body.append(pickerRow('Home', prettyPath(home), shellCwd === home, () => pick(home)));
        }
        for (const cwd of recentCwds()) {
          if (cwd === home) continue;
          body.append(pickerRow(
            cwd.split('/').filter(Boolean).pop() || cwd,
            prettyPath(cwd),
            shellCwd === cwd,
            () => pick(cwd),
          ));
        }
      },
    });
  }

  /** Directories worth offering, most-recent first: live sessions then history. */
  function recentCwds() {
    const seen = [];
    const push = (cwd) => {
      if (cwd && !seen.includes(cwd)) seen.push(cwd);
    };
    for (const s of sessions) push(s.cwd);
    for (const p of projects) push(p.cwd);
    return seen.slice(0, 10);
  }

  /* -------------------------------------------------------- new session */

  /**
   * Default name offered when saving a typed command. The user edits it; this
   * only has to be recognisable, not clever.
   */
  function defaultCommandName(line) {
    const flat = line.replace(/\s+/g, ' ').trim();
    return flat.length <= 40 ? flat : `${flat.slice(0, 39)}…`;
  }

  function openNewSheet(prefill = {}) {
    // `custom` is deliberately absent from the tile grid: a command session is
    // meaningless without the command, so it is driven by the command field at
    // the top of the sheet and by the saved-command list, not by a tile.
    const kinds = selectableKinds();
    // Prefer a kind that is actually usable, so the default is never a dead end.
    let chosenKind = prefill.kind
      || kinds.find((k) => k.available !== false)?.id
      || kinds[0]?.id
      || 'claude';
    let resumeFrom = null;
    let launching = false;

    sheet({
      title: 'New session',
      build(body, close) {
        const kindGrid = h('div', { class: 'kind-grid' });
        const resumeSlot = h('div', { class: 'sheet-field' });
        const savedSlot = h('div', { class: 'sheet-field saved-field' });
        const cwdInput = h('input', {
          type: 'text',
          placeholder: '/Users/you/project',
          value: prefill.cwd || sessions[0]?.cwd || '',
          autocapitalize: 'none',
          autocorrect: 'off',
          spellcheck: 'false',
          enterkeyhint: 'go',
        });
        const argsInput = h('input', {
          type: 'text',
          placeholder: '--model opus  (optional)',
          autocapitalize: 'none',
          autocorrect: 'off',
          spellcheck: 'false',
        });
        const submit = h('button', { class: 'btn btn-primary' }, 'Start session');

        /* ---------------------------------------------------- run anything *
         * The whole point of the product: any command line, from the phone.
         * iOS will happily capitalise "Git Status" and autocorrect "npm" into
         * "nom" unless every one of these four attributes is present. */
        const cmdInput = h('input', {
          type: 'text',
          class: 'cmd-input',
          placeholder: 'npm run dev',
          value: prefill.command || '',
          autocapitalize: 'off',
          autocorrect: 'off',
          autocomplete: 'off',
          spellcheck: 'false',
          enterkeyhint: 'go',
          'aria-label': 'Command to run',
        });
        const cmdGo = h('button', {
          class: 'cmd-go', type: 'button', 'aria-label': 'Run this command',
        }, 'Run');
        const cmdSave = h('button', {
          class: 'cmd-save', type: 'button',
        }, 'Save as one-tap');

        /**
         * Single launch path for every button in this sheet — typed command,
         * saved command and preset tile all create a session the same way, so
         * there is one place where "starting…", errors and the hand-off to the
         * terminal are handled.
         */
        async function launch(payload, button, busyLabel = '…') {
          if (launching) return;
          launching = true;
          const restore = button ? button.textContent : '';
          if (button) { button.disabled = true; button.textContent = busyLabel; }
          try {
            const { id, session } = await api.createSession(payload);
            close();
            await load({ quiet: true });
            const isCommand = Boolean(payload.command || payload.savedCommandId);
            onOpen(sessions.find((s) => s.id === id) || session || {
              id,
              cwd: payload.cwd || '',
              kind: isCommand ? 'custom' : payload.kind,
              live: true,
            });
          } catch (err) {
            toast(err.message || 'Could not start session', { error: true });
          } finally {
            launching = false;
            if (button) { button.disabled = false; button.textContent = restore; }
          }
        }

        function runTypedCommand() {
          const line = cmdInput.value.trim();
          if (!line) {
            toast('Type a command to run', { error: true });
            cmdInput.focus();
            return;
          }
          const cwd = cwdInput.value.trim();
          if (!cwd) {
            toast('Enter a working directory', { error: true });
            cwdInput.focus();
            return;
          }
          launch({ command: line, cwd }, cmdGo);
        }

        /* --------------------------------------------------- saved commands */

        function renderSaved() {
          clear(savedSlot);
          if (!commands.length) return;

          savedSlot.append(h('div', { class: 'launch-head' },
            h('span', { class: 'field-label' }, 'Saved commands'),
            h('span', { class: 'launch-head-note' }, 'tap to run'),
          ));

          const list = h('div', { class: 'saved-list' });
          for (const sc of commands) {
            const named = sc.name !== sc.command;
            list.append(h('div', { class: 'saved-opt' },
              h('button', {
                class: 'saved-run',
                type: 'button',
                title: sc.command,
                onClick: () => launch({
                  savedCommandId: sc.id,
                  cwd: sc.cwd || cwdInput.value.trim(),
                }, null),
              },
                named ? h('span', { class: 'saved-name' }, sc.name) : null,
                h('span', { class: `saved-cmd${named ? '' : ' lead'}` }, sc.command),
                sc.cwd ? h('span', { class: 'saved-dir' }, prettyPath(sc.cwd)) : null,
              ),
              h('button', {
                class: 'saved-del',
                type: 'button',
                'aria-label': `Delete saved command ${sc.name}`,
                onClick: () => deleteSaved(sc),
              }, icon('x', 15)),
            ));
          }
          savedSlot.append(list);
        }

        async function deleteSaved(sc) {
          const ok = await confirmSheet({
            title: 'Delete saved command',
            message: `Remove “${sc.name}” (${sc.command}) from this Mac? Sessions already running it keep running.`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deleteCommand(sc.id);
            commands = commands.filter((c) => c.id !== sc.id);
            renderSaved();
            toast('Command deleted');
          } catch (err) {
            toast(err.message || 'Could not delete command', { error: true });
          }
        }

        function openSaveSheet() {
          const line = cmdInput.value.trim();
          if (!line) {
            toast('Type a command first', { error: true });
            cmdInput.focus();
            return;
          }
          const dir = cwdInput.value.trim();
          // A command usually belongs to one project, so pinning is the default
          // when we have a directory — but it is shown, and switchable, rather
          // than applied invisibly.
          let pinned = Boolean(dir);

          sheet({
            title: 'Save command',
            build(sbody, sclose) {
              const nameInput = h('input', {
                type: 'text',
                value: defaultCommandName(line),
                placeholder: 'Dev server',
                autocapitalize: 'off',
                autocorrect: 'off',
                spellcheck: 'false',
                enterkeyhint: 'done',
                'aria-label': 'Name for this command',
              });
              const pinBtn = dir
                ? h('button', { class: 'pin-opt on', type: 'button', 'aria-pressed': 'true' })
                : null;
              const save = h('button', { class: 'btn btn-primary' }, 'Save command');

              function renderPin() {
                if (!pinBtn) return;
                clear(pinBtn);
                pinBtn.classList.toggle('on', pinned);
                pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
                pinBtn.append(
                  h('span', { class: 'pin-box' }, pinned ? '✓' : ''),
                  h('span', { class: 'pin-main' },
                    h('span', { class: 'pin-name' },
                      pinned ? `Always run in ${prettyPath(dir)}` : 'Run wherever it is launched from'),
                    h('span', { class: 'pin-desc' },
                      pinned
                        ? 'The directory is stored with the command.'
                        : 'Uses the working directory chosen at launch.'),
                  ),
                );
              }

              pinBtn?.addEventListener('click', () => { pinned = !pinned; renderPin(); });
              renderPin();

              async function doSave() {
                const name = nameInput.value.trim() || defaultCommandName(line);
                save.disabled = true;
                save.textContent = 'Saving…';
                try {
                  const saved = await api.saveCommand({
                    name,
                    command: line,
                    cwd: pinned ? dir : null,
                  });
                  commands = [...commands.filter((c) => c.id !== saved.id), saved];
                  renderSaved();
                  sclose();
                  toast(`Saved “${saved.name}”`);
                } catch (err) {
                  save.disabled = false;
                  save.textContent = 'Save command';
                  toast(err.message || 'Could not save command', { error: true });
                }
              }

              save.addEventListener('click', doSave);
              nameInput.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') doSave();
              });

              sbody.append(
                h('div', { class: 'sheet-field' },
                  h('span', { class: 'field-label' }, 'Command'),
                  h('p', { class: 'saved-preview' }, line),
                ),
                h('div', { class: 'sheet-field' },
                  h('span', { class: 'field-label' }, 'Name'),
                  nameInput,
                ),
                pinBtn ? h('div', { class: 'sheet-field' }, pinBtn) : null,
                save,
              );
            },
          });
        }

        cmdGo.addEventListener('click', runTypedCommand);
        cmdSave.addEventListener('click', openSaveSheet);
        cmdInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); runTypedCommand(); }
        });

        function renderKinds() {
          clear(kindGrid);
          for (const kind of kinds) {
            const unavailable = kind.available === false;
            const active = kind.id === chosenKind;
            kindGrid.append(h('button', {
              class: `kind-opt${active ? ' on' : ''}${unavailable ? ' off' : ''}`,
              type: 'button',
              style: { '--k': kind.color },
              disabled: unavailable || null,
              'aria-pressed': active ? 'true' : 'false',
              title: unavailable ? `${kind.name} is not installed on this Mac` : kind.name,
              onClick: () => {
                if (unavailable) return;
                chosenKind = kind.id;
                resumeFrom = null;
                renderKinds();
                renderResume();
              },
            },
              h('span', { class: 'kind-opt-dot' }),
              h('span', { class: 'kind-opt-name' }, kind.name),
              unavailable ? h('span', { class: 'kind-opt-note' }, 'not installed') : null,
            ));
          }
          if (!kindsReported()) {
            kindGrid.append(h('p', { class: 'sheet-note kind-note' },
              'The server did not report which CLIs are installed, so none are greyed out. '
              + 'Starting an unavailable one will fail at launch.'));
          }
        }

        /** Resumable sessions of the chosen kind only. */
        function renderResume() {
          clear(resumeSlot);
          const candidates = sessions
            .filter((s) => !s.live && s.kind === chosenKind && s.resumeId)
            .slice(0, 6);
          if (!candidates.length) return;

          resumeSlot.append(h('span', { class: 'field-label' }, 'Resume a previous session'));

          const options = h('div', { class: 'resume-list' });
          const mk = (session) => {
            const active = resumeFrom === (session ? session.id : null);
            return h('button', {
              class: `resume-opt${active ? ' on' : ''}`,
              type: 'button',
              onClick: () => {
                resumeFrom = session ? session.id : null;
                if (session?.cwd) cwdInput.value = session.cwd;
                renderResume();
              },
            },
              h('span', { class: 'resume-opt-name' }, session ? projectName(session) : 'Start fresh'),
              h('span', { class: 'resume-opt-desc' },
                session
                  ? `${prettyPath(session.cwd)} · ${relativeTime(session.lastActivity)}`
                  : 'No prior transcript'),
            );
          };
          options.append(mk(null));
          for (const s of candidates) options.append(mk(s));
          resumeSlot.append(options);
        }

        const chips = recentCwds().map((cwd) =>
          h('button', {
            class: 'chip', type: 'button',
            onClick: () => { cwdInput.value = cwd; },
          }, prettyPath(cwd)));

        function start() {
          const cwd = cwdInput.value.trim();
          if (!cwd) { toast('Enter a working directory', { error: true }); return; }
          const args = argsInput.value.trim() ? argsInput.value.trim().split(/\s+/) : undefined;
          const resumeId = resumeFrom
            ? (sessions.find((s) => s.id === resumeFrom)?.resumeId || resumeFrom)
            : undefined;
          launch({ kind: chosenKind, cwd, resumeId, args }, submit, 'Starting…');
        }

        submit.addEventListener('click', start);
        cwdInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') start(); });

        renderKinds();
        renderResume();
        renderSaved();

        body.append(
          /* The command field leads the sheet. Anything the Mac can run is
             reachable from here; the preset tiles below are shortcuts to the
             four commands the user runs most, not the limit of the product. */
          h('div', { class: 'sheet-field cmd-field' },
            h('div', { class: 'launch-head' },
              h('span', { class: 'field-label' }, 'Run a command'),
              h('span', { class: 'launch-head-note' }, 'login shell'),
            ),
            h('div', { class: 'cmd-row' }, cmdInput, cmdGo),
            h('div', { class: 'cmd-actions' }, cmdSave),
          ),
          savedSlot,
          h('div', { class: 'sheet-field' },
            h('span', { class: 'field-label' }, 'Working directory'),
            cwdInput,
            chips.length ? h('div', { class: 'chips' }, chips) : null,
          ),
          h('div', { class: 'sheet-field' },
            h('div', { class: 'launch-head' },
              h('span', { class: 'field-label' }, 'Or start a tool'),
            ),
            kindGrid,
          ),
          resumeSlot,
          h('div', { class: 'sheet-field' },
            h('span', { class: 'field-label' }, 'Extra CLI arguments'),
            argsInput,
          ),
          submit,
        );

        // Saved commands are fetched on view show, but a list that changed on
        // another device (or on the Mac itself) should still be right here.
        loadCommands().then(renderSaved).catch(() => {});
      },
    });
  }

  function openMenu() {
    sheet({
      title: 'Term Remote',
      build(body, close) {
        body.append(
          menuItem('Refresh now', 'Re-read the session list', 'refresh', () => { close(); load(); }),
          // Its own sheet: turning notifications on has to explain iOS's
          // Home-Screen rule, and the permission prompt must come from a tap.
          pushMenuRow(() => { close(); openPushSheet(); }),
          menuItem('Forget token', 'Sign out of this device', 'logout', async () => {
            close();
            const ok = await confirmSheet({
              title: 'Forget token',
              message: 'The stored access token is removed from this device. You will need to paste it again.',
              confirmLabel: 'Forget token',
              danger: true,
            });
            if (ok) {
              clearToken();
              window.dispatchEvent(new CustomEvent('cr:unauthorized'));
            }
          }, true),
          h('p', { class: 'sheet-note' },
            `Connected to ${location.host}. Sessions refresh every ${POLL_INTERVAL / 1000}s.`),
        );
      },
    });
  }

  function menuItem(name, desc, iconName, onClick, danger = false) {
    return h('div', {
      class: `sheet-item${danger ? ' danger' : ''}`,
      role: 'button', tabindex: '0', onClick,
    },
      icon(iconName, 19),
      h('div', { class: 'sheet-item-main' },
        h('div', { class: 'sheet-item-name' }, name),
        h('div', { class: 'sheet-item-desc' }, desc),
      ),
    );
  }

  /* --------------------------------------------------------------- wiring */

  function setFilter(value) {
    filter = value;
    searchClear.hidden = !value;
    render();
  }

  searchInput.addEventListener('input', () => setFilter(searchInput.value.trim()));
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    setFilter('');
    searchInput.blur();
  });
  btnRefresh.addEventListener('click', () => load());
  btnNew.addEventListener('click', () => openNewSheet());
  btnMenu.addEventListener('click', openMenu);
  btnShell.addEventListener('click', startShell);
  btnShellDir.addEventListener('click', openShellDirSheet);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && visible) load({ quiet: true });
  });

  schedulePoll();

  return {
    show() {
      visible = true;
      renderQuickstart();
      render();
      load({ quiet: loadedOnce });
      loadProjects();
      loadCommands();
      listScroll.scrollTop = 0;
    },
    hide() { visible = false; },
    reload: () => load({ quiet: true }),
    find: (id) => sessions.find((s) => s.id === id) || null,
    openNew: (prefill) => openNewSheet(prefill),
    markGone(id) {
      sessions = sessions.filter((s) => s.id !== id);
      if (visible) render();
    },
    /**
     * A dormant row became a running session. Swap it for the live one straight
     * away rather than waiting for the next poll: the row the user just tapped
     * would otherwise still sit under "Resumable", which is now a lie, and
     * tapping it again would look like the right way to get back to it.
     */
    markResumed(dormantId, live) {
      if (!live?.id) return;
      sessions = sessions.filter((s) => s.id !== dormantId && s.id !== live.id);
      sessions.unshift({ ...live, live: true });
      if (visible) render();
      load({ quiet: true });
    },
  };
}
