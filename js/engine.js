/*
 * Planning engine. Plain math, no AI, no network. Runs in the browser and in Node (for tests).
 *
 * A run has three independent stages, each with its own random stream:
 *   1. drawTimelines  - which disruptions happen, and when, in each simulated future
 *   2. drawMarkets    - returns and inflation per year, by economic regime
 *   3. simulate       - the household's cash flows, taxes and accounts
 *
 * Policy switches and household changes only touch stage 3, so scenarios compared
 * against each other run through identical markets: any difference is the policy, not luck.
 */
(function (root) {
  'use strict';

  const ASSETS = ['equities', 'bonds', 'realAssets', 'cash'];
  const VARS = ['inflation'].concat(ASSETS);
  const DEFAULT_CORR = {
    'inflation|equities': -0.1, 'inflation|bonds': -0.3, 'inflation|realAssets': 0.4,
    'inflation|cash': 0.5, 'equities|bonds': 0.0, 'equities|realAssets': 0.3, 'bonds|realAssets': 0.1,
  };
  // IRS Uniform Lifetime Table (2022+), age -> divisor
  const RMD_DIVISOR = {
    72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2,
    81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9,
    90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8,
    100: 6.4, 101: 6.0, 102: 5.6, 103: 5.2, 104: 4.9, 105: 4.6, 106: 4.3, 107: 4.1, 108: 3.9,
    109: 3.7, 110: 3.5,
  };

  // ------------------------------------------------------------------ randomness
  function rngFrom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function normalFrom(rng) {
    let spare = null;
    return function () {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0;
      while (u === 0) u = rng();
      const v = rng(), r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    };
  }

  // ------------------------------------------------------------------ market model
  function corrMatrix(overrides) {
    const c = Object.assign({}, DEFAULT_CORR, overrides || {});
    const n = VARS.length;
    const m = [];
    for (let i = 0; i < n; i++) { m.push(new Array(n).fill(0)); m[i][i] = 1; }
    for (const key in c) {
      const [a, b] = key.split('|');
      const i = VARS.indexOf(a), j = VARS.indexOf(b);
      if (i >= 0 && j >= 0) m[i][j] = m[j][i] = c[key];
    }
    return m;
  }
  function cholesky(m) {
    // Hand-entered correlations can be inconsistent; shrink toward identity until usable.
    for (let shrink = 0; shrink <= 1; shrink += 0.05) {
      const n = m.length, L = [];
      let ok = true;
      for (let i = 0; i < n; i++) L.push(new Array(n).fill(0));
      for (let i = 0; i < n && ok; i++) {
        for (let j = 0; j <= i; j++) {
          const mij = (i === j) ? 1 : m[i][j] * (1 - shrink);
          let s = mij;
          for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
          if (i === j) {
            if (s <= 1e-10) { ok = false; break; }
            L[i][j] = Math.sqrt(s);
          } else {
            L[i][j] = s / L[j][j];
          }
        }
      }
      if (ok) return L;
    }
    throw new Error('Correlation matrix unusable');
  }

  function marketModel(world, linear) {
    let states, names, trans, start;
    if (linear) {
      names = ['linear'];
      states = { linear: world.linearBaseline };
      trans = [[1]];
      start = 0;
    } else {
      states = world.regimes.states;
      names = Object.keys(states);
      trans = names.map(a => names.map(b => world.regimes.transitions[a][b] || 0));
      start = Math.max(0, names.indexOf(world.regimes.start));
    }
    return {
      names, trans, start,
      labels: names.map(s => states[s].label || s),
      mu: names.map(s => VARS.map(v => states[s][v].mean)),
      vol: names.map(s => VARS.map(v => states[s][v].vol)),
      chol: names.map(s => cholesky(corrMatrix(states[s].correlations))),
    };
  }

  /** Long-run average of each variable implied by the regime model (for the fairness check). */
  function longRunAverages(world) {
    const m = marketModel(world, false);
    const R = m.names.length;
    let pi = new Array(R).fill(1 / R);
    for (let k = 0; k < 2000; k++) {
      const next = new Array(R).fill(0);
      for (let a = 0; a < R; a++) for (let b = 0; b < R; b++) next[b] += pi[a] * m.trans[a][b];
      pi = next;
    }
    const nonlinear = VARS.map((_, v) => pi.reduce((s, p, r) => s + p * m.mu[r][v], 0));
    const linear = VARS.map(v => world.linearBaseline[v].mean);
    return { vars: VARS, linear, nonlinear, regimeShare: pi, regimeLabels: m.labels };
  }

  // ------------------------------------------------------------------ stage 1: disruptions
  function annualHazard(probability, window) {
    const years = window[1] - window[0] + 1;
    if (probability >= 1) return 1;
    return 1 - Math.pow(1 - probability, 1 / years);
  }

  /**
   * Returns {key: Int16Array(N)} holding the calendar year each disruption happens in
   * each future (0 = never). A random number is drawn for every path, disruption and
   * in-window year no matter what, so switching one disruption off or forcing one does
   * not reshuffle the others.
   */
  function drawTimelines(disruptions, N, startYear, T, seed, forced, disabled) {
    forced = forced || {};
    disabled = disabled || {};
    const rng = rngFrom((seed ^ 0x5bd1e995) >>> 0);
    const keys = Object.keys(disruptions);
    const occ = {};
    keys.forEach(k => { occ[k] = new Int16Array(N); });
    for (let t = 0; t < T; t++) {
      const year = startYear + t;
      for (const k of keys) {
        const d = disruptions[k];
        const inWindow = year >= d.window[0] && year <= d.window[1];
        const off = disabled[k] || d.on === false;
        const h = annualHazard(d.probability, d.window);
        const boost = Object.entries(d.boostedBy || {}).filter(([o]) => occ[o]);
        const o = occ[k];
        for (let i = 0; i < N; i++) {
          const u = inWindow ? rng() : 1;
          if (o[i]) continue;
          if (k in forced) { if (year === forced[k]) o[i] = year; continue; }
          if (off || !inWindow) continue;
          let hz = h;
          for (const [other, mult] of boost) if (occ[other][i]) hz *= mult;
          if (u < hz) o[i] = year;
        }
      }
    }
    return occ;
  }

  // ------------------------------------------------------------------ stage 2: markets
  const MARKET_EFFECTS = ['inflationDelta', 'equityDelta', 'regimeTilt', 'forceRegime'];

  function drawMarkets(model, N, T, seed, startYear, timelines, disruptions) {
    const rng = rngFrom(seed >>> 0);
    const nrm = normalFrom(rng);
    const R = model.names.length, nv = VARS.length;
    const regime = new Uint8Array(N * T);
    const infl = new Float64Array(N * T);
    const ret = new Float64Array(N * T * 4);
    const mkKeys = timelines ? Object.keys(disruptions).filter(k =>
      timelines[k] && MARKET_EFFECTS.some(e => (disruptions[k].effects || {})[e] !== undefined)) : [];
    const z = new Float64Array(nv), tilt = new Float64Array(R);

    for (let i = 0; i < N; i++) {
      let r = model.start, forcedLeft = 0, forcedIdx = 0, inflD = 0, eqD = 0;
      tilt.fill(1);
      for (let t = 0; t < T; t++) {
        const year = startYear + t;
        for (const k of mkKeys) {
          if (timelines[k][i] !== year) continue;
          const fx = disruptions[k].effects;
          inflD += fx.inflationDelta || 0;
          eqD += fx.equityDelta || 0;
          for (const reg in (fx.regimeTilt || {})) {
            const idx = model.names.indexOf(reg);
            if (idx >= 0) tilt[idx] *= fx.regimeTilt[reg];
          }
          if (fx.forceRegime && model.names.indexOf(fx.forceRegime.regime) >= 0) {
            forcedIdx = model.names.indexOf(fx.forceRegime.regime);
            forcedLeft = fx.forceRegime.years;
          }
        }
        // regime for this year
        const u = rng();
        if (R > 1) {
          const row = model.trans[r];
          let total = 0;
          for (let j = 0; j < R; j++) total += row[j] * tilt[j];
          let acc = 0, pick = R - 1;
          for (let j = 0; j < R; j++) { acc += row[j] * tilt[j] / total; if (u < acc) { pick = j; break; } }
          r = pick;
        }
        if (forcedLeft > 0) { r = forcedIdx; forcedLeft--; }
        regime[i * T + t] = r;
        // correlated draws
        for (let v = 0; v < nv; v++) z[v] = nrm();
        const L = model.chol[r], mu = model.mu[r], vol = model.vol[r];
        for (let v = 0; v < nv; v++) {
          let c = 0;
          for (let k = 0; k <= v; k++) c += L[v][k] * z[k];
          const x = mu[v] + vol[v] * c;
          if (v === 0) infl[i * T + t] = x + inflD;
          else ret[(i * T + t) * 4 + v - 1] = Math.max(-0.95, x + (v === 1 ? eqD : 0));
        }
      }
    }
    return { N, T, startYear, regime, infl, ret, regimeLabels: model.labels, regimeNames: model.names };
  }

  // ------------------------------------------------------------------ stage 3: household
  function blankEffects() {
    return {
      ssMultiplier: 1, healthcareMultiplier: 1, earnedIncomeMultiplier: 1, spendingMultiplier: 1,
      incomeTax: 0, ubiPerAdult: 0, vat: 0, capitalGainsDelta: 0, ordinaryTaxDelta: 0,
      planExtension: 0, meansThreshold: 0, meansReduction: 0, wealthRate: 0, wealthThreshold: 0,
    };
  }
  function mergeEffects(s, fx) {
    if (fx.ssMultiplier !== undefined) s.ssMultiplier *= fx.ssMultiplier;
    if (fx.healthcareMultiplier !== undefined) s.healthcareMultiplier *= fx.healthcareMultiplier;
    if (fx.earnedIncomeMultiplier !== undefined) s.earnedIncomeMultiplier *= fx.earnedIncomeMultiplier;
    if (fx.spendingMultiplier !== undefined) s.spendingMultiplier *= fx.spendingMultiplier;
    s.incomeTax += fx.incomeTax || 0;
    s.ubiPerAdult += fx.ubiPerAdult || 0;
    s.vat += fx.vat || 0;
    s.capitalGainsDelta += fx.capitalGainsDelta || 0;
    s.ordinaryTaxDelta += fx.ordinaryTaxDelta || 0;
    s.planExtension = Math.max(s.planExtension, fx.planExtension || 0);
    if (fx.ssMeansTest) { s.meansThreshold = fx.ssMeansTest.threshold; s.meansReduction = fx.ssMeansTest.reduction; }
    if (fx.wealthTax) { s.wealthRate = fx.wealthTax.rate; s.wealthThreshold = fx.wealthTax.threshold; }
  }

  /** Turn a policy switch into the shared effects vocabulary. */
  function switchEffects(key, sw) {
    switch (key) {
      case 'ssCut': return { ssMultiplier: 1 - sw.cut };
      case 'universalHealthcare': return { healthcareMultiplier: 0, incomeTax: sw.tax };
      case 'ubi': return { ubiPerAdult: sw.perAdult, vat: sw.vat };
      case 'wealthTax': return { wealthTax: { rate: sw.rate, threshold: sw.threshold } };
      case 'capitalGains': return { capitalGainsDelta: sw.delta };
      case 'meansTest': return { ssMeansTest: { threshold: sw.threshold, reduction: sw.reduction } };
      default: return {};
    }
  }

  function triangular(u, lo, mode, hi) {
    if (hi <= lo) return lo;
    const f = (mode - lo) / (hi - lo);
    return u < f ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
  }

  /**
   * Simulate the household through the given markets.
   * opts.policies: [{year, effects}] applied to every future (policy switches)
   * opts.timelines + opts.disruptions: per-future events (your worldview)
   */
  function simulate(h, markets, opts) {
    opts = opts || {};
    const { N, T, startYear } = markets;
    const policies = opts.policies || [];
    const timelines = opts.timelines || {};
    const disruptions = opts.disruptions || {};
    const dKeys = Object.keys(timelines);
    const dTl = dKeys.map(k => timelines[k]);
    const dFx = dKeys.map(k => (disruptions[k] && disruptions[k].effects) || {});
    const hcGrowth = new Float64Array(T);
    for (let t = 0; t < T; t++) hcGrowth[t] = Math.pow(1 + h.healthcare.realGrowth, t);
    const w = h.allocation;
    const tx = h.taxes, hc = h.healthcare, gr = h.guardrails, ls = h.lifeStages;
    const acc0 = h.accounts;

    const port = new Float32Array(N * T).fill(NaN);
    const spend = new Float32Array(N * T).fill(NaN);
    const success = new Uint8Array(N);
    const depletionAge = new Float32Array(N).fill(NaN);
    const endAge = new Float32Array(N);
    const minDisc = new Float32Array(N);
    const firstWR = new Float32Array(N).fill(NaN);

    const inh = h.inheritance || {};
    const useInh = inh.include && inh.high > 0;
    const inhRng = rngFrom(((opts.seed || 1) ^ 0x2545F491) >>> 0);

    for (let i = 0; i < N; i++) {
      let cash = acc0.cash, taxable = acc0.taxable, basis = Math.min(acc0.taxableBasis, acc0.taxable);
      let pre = acc0.pretax, roth = acc0.roth, P = 1;
      let discAdj = 1, lowest = 1, initWR = NaN, depleted = false, end = h.planToAge;
      const fx = blankEffects();
      let inhYear = -1, inhAmt = 0;
      const u1 = inhRng(), u2 = inhRng();
      if (useInh) {
        inhAmt = triangular(u1, inh.low, Math.min(Math.max(inh.likely, inh.low), inh.high), inh.high);
        inhYear = startYear + (inh.ageFrom - h.currentAge) + Math.floor(u2 * (inh.ageTo - inh.ageFrom + 1));
      }

      for (let t = 0; t < T; t++) {
        const year = startYear + t, age = h.currentAge + t;
        for (const p of policies) if (p.year === year) mergeEffects(fx, p.effects);
        for (let d = 0; d < dTl.length; d++) if (dTl[d][i] === year) mergeEffects(fx, dFx[d]);
        end = h.planToAge + fx.planExtension;
        if (age >= end) break;

        const m = (i * T + t) * 4;
        const rEq = markets.ret[m], rBd = markets.ret[m + 1], rRe = markets.ret[m + 2], rCa = markets.ret[m + 3];
        const inflation = markets.infl[i * T + t];

        if (year === inhYear) {
          if (inh.kind === 'pretax') pre += inhAmt * P;
          else { taxable += inhAmt * P; basis += inhAmt * P; }
        }
        const total = cash + taxable + pre + roth;
        const realTotal = total / P;
        const working = age < h.retireAge;

        // ---- income
        const earned = working ? h.earnedIncome * fx.earnedIncomeMultiplier * P : 0;
        const partTime = (!working && age < h.retireAge + (h.partTime.years || 0))
          ? h.partTime.income * fx.earnedIncomeMultiplier * P : 0;
        let ss = 0;
        if (age >= h.socialSecurity.claimAge) {
          ss = h.socialSecurity.benefit * fx.ssMultiplier;
          if (fx.meansThreshold && realTotal >= fx.meansThreshold) ss *= 1 - fx.meansReduction;
          ss *= P;
        }
        const ubi = working ? 0 : fx.ubiPerAdult * h.adults * P;
        const other = (h.otherIncome || 0) * P;

        // ---- spending
        let stage = 1;
        if (age >= ls.age1) stage *= ls.mult1;
        if (age >= ls.age2) stage *= ls.mult2;
        const living = (working ? h.preRetirementSpending
          : (h.essentialSpending + h.discretionarySpending * discAdj) * stage) * fx.spendingMultiplier * P;
        const vat = working ? 0 : living * fx.vat;
        const hcBase = working ? hc.whileWorking : (age < 65 ? hc.preMedicare : hc.medicare);
        const health = hcBase * fx.healthcareMultiplier * hcGrowth[t] * P;
        const wealthTax = fx.wealthRate > 0 ? fx.wealthRate * Math.max(0, realTotal - fx.wealthThreshold) * P : 0;

        // ---- taxes on income that isn't a withdrawal
        const ord = tx.ordinary + fx.ordinaryTaxDelta;
        const cg = tx.capitalGains + fx.capitalGainsDelta;
        const inc = fx.incomeTax;
        const preC = working ? Math.min(h.pretaxContribution, h.earnedIncome) * fx.earnedIncomeMultiplier * P : 0;
        const rothC = working ? h.rothContribution * P : 0;
        const incomeTaxes = (earned + partTime - preC) * ord + (earned + partTime) * inc
          + ss * tx.ssTaxablePortion * ord + other * ord;

        // ---- required minimum distribution
        let rmd = 0;
        if (age >= h.rmdAge && pre > 0) {
          rmd = pre / (RMD_DIVISOR[Math.min(Math.max(age, 72), 110)] || 3.5);
          pre -= rmd;
        }
        pre += preC;
        roth += rothC;
        const netIncome = earned + partTime - preC + ss + ubi + other - incomeTaxes;
        const outflow = living + vat + health + wealthTax + rothC;
        // What the portfolio must cover (before any required distribution), for the spending rule.
        const draw = Math.max(0, outflow - netIncome);
        let need = outflow - netIncome - rmd * (1 - ord - inc);

        if (need <= 0) {
          taxable -= need;  // surplus is saved in the brokerage account
          basis -= need;
        } else {
          // Withdrawal order: cash, brokerage, then pre-tax and Roth
          // (Roth before pre-tax until 59½ to avoid the penalty).
          let take = Math.min(cash, need);
          cash -= take; need -= take;
          if (need > 0 && taxable > 0) {
            const gainFrac = Math.max(0, 1 - basis / taxable);
            const net = 1 - cg * gainFrac - inc;
            take = Math.min(taxable, need / net);
            basis -= basis * take / taxable;
            taxable -= take; need -= take * net;
          }
          const early = age < 59.5;
          const preNet = 1 - ord - inc - (early ? tx.earlyPenalty : 0), rothNet = 1 - inc;
          if (early && need > 0 && roth > 0) { take = Math.min(roth, need / rothNet); roth -= take; need -= take * rothNet; }
          if (need > 0 && pre > 0) { take = Math.min(pre, need / preNet); pre -= take; need -= take * preNet; }
          if (need > 0 && roth > 0) { take = Math.min(roth, need / rothNet); roth -= take; need -= take * rothNet; }
        }
        const shortfall = Math.max(0, need);
        if (shortfall > 1 * P && !depleted) { depleted = true; depletionAge[i] = age; }

        // ---- spending rule: compare this year's draw rate with the one retirement started at
        if (!working) {
          const wr = total > 0 ? draw / total : Infinity;
          if (isNaN(initWR)) { initWR = Math.max(wr, 1e-4); firstWR[i] = wr; }
          else if (h.strategy === 'guardrails' && isFinite(wr)) {
            if (wr > initWR * (1 + gr.band)) discAdj = Math.max(discAdj * (1 - gr.cut), gr.minDiscretionary);
            else if (wr < initWR * (1 - gr.band)) discAdj = Math.min(discAdj * (1 + gr.raise), gr.maxDiscretionary);
          }
          lowest = Math.min(lowest, discAdj);
        }

        // Lifestyle spending actually achieved (health care excluded so policy changes to premiums don't read as belt-tightening)
        const realSpend = Math.max(0, living - shortfall) / P;

        // ---- markets move, prices rise
        const rp = w.equities * rEq + w.bonds * rBd + w.realAssets * rRe + w.cash * rCa;
        taxable *= 1 + rp; pre *= 1 + rp; roth *= 1 + rp; cash *= 1 + rCa;
        P *= 1 + inflation;
        port[i * T + t] = (cash + taxable + pre + roth) / P;
        spend[i * T + t] = realSpend;
      }
      success[i] = depleted ? 0 : 1;
      endAge[i] = end;
      minDisc[i] = lowest;
    }
    return {
      N, T, startYear, currentAge: h.currentAge, planToAge: h.planToAge, retireAge: h.retireAge,
      port, spend, success, depletionAge, endAge, minDisc, firstWR,
      regime: markets.regime, regimeLabels: markets.regimeLabels, timelines,
    };
  }

  // ------------------------------------------------------------------ summaries
  function percentile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function median(arr) {
    const a = Array.from(arr).filter(x => !isNaN(x)).sort((x, y) => x - y);
    return percentile(a, 0.5);
  }

  function bands(res, qs) {
    qs = qs || [0.1, 0.25, 0.5, 0.75, 0.9];
    const out = [];
    const col = new Float64Array(res.N);
    for (let t = 0; t < res.T; t++) {
      let n = 0;
      for (let i = 0; i < res.N; i++) { const v = res.port[i * res.T + t]; if (!isNaN(v)) col[n++] = v; }
      if (n < res.N * 0.02) break;  // stop once almost every future has ended
      const s = Array.from(col.subarray(0, n)).sort((a, b) => a - b);
      const row = { age: res.currentAge + t + 1 };
      qs.forEach(q => { row['p' + Math.round(q * 100)] = percentile(s, q); });
      out.push(row);
    }
    return out;
  }

  function summary(res) {
    const ends = [];
    for (let i = 0; i < res.N; i++) {
      let last = NaN;
      for (let t = res.T - 1; t >= 0; t--) { const v = res.port[i * res.T + t]; if (!isNaN(v)) { last = v; break; } }
      ends.push(last);
    }
    const sortedEnds = ends.filter(x => !isNaN(x)).sort((a, b) => a - b);
    let succ = 0, cutCount = 0;
    const cuts = [];
    for (let i = 0; i < res.N; i++) {
      succ += res.success[i];
      if (res.minDisc[i] < 0.999) { cutCount++; cuts.push(1 - res.minDisc[i]); }
    }
    // Lowest real spending in any retirement year, per future
    const from = Math.max(0, res.retireAge - res.currentAge);
    const mins = [];
    for (let i = 0; i < res.N; i++) {
      let lo = Infinity;
      for (let t = from; t < res.T; t++) { const v = res.spend[i * res.T + t]; if (!isNaN(v) && v < lo) lo = v; }
      if (isFinite(lo)) mins.push(lo);
    }
    return {
      successRate: succ / res.N,
      medianMinSpending: mins.length ? median(mins) : NaN,
      medianEnd: percentile(sortedEnds, 0.5),
      p10End: percentile(sortedEnds, 0.1),
      medianDepletionAge: median(res.depletionAge),
      firstWithdrawalRate: median(res.firstWR),
      cutShare: cutCount / res.N,
      medianDeepestCut: cuts.length ? median(cuts) : 0,
    };
  }

  function attribution(res, disruptions) {
    const rows = [];
    for (const k in res.timelines) {
      const tl = res.timelines[k];
      let hit = 0, hitOk = 0, miss = 0, missOk = 0;
      const years = [];
      for (let i = 0; i < res.N; i++) {
        if (tl[i]) { hit++; hitOk += res.success[i]; years.push(tl[i]); } else { miss++; missOk += res.success[i]; }
      }
      rows.push({
        key: k, label: disruptions[k].label,
        happened: hit / res.N,
        successIf: hit ? hitOk / hit : NaN,
        successIfNot: miss ? missOk / miss : NaN,
        medianYear: years.length ? median(years) : NaN,
      });
    }
    rows.forEach(r => { r.impact = r.successIf - r.successIfNot; });
    return rows.sort((a, b) => (a.impact || 0) - (b.impact || 0));
  }

  /** Success rate grouped by which regime dominated the first decade of retirement. */
  function regimeOutcomes(res, retireAge) {
    const R = res.regimeLabels.length;
    const from = Math.max(0, retireAge - res.currentAge), to = Math.min(res.T, from + 10);
    const counts = new Array(R).fill(0), ok = new Array(R).fill(0);
    const tally = new Array(R);
    for (let i = 0; i < res.N; i++) {
      tally.fill(0);
      for (let t = from; t < to; t++) tally[res.regime[i * res.T + t]]++;
      let best = 0;
      for (let r = 1; r < R; r++) if (tally[r] > tally[best]) best = r;
      counts[best]++; ok[best] += res.success[i];
    }
    return res.regimeLabels.map((label, r) => ({
      label, share: counts[r] / res.N, successRate: counts[r] ? ok[r] / counts[r] : NaN,
    }));
  }

  // ------------------------------------------------------------------ moves
  // Each lever changes one thing about the household. The code measures every one
  // through the same markets; the ranking is by measured change, nothing else.
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function shiftAlloc(h, from, to, amt) {
    const a = h.allocation, x = Math.min(a[from], amt);
    a[from] -= x; a[to] += x;
    return x > 0;
  }
  const MOVES = [
    { key: 'spend10', label: 'Spend 10% less in retirement',
      apply: h => { h.essentialSpending *= 0.9; h.discretionarySpending *= 0.9; } },
    { key: 'retire1', label: 'Retire 1 year later', apply: h => { h.retireAge += 1; } },
    { key: 'retire3', label: 'Retire 3 years later', apply: h => { h.retireAge += 3; } },
    { key: 'ss70', label: 'Claim Social Security at 70',
      apply: h => {
        if (h.socialSecurity.claimAge >= 70) return false;
        // Each year of delay past full retirement age (67) adds 8%; earlier claims are reduced ~6.7%/yr.
        const fra = 67, c = h.socialSecurity.claimAge;
        const factor = c >= fra ? 1 + 0.08 * (c - fra) : 1 - 0.0667 * (fra - c);
        h.socialSecurity.benefit = h.socialSecurity.benefit / factor * 1.24;
        h.socialSecurity.claimAge = 70;
      } },
    { key: 'save10', label: 'Save $10,000 more per year until retirement',
      apply: h => { if (h.retireAge <= h.currentAge) return false; h.preRetirementSpending -= 10000; } },
    { key: 'partTime', label: 'Earn $30,000 a year part-time for 5 years after retiring',
      apply: h => { h.partTime = { income: 30000, years: 5 }; } },
    { key: 'guardrails', label: 'Use spending guardrails',
      apply: h => { if (h.strategy === 'guardrails') return false; h.strategy = 'guardrails'; } },
    { key: 'moreStocks', label: 'Move 10 points from bonds to stocks',
      apply: h => shiftAlloc(h, 'bonds', 'equities', 0.10) },
    { key: 'fewerStocks', label: 'Move 10 points from stocks to bonds',
      apply: h => shiftAlloc(h, 'equities', 'bonds', 0.10) },
    { key: 'realAssets', label: 'Move 10 points from bonds into real assets (TIPS, gold, commodities)',
      apply: h => shiftAlloc(h, 'bonds', 'realAssets', 0.10) },
    { key: 'cutDisc', label: 'Plan on 25% less discretionary spending',
      apply: h => { h.discretionarySpending *= 0.75; } },
    { key: 'healthcare', label: 'Keep employer health coverage to 65',
      apply: h => { if (h.retireAge >= 65) return false; h.healthcare.preMedicare = h.healthcare.whileWorking; } },
  ];

  /** Measure every move through the same markets. Returns rows sorted by improvement. */
  function measureMoves(h, contexts) {
    const base = contexts.map(c => summary(c.run(h)).successRate);
    const rows = [];
    for (const mv of MOVES) {
      const v = clone(h);
      if (mv.apply(v) === false) continue;
      const rates = contexts.map(c => summary(c.run(v)).successRate);
      rows.push({ key: mv.key, label: mv.label, rates, deltas: rates.map((r, j) => r - base[j]) });
    }
    return { base, rows: rows.sort((a, b) => b.deltas[b.deltas.length - 1] - a.deltas[a.deltas.length - 1]) };
  }

  // ------------------------------------------------------------------ orchestration
  function horizon(h, world, withDisruptions) {
    let ext = 0;
    if (withDisruptions) {
      for (const k in world.disruptions) ext = Math.max(ext, (world.disruptions[k].effects || {}).planExtension || 0);
    }
    return h.planToAge - h.currentAge + ext;
  }

  function activeSwitchPolicies(switches, keys) {
    return keys.map(k => ({ year: switches[k].year, effects: switchEffects(k, switches[k]) }));
  }

  /**
   * Build the shared market sets once, then run any number of household variants
   * through them. `kind`: 'linear' (classic), 'regimes' (regimes, no disruptions),
   * or 'world' (regimes + your disruptions).
   */
  function makeContext(h, world, kind, extra) {
    extra = extra || {};
    const N = extra.paths || world.paths;
    const seed = world.seed;
    const withD = kind === 'world';
    const T = horizon(h, world, withD);
    const model = marketModel(world, kind === 'linear');
    const disruptions = withD ? world.disruptions : {};
    const timelines = withD
      ? drawTimelines(disruptions, N, h.startYear, T, seed, extra.forced, extra.disabled) : {};
    const markets = drawMarkets(model, N, T, seed, h.startYear, withD ? timelines : null, disruptions);
    return {
      kind, markets, timelines, disruptions, seed,
      run(household, policies) {
        return simulate(household, markets, { policies: policies || [], timelines, disruptions, seed });
      },
    };
  }

  const Engine = {
    ASSETS, VARS, rngFrom, annualHazard, marketModel, longRunAverages,
    drawTimelines, drawMarkets, simulate, switchEffects, activeSwitchPolicies,
    makeContext, bands, summary, attribution, regimeOutcomes, MOVES, measureMoves,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(this);
