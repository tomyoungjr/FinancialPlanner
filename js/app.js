/* The page: screens, inputs, and wiring to the engine. All data stays in this browser. */
(function () {
  'use strict';
  const E = window.Engine, C = window.Charts;
  const STORE = 'nonlinearPlanner.v1', HIDE = 'nonlinearPlanner.hide';
  const clone = o => JSON.parse(JSON.stringify(o));
  const $ = id => document.getElementById(id);

  // ------------------------------------------------------------------ state
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function deepMerge(base, over) {
    for (const k in over) {
      if (isObj(base[k]) && isObj(over[k])) deepMerge(base[k], over[k]);
      else base[k] = over[k];
    }
    return base;
  }
  function fresh() { return Object.assign(clone(window.DEFAULTS), { ui: { tab: 'plan', scenarioMarket: 'linear' } }); }
  function load() {
    const s = fresh();
    try { const saved = JSON.parse(localStorage.getItem(STORE)); if (saved) deepMerge(s, saved); } catch (e) { /* private window */ }
    return s;
  }
  let state = load();
  function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* ignore */ } }

  let hide = { on: false, factor: 1 };
  try { hide = JSON.parse(localStorage.getItem(HIDE)) || hide; } catch (e) { /* ignore */ }
  if (!hide.factor || hide.factor === 1) hide.factor = 0.4 + Math.random() * 2.2;

  // ------------------------------------------------------------------ formatting
  const hidden = () => hide.on;
  function money(v) {
    if (v === undefined || v === null || !isFinite(v)) return '—';
    v *= hidden() ? hide.factor : 1;
    const a = Math.abs(v), sign = v < 0 ? '−' : '';
    if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
    if (a >= 1e4) return sign + '$' + Math.round(a / 1e3) + 'K';
    return sign + '$' + Math.round(a).toLocaleString();
  }
  // Axis labels: same as money() but without rounding to K so round ticks stay round.
  function axisMoney(v) {
    v *= hidden() ? hide.factor : 1;
    if (v === 0) return '$0';
    if (v >= 1e6) return '$' + +(v / 1e6).toFixed(2) + 'M';
    return '$' + +(v / 1e3).toFixed(0) + 'K';
  }
  const chartOpts = extra => Object.assign({ format: money, axisFormat: axisMoney, scale: hidden() ? hide.factor : 1 }, extra);
  const pct = (v, d) => (v === undefined || !isFinite(v)) ? '—' : (v * 100).toFixed(d || 0) + '%';
  const pts = d => (!isFinite(d)) ? '—' : (d >= 0 ? '+' : '−') + Math.abs(d * 100).toFixed(1) + ' pts';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------ engine cache
  // Markets depend only on the worldview and the timeline, so household edits reuse them.
  const ctxCache = new Map();
  function getCtx(kind, extra) {
    const h = state.household;
    const key = JSON.stringify([kind, state.world, h.startYear, h.currentAge, h.planToAge, extra || {}]);
    if (!ctxCache.has(key)) {
      if (ctxCache.size > 16) ctxCache.clear();
      ctxCache.set(key, E.makeContext(h, state.world, kind, extra));
    }
    return ctxCache.get(key);
  }

  // ------------------------------------------------------------------ tabs
  const ICONS = {
    plan: '<path d="M3 17l5-6 4 3 7-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    scenarios: '<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="7" cy="18" r="2" fill="currentColor"/>',
    world: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    moves: '<path d="M5 19V9M12 19V5M19 19v-7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>',
    inputs: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20c1-4 4-6 8-6s7 2 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    about: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  };
  const TABS = [['plan', 'Plan'], ['scenarios', 'Scenarios'], ['world', 'Your world'], ['moves', 'Moves'], ['inputs', 'Inputs'], ['about', 'How it works']];
  $('tabs').innerHTML = TABS.map(([k, label]) =>
    `<button role="tab" data-tab="${k}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>${label}</button>`).join('');
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    state.ui.tab = b.dataset.tab; save(); render(); window.scrollTo(0, 0);
  });

  // ------------------------------------------------------------------ generic inputs
  function getPath(path) { return path.split('.').reduce((o, k) => (o ? o[k] : undefined), state); }
  function setPath(path, v) {
    const ks = path.split('.'), last = ks.pop();
    ks.reduce((o, k) => o[k], state)[last] = v;
  }
  function input(path, kind, attrs) {
    const v = getPath(path);
    attrs = attrs || '';
    if (kind === 'check') return `<input type="checkbox" data-path="${path}" data-kind="check" ${v ? 'checked' : ''} ${attrs}>`;
    if (kind === 'money' && hidden()) return `<input type="text" value="hidden" disabled title="Turn off Hide $ to edit">`;
    let shown = v, step = 1;
    if (kind === 'pct') { shown = +(v * 100).toFixed(2); step = 0.5; }
    if (kind === 'money') step = 1000;
    if (kind === 'mult') { shown = +(v * 100).toFixed(1); step = 5; }
    return `<input type="number" data-path="${path}" data-kind="${kind}" value="${shown}" step="${step}" ${attrs}>`;
  }
  function select(path, options) {
    const v = getPath(path);
    return `<select data-path="${path}" data-kind="select">${options.map(([val, label]) =>
      `<option value="${val}" ${val === v ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
  }
  document.addEventListener('change', e => {
    const t = e.target;
    if (!t.dataset || !t.dataset.path) return;
    const kind = t.dataset.kind;
    let v;
    if (kind === 'check') v = t.checked;
    else if (kind === 'select') v = t.value;
    else {
      v = parseFloat(t.value);
      if (!isFinite(v)) { render(); return; }
      if (kind === 'pct' || kind === 'mult') v /= 100;
      if (kind === 'int') v = Math.round(v);
    }
    setPath(t.dataset.path, v);
    save();
    scheduleRender();
  });

  // ------------------------------------------------------------------ rendering
  let pending = null;
  function scheduleRender() {
    $('status').textContent = 'Calculating…';
    clearTimeout(pending);
    pending = setTimeout(render, 30);
  }
  function render() {
    const tab = state.ui.tab;
    document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
    document.querySelectorAll('section.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + tab));
    $('hideMoney').checked = hide.on;
    const t0 = performance.now();
    try {
      ({ plan: renderPlan, scenarios: renderScenarios, world: renderWorld, moves: renderMoves, inputs: renderInputs, about: () => {} })[tab]();
      const n = state.world.paths.toLocaleString();
      $('status').textContent = tab === 'about' || tab === 'inputs' ? '' : `${n} futures · ${Math.round(performance.now() - t0)} ms`;
    } catch (err) {
      console.error(err);
      $('status').textContent = 'Error: ' + err.message;
    }
  }

  function allocationWarning() {
    const a = state.household.allocation;
    const sum = a.equities + a.bonds + a.realAssets + a.cash;
    return Math.abs(sum - 1) > 0.001 ? `<div class="warn">Your investment mix adds up to ${pct(sum)}, not 100%. Fix it on the Inputs screen.</div>` : '';
  }

  const SERIES = [{ name: 'Classic plan', color: 'var(--series-1)' }, { name: 'Your world', color: 'var(--series-2)' }];

  // ---- Plan
  function renderPlan() {
    const h = state.household;
    const lin = getCtx('linear').run(h), wor = getCtx('world').run(h);
    const a = E.summary(lin), b = E.summary(wor);
    const d = b.successRate - a.successRate;
    const cutText = h.strategy === 'guardrails'
      ? `<div class="value">${pct(b.cutShare)}</div><div class="sub">of futures in your world need a cut; typical deepest cut ${pct(b.medianDeepestCut)} of discretionary spending</div>`
      : `<div class="value">Off</div><div class="sub">Spending never flexes (the classic 4% rule). Turn on guardrails in Inputs.</div>`;
    $('planTiles').innerHTML = allocationWarning() + `
      <div class="card tile"><div class="label"><span class="key" style="background:var(--series-1)"></span>Classic plan: money lasts to ${h.planToAge}</div>
        <div class="value">${pct(a.successRate)}</div><div class="sub">steady markets, today's law</div></div>
      <div class="card tile"><div class="label"><span class="key" style="background:var(--series-2)"></span>Your world: money lasts</div>
        <div class="value">${pct(b.successRate)}</div><div class="sub ${d < 0 ? 'delta-neg' : 'delta-pos'}">${pts(d)} vs the classic plan</div></div>
      <div class="card tile"><div class="label">First-year withdrawal rate</div>
        <div class="value">${pct(b.firstWithdrawalRate, 1)}</div><div class="sub">of the portfolio, the year you retire (the "4% rule" number)</div></div>
      <div class="card tile"><div class="label">Spending cutbacks</div>${cutText}</div>`;
    const bl = E.bands(lin), bw = E.bands(wor);
    C.fanChart($('planChart'), [
      Object.assign({ rows: bl }, SERIES[0]), Object.assign({ rows: bw }, SERIES[1]),
    ], chartOpts({ label: 'Portfolio in today\'s dollars by age, classic plan vs your world' }));
    const every = rows => rows.filter(r => r.age % 5 === 0);
    $('planChartTable').innerHTML = `<table><thead><tr><th>Age</th><th class="num">Classic typical</th><th class="num">Classic bad case</th><th class="num">Your world typical</th><th class="num">Your world bad case</th></tr></thead><tbody>` +
      every(bw).map(r => { const l = bl.find(x => x.age === r.age) || {};
        return `<tr><td>${r.age}</td><td class="num">${money(l.p50)}</td><td class="num">${money(l.p10)}</td><td class="num">${money(r.p50)}</td><td class="num">${money(r.p10)}</td></tr>`; }).join('') + '</tbody></table>';
    const age = x => isFinite(x) ? Math.round(x) : 'never';
    $('planTable').innerHTML = `<table><thead><tr><th></th><th class="num">Classic plan</th><th class="num">Your world</th></tr></thead><tbody>
      <tr><td>Chance the money lasts</td><td class="num">${pct(a.successRate)}</td><td class="num">${pct(b.successRate)}</td></tr>
      <tr><td>Typical (median) ending portfolio, today's dollars</td><td class="num">${money(a.medianEnd)}</td><td class="num">${money(b.medianEnd)}</td></tr>
      <tr><td>Bad case (10th percentile) ending portfolio</td><td class="num">${money(a.p10End)}</td><td class="num">${money(b.p10End)}</td></tr>
      <tr><td>Lowest yearly living spending in retirement (excl. health), typical future</td><td class="num">${money(a.medianMinSpending)}</td><td class="num">${money(b.medianMinSpending)}</td></tr>
      <tr><td>If the money runs out, typical age</td><td class="num">${age(a.medianDepletionAge)}</td><td class="num">${age(b.medianDepletionAge)}</td></tr>
      <tr><td>Futures that needed a spending cut</td><td class="num">${pct(a.cutShare)}</td><td class="num">${pct(b.cutShare)}</td></tr>
    </tbody></table>`;
  }

  // ---- Scenarios
  const SWITCH_SETTINGS = {
    ssCut: [['cut', 'pct', 'cut']],
    universalHealthcare: [['tax', 'pct', 'tax']],
    ubi: [['perAdult', 'money', 'per adult'], ['vat', 'pct', 'VAT']],
    wealthTax: [['rate', 'pct', 'a year'], ['threshold', 'money', 'above']],
    capitalGains: [['delta', 'pct', 'points']],
    meansTest: [['reduction', 'pct', 'cut'], ['threshold', 'money', 'if savings above']],
  };
  function renderScenarios() {
    const h = state.household, sw = state.switches;
    document.querySelectorAll('#scenarioMarket button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === state.ui.scenarioMarket));
    $('switchTable').innerHTML = `<table><thead><tr><th>In combo</th><th>Switch</th><th>Starts</th><th>Setting</th><th>What pays for it</th></tr></thead><tbody>` +
      Object.keys(sw).map(k => `<tr><td>${input(`switches.${k}.on`, 'check')}</td><td>${esc(sw[k].label)}</td>
        <td>${input(`switches.${k}.year`, 'int', 'style="width:84px"')}</td>
        <td><div class="row">${SWITCH_SETTINGS[k].map(([p, kind, word]) =>
          `<span class="row" style="gap:4px">${input(`switches.${k}.${p}`, kind, 'style="width:' + (kind === 'money' ? 120 : 72) + 'px"')}<span class="muted">${kind === 'pct' ? '% ' : ''}${word}</span></span>`).join('')}</div></td>
        <td class="muted">${esc(sw[k].pays)}</td></tr>`).join('') + '</tbody></table>';

    const ctx = getCtx(state.ui.scenarioMarket === 'regimes' ? 'regimes' : 'linear');
    const base = E.summary(ctx.run(h));
    const rows = [{ name: "Today's law", s: base, baseline: true }];
    for (const k of Object.keys(sw)) rows.push({ name: sw[k].label + ' only', s: E.summary(ctx.run(h, E.activeSwitchPolicies(sw, [k]))) });
    const combo = Object.keys(sw).filter(k => sw[k].on);
    if (combo.length > 1) rows.push({ name: 'Combination: ' + combo.map(k => sw[k].label).join(' + '), s: E.summary(ctx.run(h, E.activeSwitchPolicies(sw, combo))) });
    const scale = Math.max(0.02, ...rows.map(r => Math.abs(r.s.successRate - base.successRate)));
    $('scenarioTable').innerHTML = `<table><thead><tr><th>Scenario</th><th class="num">Money lasts</th><th class="num">Change</th><th class="bar-cell"></th><th class="num">Typical ending</th><th class="num">Bad-case ending</th><th class="num">Lowest yearly living spending</th></tr></thead><tbody>` +
      rows.map(r => { const d = r.s.successRate - base.successRate;
        return `<tr class="${r.baseline ? 'baseline' : ''}"><td>${esc(r.name)}</td><td class="num">${pct(r.s.successRate)}</td>
          <td class="num">${r.baseline ? '' : pts(d)}</td><td class="bar-cell">${r.baseline ? '' : C.deltaBar(d, scale)}</td>
          <td class="num">${money(r.s.medianEnd)}</td><td class="num">${money(r.s.p10End)}</td><td class="num">${money(r.s.medianMinSpending)}</td></tr>`; }).join('') +
      '</tbody></table>';
  }
  $('scenarioMarket').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    state.ui.scenarioMarket = b.dataset.v; save(); scheduleRender();
  });

  // ---- Your world
  function regimeLabel(key) { const r = state.world.regimes.states[key]; return r ? r.label : key; }
  function describeEffects(fx) {
    const p = [];
    if (fx.ssMultiplier !== undefined) p.push(`Social Security cut ${pct(1 - fx.ssMultiplier)}`);
    if (fx.ssMeansTest) p.push(`Social Security cut ${pct(fx.ssMeansTest.reduction)} if savings are above ${money(fx.ssMeansTest.threshold)}`);
    if (fx.healthcareMultiplier !== undefined) p.push(fx.healthcareMultiplier === 0 ? 'health premiums go to $0' : `health costs ×${fx.healthcareMultiplier}`);
    if (fx.incomeTax) p.push(`+${pct(fx.incomeTax)} tax on pay and withdrawals`);
    if (fx.ubiPerAdult) p.push(`${money(fx.ubiPerAdult)} a year per adult from retirement`);
    if (fx.vat) p.push(`${pct(fx.vat)} VAT on retirement spending`);
    if (fx.capitalGainsDelta) p.push(`+${pct(fx.capitalGainsDelta)} capital gains tax`);
    if (fx.ordinaryTaxDelta) p.push(`+${pct(fx.ordinaryTaxDelta)} income tax`);
    if (fx.wealthTax) p.push(`${pct(fx.wealthTax.rate, 1)} a year on savings above ${money(fx.wealthTax.threshold)}`);
    if (fx.earnedIncomeMultiplier !== undefined) p.push(`pay cut ${pct(1 - fx.earnedIncomeMultiplier)} while working`);
    if (fx.spendingMultiplier !== undefined) p.push(`living costs ×${fx.spendingMultiplier}`);
    if (fx.planExtension) p.push(`plan must last ${fx.planExtension} more years`);
    if (fx.inflationDelta) p.push(`+${pct(fx.inflationDelta, 1)} inflation from then on`);
    if (fx.equityDelta) p.push(`${fx.equityDelta > 0 ? '+' : ''}${pct(fx.equityDelta, 1)} stock returns`);
    if (fx.forceRegime) p.push(`${fx.forceRegime.years} years of ${regimeLabel(fx.forceRegime.regime).toLowerCase()}`);
    if (fx.regimeTilt) p.push('makes ' + Object.keys(fx.regimeTilt).map(k => regimeLabel(k).toLowerCase()).join(' and ') + ' more likely');
    return p.join('; ');
  }
  function renderWorld() {
    const h = state.household, D = state.world.disruptions;
    $('disruptionTable').innerHTML = `<table><thead><tr><th>On</th><th>Disruption</th><th class="num">Chance in window</th><th>From</th><th>To</th><th>What it does</th></tr></thead><tbody>` +
      Object.keys(D).map(k => { const d = D[k];
        const boost = Object.entries(d.boostedBy || {}).map(([o, m]) => `${D[o] ? D[o].label : o} (×${m})`).join(', ');
        return `<tr><td>${input(`world.disruptions.${k}.on`, 'check')}</td>
          <td><b>${esc(d.label)}</b><div class="effects">${esc(d.note || '')}</div></td>
          <td class="num"><span class="row" style="gap:4px;justify-content:flex-end">${input(`world.disruptions.${k}.probability`, 'pct', 'style="width:72px" min="0" max="100"')}<span class="muted">%</span></span></td>
          <td>${input(`world.disruptions.${k}.window.0`, 'int', 'style="width:80px"')}</td>
          <td>${input(`world.disruptions.${k}.window.1`, 'int', 'style="width:80px"')}</td>
          <td class="effects">${esc(describeEffects(d.effects || {}))}${boost ? `<br>More likely after: ${esc(boost)}` : ''}</td></tr>`; }).join('') + '</tbody></table>';

    const wor = getCtx('world').run(h);
    const attr = E.attribution(wor, D).filter(r => D[r.key].on !== false);
    const scale = Math.max(0.02, ...attr.map(r => Math.abs(r.impact) || 0));
    $('attributionTable').innerHTML = `<table><thead><tr><th>Disruption</th><th class="num">Happens in</th><th class="num">Typical year</th><th class="num">Money lasts if it happens</th><th class="num">If it doesn't</th><th class="num">Gap</th><th class="bar-cell"></th></tr></thead><tbody>` +
      attr.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${pct(r.happened)}</td><td class="num">${isFinite(r.medianYear) ? Math.round(r.medianYear) : '—'}</td>
        <td class="num">${pct(r.successIf)}</td><td class="num">${pct(r.successIfNot)}</td><td class="num">${pts(r.impact)}</td><td class="bar-cell">${isFinite(r.impact) ? C.deltaBar(r.impact, scale) : ''}</td></tr>`).join('') +
      '</tbody></table>';

    const pick = $('stressPick');
    if (!pick.options.length || pick.options.length !== Object.keys(D).length) {
      pick.innerHTML = Object.keys(D).map(k => `<option value="${k}">${esc(D[k].label)}</option>`).join('');
      $('stressYear').value = D[pick.value].window[0];
    }

    const ro = E.regimeOutcomes(wor, h.retireAge);
    $('regimeOutcomes').innerHTML = `<p class="muted" style="margin:0 0 8px">Grouped by which regime dominated the first ten years of retirement. The order of returns matters more than their average.</p>
      <table><thead><tr><th>First decade of retirement</th><th class="num">Share of futures</th><th class="num">Money lasts</th></tr></thead><tbody>` +
      ro.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${pct(r.share)}</td><td class="num">${pct(r.successRate)}</td></tr>`).join('') + '</tbody></table>';

    const lr = E.longRunAverages(state.world);
    const names = { inflation: 'Inflation', equities: 'Stocks', bonds: 'Bonds', realAssets: 'Real assets', cash: 'Cash' };
    $('fairness').innerHTML = `<p class="muted" style="margin:0 0 8px">If these columns drift far apart, the comparison stops being about the shape of the future and becomes about optimism vs pessimism.</p>
      <table><thead><tr><th>Average per year</th><th class="num">Classic plan</th><th class="num">Your world, long run</th></tr></thead><tbody>` +
      lr.vars.map((v, i) => `<tr><td>${names[v]}</td><td class="num">${pct(lr.linear[i], 1)}</td><td class="num">${pct(lr.nonlinear[i], 1)}</td></tr>`).join('') + '</tbody></table>';

    const S = state.world.regimes.states, Tr = state.world.regimes.transitions;
    $('regimeDetails').innerHTML = `<table><thead><tr><th>Regime</th><th class="num">Inflation</th><th class="num">Stocks</th><th class="num">Bonds</th><th class="num">Real assets</th><th class="num">Stock/bond correlation</th><th class="num">Chance it continues next year</th><th class="num">Long-run share</th></tr></thead><tbody>` +
      Object.keys(S).map((k, i) => `<tr><td>${esc(S[k].label)}</td><td class="num">${pct(S[k].inflation.mean, 1)}</td><td class="num">${pct(S[k].equities.mean, 1)}</td>
        <td class="num">${pct(S[k].bonds.mean, 1)}</td><td class="num">${pct(S[k].realAssets.mean, 1)}</td>
        <td class="num">${((S[k].correlations || {})['equities|bonds'] || 0).toFixed(1)}</td><td class="num">${pct(Tr[k][k])}</td><td class="num">${pct(lr.regimeShare[i])}</td></tr>`).join('') +
      '</tbody></table><p class="muted">Edit these in <code>js/defaults.js</code> (or ask Claude Code to).</p>';
  }
  $('stressPick').addEventListener('change', () => { $('stressYear').value = state.world.disruptions[$('stressPick').value].window[0]; });
  $('stressRun').addEventListener('click', () => {
    const h = state.household, k = $('stressPick').value, year = parseInt($('stressYear').value, 10);
    const base = E.summary(getCtx('world').run(h));
    const stressedRes = getCtx('world', { forced: { [k]: year } }).run(h);
    const s = E.summary(stressedRes);
    const d = s.successRate - base.successRate;
    $('stressOut').innerHTML = `<div class="tiles">
      <div class="card tile"><div class="label">Your world</div><div class="value">${pct(base.successRate)}</div></div>
      <div class="card tile"><div class="label">If ${esc(state.world.disruptions[k].label.toLowerCase())} happens in ${year}</div>
        <div class="value">${pct(s.successRate)}</div><div class="sub ${d < 0 ? 'delta-neg' : 'delta-pos'}">${pts(d)}</div></div></div><div id="stressChart"></div>`;
    C.fanChart($('stressChart'), [
      Object.assign({ rows: E.bands(getCtx('world').run(h)) }, SERIES[1], { name: 'Your world' }),
      { name: 'Stress test', color: 'var(--series-1)', rows: E.bands(stressedRes) },
    ], chartOpts({ height: 280, label: 'Portfolio by age, your world vs stress test' }));
  });

  // ---- Moves
  function renderMoves() {
    const h = state.household;
    const ctxs = [getCtx('linear', { paths: 2000 }), getCtx('world', { paths: 2000 })];
    const { base, rows } = E.measureMoves(h, ctxs);
    const scale = Math.max(0.01, ...rows.flatMap(r => r.deltas.map(Math.abs)));
    $('movesTable').innerHTML = `<table><thead><tr><th>#</th><th>Move</th><th class="num">Classic plan</th><th class="num">Your world</th><th class="bar-cell"></th></tr></thead><tbody>
      <tr class="baseline"><td></td><td>Plan as entered</td><td class="num">${pct(base[0])}</td><td class="num">${pct(base[1])}</td><td></td></tr>` +
      rows.map((r, i) => `<tr class="${i < 5 ? 'top5' : ''}"><td>${i + 1}</td><td>${esc(r.label)}</td>
        <td class="num">${pts(r.deltas[0])}</td><td class="num">${pts(r.deltas[1])}</td><td class="bar-cell">${C.deltaBar(r.deltas[1], scale)}</td></tr>`).join('') +
      '</tbody></table><p class="muted">Measured on 2,000 futures per run for speed. Top five in bold.</p>';
  }

  // ---- Inputs
  const FORM = [
    ['Timeline', [['currentAge', 'Current age', 'int'], ['retireAge', 'Retirement age', 'int'], ['planToAge', 'Plan to age', 'int'],
      ['startYear', 'Start year', 'int'], ['adults', 'Adults in household', 'int', 'For universal basic income']]],
    ['Accounts', [['accounts.cash', 'Cash & savings', 'money', 'Spent first'], ['accounts.taxable', 'Brokerage', 'money'],
      ['accounts.taxableBasis', 'Brokerage cost basis', 'money', 'What you paid; the rest is taxable gain'],
      ['accounts.pretax', 'Pre-tax (401k, 403b, IRA)', 'money'], ['accounts.roth', 'Roth', 'money']]],
    ['Income and saving', [['earnedIncome', 'Pay (pre-tax, household)', 'money'], ['pretaxContribution', '401(k)/IRA contributions per year', 'money'],
      ['rothContribution', 'Roth contributions per year', 'money'], ['preRetirementSpending', 'Spending while working', 'money', 'Anything left over is saved in the brokerage account'],
      ['otherIncome', 'Pension, rental, other income', 'money'], ['partTime.income', 'Part-time pay after retiring', 'money'], ['partTime.years', 'Years of part-time work', 'int']]],
    ['Retirement spending', [['essentialSpending', 'Essential', 'money', 'Housing, food, insurance: hard to cut'],
      ['discretionarySpending', 'Discretionary', 'money', 'Travel, gifts, projects: can flex'],
      ['lifeStages.age1', 'First step-down at age', 'int'], ['lifeStages.mult1', 'Spending after first step (% of before)', 'mult'],
      ['lifeStages.age2', 'Second step-down at age', 'int'], ['lifeStages.mult2', 'Spending after second step (% of before)', 'mult']]],
    ['Health care', [['healthcare.whileWorking', 'While working', 'money'], ['healthcare.preMedicare', 'Retired, before 65', 'money'],
      ['healthcare.medicare', '65 and older', 'money'], ['healthcare.realGrowth', 'Rises faster than inflation by', 'pct']]],
    ['Social Security', [['socialSecurity.benefit', 'Household benefit per year', 'money', 'From your ssa.gov statement, at the claim age below'],
      ['socialSecurity.claimAge', 'Claim age', 'int']]],
    ['Taxes', [['taxes.ordinary', 'Blended income tax rate', 'pct', 'On pay, pre-tax withdrawals and taxable Social Security'],
      ['taxes.capitalGains', 'Capital gains rate', 'pct'], ['taxes.earlyPenalty', 'Penalty before 59½', 'pct'],
      ['rmdAge', 'Required withdrawals start at', 'int', '73 if born 1951-59, 75 if born 1960 or later']]],
    ['Investments', [['allocation.equities', 'Stocks', 'pct'], ['allocation.bonds', 'Bonds', 'pct'],
      ['allocation.realAssets', 'Real assets (TIPS, gold, commodities)', 'pct'], ['allocation.cash', 'Cash', 'pct'],
      ['strategy', 'Spending rule', 'select:guardrails=Guardrails (flex discretionary),fixed=Fixed (classic 4% rule)']]],
    ['Inheritance (a range, not a promise)', [['inheritance.include', 'Include in the plan', 'check'],
      ['inheritance.low', 'Low', 'money'], ['inheritance.likely', 'Likely', 'money'], ['inheritance.high', 'High', 'money'],
      ['inheritance.ageFrom', 'Earliest age', 'int'], ['inheritance.ageTo', 'Latest age', 'int'],
      ['inheritance.kind', 'Form', 'select:taxable=Brokerage or house (mostly untaxed),pretax=Inherited IRA (taxed as withdrawn)']]],
  ];
  function renderInputs() {
    $('inputWarn').innerHTML = (hidden() ? '<div class="warn">Hide $ is on, so dollar inputs are hidden. Turn it off to edit them.</div>' : '') + allocationWarning();
    $('inputForm').innerHTML = FORM.map(([title, fields]) => `<fieldset><legend>${title}</legend>` + fields.map(([p, label, kind, help]) => {
      const path = 'household.' + p;
      let ctl;
      if (kind.startsWith('select:')) ctl = select(path, kind.slice(7).split(',').map(o => o.split('=')));
      else ctl = input(path, kind);
      const unit = kind === 'pct' || kind === 'mult' ? ' (%)' : '';
      return `<div class="field"><label>${label}${unit}</label>${ctl}${help ? `<div class="help">${help}</div>` : ''}</div>`;
    }).join('') + '</fieldset>').join('');
  }
  $('exportBtn').addEventListener('click', () => {
    const data = { household: state.household, switches: state.switches, world: state.world };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'planner-inputs.local.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then(txt => {
      const data = JSON.parse(txt);
      const s = fresh();
      deepMerge(s, { household: data.household || {}, switches: data.switches || {}, world: data.world || {} });
      s.ui = state.ui;
      state = s; save(); render();
    }).catch(err => alert('Could not read that file: ' + err.message));
    e.target.value = '';
  });
  $('resetBtn').addEventListener('click', () => {
    if (!confirm('Replace everything with the placeholder numbers? Export first if you want a backup.')) return;
    const ui = state.ui;
    state = fresh(); state.ui = ui; save(); render();
  });

  $('hideMoney').addEventListener('change', e => {
    hide.on = e.target.checked;
    try { localStorage.setItem(HIDE, JSON.stringify(hide)); } catch (err) { /* ignore */ }
    render();
  });

  render();
})();
