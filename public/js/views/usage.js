/**
 * Token usage — what the transcripts on this Mac actually consumed.
 *
 * TWO RULES THIS VIEW EXISTS TO ENFORCE, and which must survive any edit:
 *
 * 1. THE FOUR TOKEN BUCKETS ARE NEVER ADDED TOGETHER. Input, output,
 *    cache-read and cache-creation are billed at rates an order of magnitude
 *    apart, and cache reads outnumber everything else by ~100:1. One real
 *    session here reads 2,691,941,380 cached tokens against 2,942,961 output
 *    and 156,985 input; rendering that as "2.7B tokens" would tell the user
 *    they had spent roughly ten times what they actually did. Every figure on
 *    this screen is therefore per-bucket, and the only combined number shown
 *    is the cost, where the rates have already been applied.
 *
 * 2. COST IS AN ESTIMATE. It comes from usage-prices.json, a file the user
 *    edits, priced against a public rate card — not from a bill. The word
 *    "estimated" is on the headline figure, not buried in a footnote, and any
 *    model with no rate card is named rather than silently counted as free.
 *
 * 3. CLAUDE AND CODEX ARE NEVER SUMMED. Codex's `input` is cache-inclusive and
 *    it has no cache-write bucket, so a combined token figure would be adding
 *    quantities that do not mean the same thing. Their costs are not added
 *    either: the Claude figure is priced from a published rate card, the Codex
 *    one from admitted placeholders, and one total would launder the second
 *    into looking as solid as the first. They sit side by side, each labelled.
 */

import { api, ApiError } from '../api.js';
import {
  h, clear, icon, toast, sheet, relativeTime, prettyPath,
} from '../ui.js';

const WINDOWS = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
];

/** The four buckets, in the order they are always shown. `cls` matches usage.css. */
const BUCKETS = [
  { key: 'input', label: 'Input', cls: 'in' },
  { key: 'output', label: 'Output', cls: 'out' },
  { key: 'cacheRead', label: 'Cache read', cls: 'cr' },
  { key: 'cacheWrite', label: 'Cache write', cls: 'cw' },
];

const PROJECTS_COLLAPSED = 8;

export function createUsageView() {
  const body = document.getElementById('usage-body');
  const scroll = document.getElementById('usage-scroll');
  const segbar = document.getElementById('usage-windows');
  const btnRefresh = document.getElementById('btn-usage-refresh');

  let window_ = 'all';
  let data = null;        // /api/usage
  let projects = null;    // /api/usage/projects
  let codex = null;       // /api/usage/codex — fetched once, not window-scoped
  let error = null;
  let inFlight = false;
  let loadedOnce = false;
  let visible = false;
  let showAllProjects = false;

  btnRefresh.append(icon('refresh'));

  /* ------------------------------------------------------------- loading */

  async function load({ quiet = false, force = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    if (!quiet) btnRefresh.classList.add('spinning');
    renderSegbar();
    try {
      if (force) await api.usageRefresh();
      const [overview, byProject] = await Promise.all([
        api.usage(window_),
        api.usageProjects(window_),
      ]);
      data = overview;
      projects = byProject;
      error = null;
      loadedOnce = true;
      // Codex is a separate, slower source and is not window-scoped. Its
      // absence must never blank the Claude figures.
      if (!codex) codex = await api.usageCodex().catch(() => null);
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) return; // main.js bounces to the token screen
      error = err;
      if (!quiet) toast(err.message || 'Could not load usage', { error: true });
    } finally {
      inFlight = false;
      btnRefresh.classList.remove('spinning');
      render();
    }
  }

  /* ----------------------------------------------------------- rendering */

  function renderSegbar() {
    clear(segbar);
    for (const w of WINDOWS) {
      segbar.append(h('button', {
        class: `seg${w.id === window_ ? ' on' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': w.id === window_ ? 'true' : 'false',
        disabled: inFlight || null,
        onClick: () => {
          if (w.id === window_) return;
          window_ = w.id;
          showAllProjects = false;
          renderSegbar();
          load({ quiet: true });
        },
      }, w.label));
    }
  }

  function render() {
    renderSegbar();
    clear(body);

    if (error && !loadedOnce) { renderError(); return; }
    if (!loadedOnce) { renderSkeleton(); return; }

    body.append(hero());

    if (!data.requests) {
      body.append(h('div', { class: 'state' },
        h('p', { class: 'state-title' }, 'No usage in this window'),
        h('p', { class: 'state-sub' }, 'Nothing was sent to the API in the selected period.'),
      ));
    } else {
      body.append(splitCard());
      body.append(modelCard());
      body.append(projectCard());
    }

    body.append(codexCard());
    body.append(basisCard());
  }

  function renderSkeleton() {
    for (let i = 0; i < 5; i++) body.append(h('div', { class: 'skeleton' }));
  }

  function renderError() {
    body.append(h('div', { class: 'state' },
      h('p', { class: 'state-title' }, 'Cannot load usage'),
      h('p', { class: 'state-sub' }, error?.message || 'The server did not answer.'),
      h('button', { class: 'btn btn-primary', onClick: () => load() }, 'Retry'),
    ));
  }

  /* ------------------------------------------------------------ sections */

  /**
   * Headline. Cost leads because it is the one number that legitimately
   * combines the buckets; the buckets themselves follow, each on its own tile,
   * so there is no place on this screen where a single "tokens" figure exists.
   */
  function hero() {
    const t = data.tokens;
    const cost = data.cost;
    const cx = codexHeadline();

    const wrap = h('div', { class: 'usage-hero' });

    // Two costs, side by side, never added. See rule 3 at the top of this file.
    wrap.append(metric(
      'Claude — estimated',
      money(cost.total, cost.currency),
      `${exact(data.requests)} request${data.requests === 1 ? '' : 's'}`,
      { accent: true },
    ));

    if (cx.available) {
      wrap.append(metric(
        cx.placeholder ? 'Codex — placeholder' : 'Codex — estimated',
        money(cx.total, cx.currency),
        `${exact(cx.sessions)} session${cx.sessions === 1 ? '' : 's'}`,
        { placeholder: cx.placeholder },
      ));
    } else {
      wrap.append(metric('Codex', 'none found', 'no rollouts on this Mac'));
    }

    wrap.append(h('p', { class: 'unote wide' },
      'Shown apart, not added: the Claude figure is priced from a published rate card, '
      + 'the Codex one from placeholder rates.'));

    wrap.append(h('p', { class: 'ugroup-label wide' }, 'Claude tokens'));

    for (const b of BUCKETS) {
      const sub = b.key === 'cacheWrite'
        ? `${compact(t.cacheWrite5m)} 5m · ${compact(t.cacheWrite1h)} 1h`
        : exact(t[b.key]);
      wrap.append(metric(b.label, compact(t[b.key]), sub, { bucket: b.cls }));
    }

    if (!cost.complete && cost.unpricedModels?.length) {
      wrap.append(h('p', { class: 'unote unote-warn wide' },
        `No rate card for ${cost.unpricedModels.join(', ')} — those tokens are counted but not costed.`));
    }

    return wrap;
  }

  /**
   * Flatten whichever Codex shape we have into one headline.
   *
   * Two shapes carry these numbers: the compact block inside /api/usage
   * (`{available, sessions, cost}`) and the full /api/usage/codex payload
   * (`{tokenAccounting.available, count, cost}`). Reading the wrong field is
   * how the tile ended up saying "none found" while the card below it showed
   * $1,266 of real data, so the folding happens here, once.
   */
  function codexHeadline() {
    const full = codex;
    const brief = data?.codex;
    const available = Boolean(full?.tokenAccounting?.available ?? brief?.available);
    const cost = full?.cost || brief?.cost || null;
    return {
      available: available && Boolean(cost),
      sessions: full?.count ?? brief?.sessions ?? 0,
      total: cost?.total ?? 0,
      currency: cost?.currency || 'USD',
      placeholder: Boolean(cost?.placeholder ?? full?.costPlaceholder ?? brief?.costPlaceholder),
    };
  }

  function metric(label, value, sub, { wide = false, accent = false, bucket = null, placeholder = false } = {}) {
    return h('div', {
      class: `umetric${wide ? ' wide' : ''}${accent ? ' accent' : ''}`
        + `${placeholder ? ' placeholder' : ''}${bucket ? ` tok-${bucket}` : ''}`,
    },
      h('div', { class: 'umetric-label' }, label),
      h('div', { class: 'umetric-value' }, value),
      sub ? h('div', { class: 'umetric-sub' }, sub) : null,
    );
  }

  /** Proportional bar over the four buckets, with the exact count beside each. */
  function splitCard() {
    const t = data.tokens;
    const total = BUCKETS.reduce((sum, b) => sum + (t[b.key] || 0), 0);

    const bar = h('div', { class: 'usplit' });
    const legend = h('div', { class: 'ulegend' });

    for (const b of BUCKETS) {
      const value = t[b.key] || 0;
      const pct = total ? (value / total) * 100 : 0;
      if (pct > 0) {
        bar.append(h('span', {
          class: `usplit-seg tok-${b.cls}`,
          style: { width: `${pct}%` },
          title: `${b.label}: ${exact(value)}`,
        }));
      }
      legend.append(h('span', { class: 'ulegend-item' },
        h('span', { class: `ulegend-dot tok-${b.cls}` }),
        b.label,
        h('span', { class: 'ulegend-n' }, exact(value)),
      ));
    }

    return h('div', { class: 'ucard' },
      h('h2', { class: 'ucard-title' }, 'Token mix'),
      bar,
      legend,
      h('p', { class: 'unote' },
        'Shown separately on purpose. Cache reads are roughly a tenth the price of '
        + 'input tokens and vastly outnumber them, so a single combined total would '
        + 'badly overstate what was spent.'),
    );
  }

  function modelCard() {
    const card = h('div', { class: 'ucard' }, h('h2', { class: 'ucard-title' }, 'By model'));
    const max = Math.max(...data.byModel.map((m) => m.cost?.total ?? 0), 0);
    for (const m of data.byModel) card.append(usageRow({
      name: m.model,
      cost: m.cost,
      max,
      tokens: m.tokens,
      requests: m.requests,
    }));
    return card;
  }

  function projectCard() {
    const all = projects?.projects || [];
    const shown = showAllProjects ? all : all.slice(0, PROJECTS_COLLAPSED);
    const max = Math.max(...all.map((p) => p.cost?.total ?? 0), 0);

    const card = h('div', { class: 'ucard' },
      h('h2', { class: 'ucard-title' }, 'By project'));

    for (const p of shown) card.append(usageRow({
      name: prettyPath(p.projectDir) || p.projectDirName,
      cost: p.cost,
      max,
      tokens: p.tokens,
      requests: p.requests,
      meta: [
        p.sessions ? `${exact(p.sessions)} session${p.sessions === 1 ? '' : 's'}` : null,
        p.lastActivity ? relativeTime(p.lastActivity) : null,
      ].filter(Boolean).join(' · '),
    }));

    if (all.length > PROJECTS_COLLAPSED) {
      card.append(h('button', {
        class: 'ulink', type: 'button',
        onClick: () => { showAllProjects = !showAllProjects; render(); },
      }, showAllProjects ? 'Show fewer' : `Show all ${all.length} projects`));
    }

    if (!all.length) card.append(h('p', { class: 'unote' }, 'No project activity in this window.'));
    return card;
  }

  /**
   * One row: name, estimated cost, a bar showing its share of the estimate, and
   * the four buckets spelled out underneath.
   */
  function usageRow({ name, cost, max, tokens, requests, meta }) {
    const total = cost?.total ?? null;
    const pct = total != null && max > 0 ? Math.max(1.5, (total / max) * 100) : 0;

    return h('div', { class: 'urow' },
      h('div', { class: 'urow-top' },
        h('span', { class: 'urow-name' }, name),
        h('span', { class: 'urow-val' }, total == null ? 'unpriced' : money(total, cost.currency)),
      ),
      h('div', { class: 'ubar' }, h('span', { class: 'ubar-fill', style: { width: `${pct}%` } })),
      h('div', { class: 'urow-sub' },
        BUCKETS.map((b) => `${b.label.toLowerCase()} ${compact(tokens[b.key])}`).join(' · ')
        + (requests ? ` · ${exact(requests)} req` : '')
        + (meta ? ` · ${meta}` : '')),
    );
  }

  /**
   * Codex, parsed from ~/.codex/sessions/**‍/rollout-*.jsonl.
   *
   * Its accounting is genuinely different from Claude's, so it is rendered on
   * its own terms rather than being squeezed into the Claude buckets:
   *   - `input` is CACHE-INCLUSIVE, so the split bar is uncached | cached |
   *     output, which are the three quantities that actually sum to the total.
   *   - `reasoning` is a SUBSET of output, so it appears indented as "of which"
   *     and never as its own bar segment — it must not read as additive.
   */
  function codexCard() {
    const card = h('div', { class: 'ucard' }, h('h2', { class: 'ucard-title' }, 'Codex'));

    if (!codex) {
      card.append(h('p', { class: 'unote' }, 'No Codex accounting available from this server.'));
      return card;
    }

    const acc = codex.tokenAccounting;
    if (!acc?.available) {
      card.append(h('div', { class: 'urow-top' },
        h('span', { class: 'urow-name' }, 'Token counts'),
        h('span', { class: 'urow-val unavailable' }, 'unavailable'),
      ));
      for (const where of acc?.notAvailableIn || []) {
        card.append(h('p', { class: 'unote unote-thin' }, where));
      }
      return card;
    }

    const t = codex.totals || {};

    card.append(h('div', { class: 'urow-top' },
      h('span', { class: 'urow-name' }, 'Estimated cost'),
      h('span', { class: `urow-val${codex.costPlaceholder ? ' placeholder' : ''}` },
        money(codex.cost.total, codex.cost.currency)),
    ));
    if (codex.costPlaceholder) {
      card.append(h('p', { class: 'unote unote-warn' }, codex.costReason));
    }

    // uncached + cached + output is the honest three-way split: Codex's own
    // records satisfy input + output == total, with cached inside input.
    const parts = [
      { label: 'Input (uncached)', value: t.inputUncached, cls: 'in' },
      { label: 'Input (cached)', value: t.inputCached, cls: 'cr' },
      { label: 'Output', value: t.output, cls: 'out' },
    ];
    const sum = parts.reduce((a, p) => a + (p.value || 0), 0);

    const bar = h('div', { class: 'usplit' });
    const legend = h('div', { class: 'ulegend' });
    for (const p of parts) {
      const pct = sum ? ((p.value || 0) / sum) * 100 : 0;
      if (pct > 0) {
        bar.append(h('span', {
          class: `usplit-seg tok-${p.cls}`,
          style: { width: `${pct}%` },
          title: `${p.label}: ${exact(p.value)}`,
        }));
      }
      legend.append(h('span', { class: 'ulegend-item' },
        h('span', { class: `ulegend-dot tok-${p.cls}` }),
        p.label,
        h('span', { class: 'ulegend-n' }, exact(p.value || 0)),
      ));
    }

    card.append(h('p', { class: 'unote unote-head' },
      `${exact(codex.count)} session${codex.count === 1 ? '' : 's'}`));
    card.append(bar);
    card.append(legend);

    // Indented, and never a bar segment: reasoning tokens are already counted
    // inside Output above. Charging or adding them again would double-count.
    card.append(h('p', { class: 'unote unote-nested' },
      `of the output, ${exact(t.reasoningOutput)} were reasoning tokens `
      + '(already included above, billed at the output rate).'));

    if (codex.byModel?.length) {
      const max = Math.max(...codex.byModel.map((m) => m.cost?.total ?? 0), 0);
      card.append(h('p', { class: 'ugroup-label' }, 'By model'));
      for (const m of codex.byModel) {
        card.append(h('div', { class: 'urow' },
          h('div', { class: 'urow-top' },
            h('span', { class: 'urow-name' }, m.model),
            h('span', { class: `urow-val${codex.costPlaceholder ? ' placeholder' : ''}` },
              m.cost ? money(m.cost.total, codex.cost.currency) : 'unpriced'),
          ),
          h('div', { class: 'ubar' }, h('span', {
            class: 'ubar-fill',
            style: { width: `${m.cost && max > 0 ? Math.max(1.5, (m.cost.total / max) * 100) : 0}%` },
          })),
          h('div', { class: 'urow-sub' },
            `uncached ${compact(m.tokens.inputUncached)} · cached ${compact(m.tokens.inputCached)} · `
            + `output ${compact(m.tokens.output)} · ${exact(m.sessions)} session${m.sessions === 1 ? '' : 's'}`),
        ));
      }
    }

    if (acc.caveat) card.append(h('p', { class: 'unote' }, acc.caveat));
    return card;
  }

  /** Where the cost estimate comes from, and how to change it. */
  function basisCard() {
    const p = data?.prices;
    const scan = data?.scan;
    return h('div', { class: 'ucard ucard-quiet' },
      h('h2', { class: 'ucard-title' }, 'Cost basis'),
      h('p', { class: 'unote' },
        p?.note || 'All costs are estimates from a user-editable price table, not billed amounts.'),
      h('p', { class: 'unote unote-thin' },
        [
          p?.updatedAt ? `Rates dated ${p.updatedAt}` : null,
          p?.currency,
          scan ? `${exact(scan.files)} transcripts scanned in ${scan.scanMs}ms` : null,
        ].filter(Boolean).join(' · ')),
      h('button', { class: 'ulink', type: 'button', onClick: openPrices }, 'View the rate table'),
    );
  }

  async function openPrices() {
    let table;
    try {
      table = await api.usagePrices();
    } catch (err) {
      toast(err.message || 'Could not load prices', { error: true });
      return;
    }
    sheet({
      title: 'Estimated rates',
      build(sheetBody) {
        sheetBody.append(h('p', { class: 'sheet-note' },
          `US dollars per million tokens. Edit ${table.path || 'usage-prices.json'} on the Mac `
          + 'to change them; the server picks the file up on its next read.'));

        const grid = h('div', { class: 'ptable' });
        grid.append(
          h('span', { class: 'ptable-h' }, 'Model'),
          h('span', { class: 'ptable-h num' }, 'In'),
          h('span', { class: 'ptable-h num' }, 'Out'),
          h('span', { class: 'ptable-h num' }, 'Read'),
          h('span', { class: 'ptable-h num' }, 'Write'),
        );
        for (const [model, r] of Object.entries(table.models || {})) {
          grid.append(
            h('span', { class: 'ptable-model' }, model),
            h('span', { class: 'num' }, rate(r.input)),
            h('span', { class: 'num' }, rate(r.output)),
            h('span', { class: 'num' }, rate(r.cacheRead)),
            h('span', { class: 'num' }, rate(r.cacheWrite1h ?? r.cacheWrite5m)),
          );
        }
        sheetBody.append(grid);
        sheetBody.append(h('p', { class: 'sheet-note' },
          'Write is the 1-hour cache rate, which is the one Claude Code actually uses. '
          + (table.source || '')));

        const codexModels = Object.entries(table.codexModels || {});
        if (codexModels.length) {
          sheetBody.append(h('h3', { class: 'sheet-subtitle' }, 'Codex'));
          if (table.codexRatesArePlaceholders) {
            sheetBody.append(h('p', { class: 'sheet-note warn' },
              'PLACEHOLDER rates — not from a published rate card. Every Codex cost in this app '
              + 'is derived from these, so treat it as a shape, not a bill.'));
          }
          const cgrid = h('div', { class: 'ptable ptable-codex' });
          cgrid.append(
            h('span', { class: 'ptable-h' }, 'Model'),
            h('span', { class: 'ptable-h num' }, 'Uncached in'),
            h('span', { class: 'ptable-h num' }, 'Cached in'),
            h('span', { class: 'ptable-h num' }, 'Out'),
          );
          for (const [model, r] of codexModels) {
            cgrid.append(
              h('span', { class: 'ptable-model' }, model),
              h('span', { class: 'num' }, rate(r.input)),
              h('span', { class: 'num' }, rate(r.cachedInput)),
              h('span', { class: 'num' }, rate(r.output)),
            );
          }
          sheetBody.append(cgrid);
          sheetBody.append(h('p', { class: 'sheet-note' },
            table.codexNote
            || 'Codex input is cache-inclusive; only the uncached remainder is charged at the input rate.'));
          sheetBody.append(h('p', { class: 'sheet-note' },
            'Reasoning tokens have no rate of their own on purpose — they are already inside the '
            + 'output count and are billed at the output rate. Pricing them separately would '
            + 'charge them twice.'));
        }
      },
    });
  }

  /* --------------------------------------------------------------- wiring */

  btnRefresh.addEventListener('click', () => {
    codex = null; // re-read Codex too on an explicit refresh
    load({ force: true });
  });

  return {
    show() {
      visible = true;
      render();
      load({ quiet: loadedOnce });
      scroll.scrollTop = 0;
    },
    hide() { visible = false; },
    reload: () => (visible ? load({ quiet: true }) : undefined),
  };
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** 8979950178 -> "8.98B". For headlines and dense rows only. */
function compact(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  for (const [div, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
    if (n >= div) {
      const v = n / div;
      return `${v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)}${suffix}`;
    }
  }
  return String(n);
}

/** 8979950178 -> "8,979,950,178". Every compacted figure has one of these near it. */
function exact(value) {
  return (Number(value) || 0).toLocaleString('en-US');
}

/**
 * Sub-dollar estimates get four decimals: a per-session figure of "$0.00" would
 * look like nothing was spent when it was simply small.
 */
function money(value, currency = 'USD') {
  const n = Number(value) || 0;
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  try {
    return n.toLocaleString('en-US', {
      style: 'currency', currency,
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
  } catch {
    return `$${n.toFixed(digits)}`;
  }
}

function rate(value) {
  return value == null ? '—' : `$${Number(value)}`;
}
