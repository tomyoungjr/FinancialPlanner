// Run with: node --test
const test = require('node:test');
const assert = require('node:assert');
const E = require('../js/engine.js');
const DEFAULTS = require('../js/defaults.js');

const clone = o => JSON.parse(JSON.stringify(o));
const H = () => clone(DEFAULTS.household);
const W = () => clone(DEFAULTS.world);
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('yearly hazard reproduces the odds stated for the window', () => {
  const h = E.annualHazard(0.5, [2030, 2034]);
  near(1 - Math.pow(1 - h, 5), 0.5, 1e-12);
});

test('disruptions happen about as often as the stated odds', () => {
  const w = W();
  for (const d of Object.values(w.disruptions)) delete d.boostedBy;
  const tl = E.drawTimelines(w.disruptions, 20000, 2026, 40, 1);
  const hit = tl.universalHealthcare.filter(y => y).length / 20000;
  near(hit, w.disruptions.universalHealthcare.probability, 0.015);
});

test('cascades: a disruption is more likely after the one that boosts it', () => {
  const w = W();
  const tl = E.drawTimelines(w.disruptions, 20000, 2026, 40, 2);
  let after = 0, afterN = 0, without = 0, withoutN = 0;
  for (let i = 0; i < 20000; i++) {
    if (tl.aiDisplacement[i]) { afterN++; if (tl.ubi[i]) after++; } else { withoutN++; if (tl.ubi[i]) without++; }
  }
  assert.ok(after / afterN > 1.5 * (without / withoutN));
});

test('a forced disruption happens in exactly that year in every future', () => {
  const w = W();
  const tl = E.drawTimelines(w.disruptions, 500, 2026, 40, 1, { ssCut: 2033 });
  assert.ok(tl.ssCut.every(y => y === 2033));
});

test('forcing one disruption does not reshuffle the others', () => {
  const w = W();
  const a = E.drawTimelines(w.disruptions, 2000, 2026, 40, 3);
  const b = E.drawTimelines(w.disruptions, 2000, 2026, 40, 3, { longevity: 2040 });
  assert.deepStrictEqual(Array.from(a.aiDisplacement), Array.from(b.aiDisplacement));
});

test('policy switches run through identical markets (difference is policy, not luck)', () => {
  const h = H(), w = W();
  const ctx = E.makeContext(h, w, 'regimes', { paths: 500 });
  const base = ctx.run(h);
  const cut = ctx.run(h, E.activeSwitchPolicies(DEFAULTS.switches, ['ssCut']));
  // Identical until the first year the cut applies.
  const t = 2034 - h.startYear;
  for (let i = 0; i < 500; i++) near(base.port[i * base.T + t - 1], cut.port[i * cut.T + t - 1], 1e-3);
  assert.ok(E.summary(cut).successRate <= E.summary(base).successRate);
});

test('a deep Social Security cut lowers success', () => {
  const h = H(), w = W();
  const ctx = E.makeContext(h, w, 'linear', { paths: 2000 });
  const base = E.summary(ctx.run(h)).successRate;
  const cut = E.summary(ctx.run(h, [{ year: 2027, effects: { ssMultiplier: 0 } }])).successRate;
  assert.ok(cut < base);
});

test('with no volatility every future is identical', () => {
  const h = H(), w = W();
  for (const v of Object.values(w.linearBaseline)) if (v && v.vol !== undefined) v.vol = 0;
  const res = E.makeContext(h, w, 'linear', { paths: 20 }).run(h);
  for (let i = 1; i < 20; i++) for (let t = 0; t < res.T; t++) near(res.port[i * res.T + t], res.port[t], 1e-2);
});

test('a longevity breakthrough extends the plan', () => {
  const h = H(), w = W();
  const ctx = E.makeContext(h, w, 'world', { paths: 200, forced: { longevity: 2031 } });
  const res = ctx.run(h);
  assert.ok(Array.from(res.endAge).every(a => a === h.planToAge + 8));
});

test('the early-withdrawal penalty makes retiring at 55 from pre-tax money cost more', () => {
  const w = W();
  for (const v of Object.values(w.linearBaseline)) if (v && v.vol !== undefined) v.vol = 0;
  const mk = penalty => {
    const h = H();
    h.currentAge = 55; h.retireAge = 55;
    h.accounts = { cash: 0, taxable: 0, taxableBasis: 0, pretax: 2000000, roth: 0 };
    h.taxes.earlyPenalty = penalty;
    return E.makeContext(h, w, 'linear', { paths: 5 }).run(h).port[4];  // after 5 years
  };
  assert.ok(mk(0.10) < mk(0));
});

test('required minimum distributions drain pre-tax accounts even with no spending need', () => {
  const w = W();
  for (const v of Object.values(w.linearBaseline)) if (v && v.vol !== undefined) v.vol = 0;
  const h = H();
  h.currentAge = 80; h.retireAge = 60; h.planToAge = 85;
  h.essentialSpending = 0; h.discretionarySpending = 0; h.healthcare.medicare = 0;
  h.socialSecurity.benefit = 0;
  h.accounts = { cash: 0, taxable: 0, taxableBasis: 0, pretax: 1000000, roth: 0 };
  // Pre-tax money is forced out (and taxed) into the brokerage account, so the total shrinks by the tax.
  const run = rmdAge => { const v = clone(h); v.rmdAge = rmdAge; return E.makeContext(v, w, 'linear', { paths: 1 }).run(v).port[0]; };
  const withRmd = run(75), withoutRmd = run(200);
  near(withoutRmd - withRmd, 1000000 / 20.2 * 0.20 * (1 + 0.6 * 0.09 + 0.4 * 0.045) / 1.025, 1);
});

test('inheritance is left out unless included', () => {
  const h = H(), w = W();
  h.inheritance = { include: false, low: 500000, likely: 1000000, high: 2000000, ageFrom: 70, ageTo: 80, kind: 'taxable' };
  const ctx = E.makeContext(h, w, 'linear', { paths: 1000 });
  const off = E.summary(ctx.run(h));
  h.inheritance.include = true;
  const on = E.summary(ctx.run(h));
  assert.ok(on.medianEnd > off.medianEnd);
});

test('both worlds have similar long-run averages (the comparison is fair)', () => {
  const lr = E.longRunAverages(W());
  lr.vars.forEach((v, i) => near(lr.nonlinear[i], lr.linear[i], 0.01));
});

test('moves are measured and sorted by improvement in the last context', () => {
  const h = H(), w = W();
  const ctx = E.makeContext(h, w, 'linear', { paths: 300 });
  const { rows } = E.measureMoves(h, [ctx]);
  assert.ok(rows.length >= 8);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].deltas[0] >= rows[i].deltas[0]);
});
