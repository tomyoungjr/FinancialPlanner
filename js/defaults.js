/*
 * Default inputs. Every household number here is a PLACEHOLDER.
 * Your real numbers are entered in the app and saved in your browser only;
 * they never go into this file or into GitHub.
 *
 * All dollar amounts are in today's dollars; the engine applies inflation.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    household: {
      startYear: 2026,
      currentAge: 60,
      retireAge: 65,
      planToAge: 95,
      adults: 2,

      // Where each dollar sits for tax purposes
      accounts: {
        cash: 100000,          // checking, savings, money market (spent first)
        taxable: 800000,       // brokerage
        taxableBasis: 500000,  // what you paid for the brokerage holdings
        pretax: 1400000,       // 401(k), 403(b), traditional IRA
        roth: 200000,          // Roth IRA / Roth 401(k)
      },

      earnedIncome: 150000,
      pretaxContribution: 30000,   // yearly 401(k)/IRA contributions while working
      rothContribution: 0,
      preRetirementSpending: 95000,

      // Retirement spending, split so the plan knows what can flex
      essentialSpending: 60000,
      discretionarySpending: 25000,
      // Spending by life stage: each step is a share of the stage before it (1 = flat)
      lifeStages: { age1: 70, mult1: 1.0, age2: 80, mult2: 1.0 },

      healthcare: {
        whileWorking: 6000,    // your share of employer coverage
        preMedicare: 24000,    // retired before 65: marketplace premiums + out of pocket
        medicare: 12000,       // 65+: Medicare premiums, supplement, out of pocket
        realGrowth: 0.015,     // how much faster than inflation health costs rise
      },

      socialSecurity: { benefit: 42000, claimAge: 67 },
      otherIncome: 0,          // pension, rental, etc.
      partTime: { income: 0, years: 0 },  // work after retirement

      taxes: {
        ordinary: 0.20,        // blended rate on pay, IRA withdrawals, taxable SS
        capitalGains: 0.15,    // on the gain part of brokerage withdrawals
        ssTaxablePortion: 0.85,
        earlyPenalty: 0.10,    // on pre-tax withdrawals before 59½
      },
      rmdAge: 75,              // required withdrawals begin (75 if born 1960 or later)

      allocation: { equities: 0.60, bonds: 0.40, realAssets: 0.00, cash: 0.00 },

      // fixed = spend the same no matter what (the classic 4% rule)
      // guardrails = trim discretionary spending after bad stretches, raise after good ones
      strategy: 'guardrails',
      guardrails: { band: 0.20, cut: 0.10, raise: 0.05, minDiscretionary: 0.30, maxDiscretionary: 1.30 },

      // A range, not a promise. Left out of the headline unless you include it.
      inheritance: { include: false, low: 0, likely: 0, high: 0, ageFrom: 65, ageTo: 80, kind: 'taxable' },
    },

    /*
     * Policy switches: deterministic "what if this law passed" scenarios.
     * No odds. Each one includes what pays for it. They change only cash flows,
     * never markets, so every scenario runs through identical market histories.
     * Defaults follow the published proposals each is named after.
     */
    switches: {
      ssCut:        { label: 'Social Security cut', on: true, year: 2034, cut: 0.20,
                      pays: 'Nothing; the cut is the cost' },
      universalHealthcare: { label: 'Universal health care', on: true, year: 2035, tax: 0.04,
                      pays: 'Income-based tax on pay and on retirement withdrawals' },
      ubi:          { label: 'Universal basic income', on: false, year: 2035, perAdult: 12000, vat: 0.10,
                      pays: 'Sales tax (VAT) on retirement spending' },
      wealthTax:    { label: 'Wealth tax', on: false, year: 2030, rate: 0.02, threshold: 50000000,
                      pays: 'Nothing; the tax is the cost' },
      capitalGains: { label: 'Higher capital gains tax', on: false, year: 2030, delta: 0.05,
                      pays: 'Nothing; the tax is the cost' },
      meansTest:    { label: 'Social Security means test', on: false, year: 2035, threshold: 1500000, reduction: 0.50,
                      pays: 'Nothing; the reduction is the cost' },
    },

    /*
     * Your worldview: the nonlinear layer.
     */
    world: {
      paths: 5000,
      seed: 42,

      // The classic planner's assumption: one set of statistics, forever. Annual, nominal.
      linearBaseline: {
        label: 'Steady statistics',
        inflation:  { mean: 0.025, vol: 0.010 },
        equities:   { mean: 0.090, vol: 0.170 },
        bonds:      { mean: 0.045, vol: 0.060 },
        realAssets: { mean: 0.050, vol: 0.100 },
        cash:       { mean: 0.030, vol: 0.010 },
        correlations: { 'equities|bonds': 0.0 },
      },

      // The economy sits in one regime per year and switches by the table below.
      // Calibrated so the long-run average roughly matches the linear baseline:
      // differences then come from the path, not from being more pessimistic.
      regimes: {
        start: 'steady',
        states: {
          steady: {
            label: 'Steady growth',
            inflation:  { mean: 0.025, vol: 0.010 },
            equities:   { mean: 0.110, vol: 0.150 },
            bonds:      { mean: 0.050, vol: 0.050 },
            realAssets: { mean: 0.045, vol: 0.080 },
            cash:       { mean: 0.030, vol: 0.008 },
            correlations: { 'equities|bonds': -0.2 },
          },
          inflationary: {
            label: 'Stagflation / fiscal dominance',
            inflation:  { mean: 0.065, vol: 0.025 },
            equities:   { mean: 0.050, vol: 0.200 },
            bonds:      { mean: 0.010, vol: 0.090 },
            realAssets: { mean: 0.090, vol: 0.140 },
            cash:       { mean: 0.055, vol: 0.015 },
            correlations: { 'equities|bonds': 0.5 },  // stocks and bonds fall together
          },
          bust: {
            label: 'Deflationary bust',
            inflation:  { mean: 0.000, vol: 0.015 },
            equities:   { mean: -0.040, vol: 0.250 },
            bonds:      { mean: 0.075, vol: 0.080 },
            realAssets: { mean: -0.020, vol: 0.120 },
            cash:       { mean: 0.010, vol: 0.005 },
            correlations: { 'equities|bonds': -0.4 },
          },
          aiBoom: {
            label: 'AI productivity boom',
            inflation:  { mean: 0.015, vol: 0.010 },
            equities:   { mean: 0.160, vol: 0.190 },
            bonds:      { mean: 0.045, vol: 0.050 },
            realAssets: { mean: 0.030, vol: 0.080 },
            cash:       { mean: 0.030, vol: 0.008 },
            correlations: { 'equities|bonds': -0.1 },
          },
        },
        transitions: {  // from -> to; each row sums to 1
          steady:       { steady: 0.80, inflationary: 0.08, bust: 0.07, aiBoom: 0.05 },
          inflationary: { steady: 0.20, inflationary: 0.70, bust: 0.07, aiBoom: 0.03 },
          bust:         { steady: 0.35, inflationary: 0.10, bust: 0.50, aiBoom: 0.05 },
          aiBoom:       { steady: 0.15, inflationary: 0.08, bust: 0.07, aiBoom: 0.70 },
        },
      },

      /*
       * Disruptions: the same kinds of changes as the policy switches (with what
       * pays for them), plus technology and macro shocks, each with YOUR odds of
       * happening somewhere in a window of years. Some make others more likely.
       *
       * Effect keys (all permanent from the year it happens):
       *   ssMultiplier, ssMeansTest {threshold, reduction}, healthcareMultiplier,
       *   incomeTax (on pay and withdrawals), ubiPerAdult, vat, wealthTax {rate, threshold},
       *   capitalGainsDelta, ordinaryTaxDelta, earnedIncomeMultiplier, spendingMultiplier,
       *   planExtension (years), and market effects: inflationDelta, equityDelta,
       *   regimeTilt {regime: x}, forceRegime {regime, years}
       */
      disruptions: {
        ssCut: {
          label: 'Social Security across-the-board cut', on: true,
          probability: 0.50, window: [2032, 2036],
          boostedBy: { fiscalCrisis: 2.0 },
          effects: { ssMultiplier: 0.80 },
          note: 'Trustees project the trust fund runs short in the early-to-mid 2030s, leaving roughly 77-81% of benefits payable unless Congress acts.',
        },
        ssMeansTest: {
          label: 'Social Security means testing', on: true,
          probability: 0.30, window: [2030, 2045],
          boostedBy: { fiscalCrisis: 1.5, ubi: 2.0 },
          effects: { ssMeansTest: { threshold: 1500000, reduction: 0.50 } },
          note: 'Benefits reduced for households with substantial savings.',
        },
        universalHealthcare: {
          label: 'Universal health care', on: true,
          probability: 0.20, window: [2029, 2045],
          boostedBy: { aiDisplacement: 1.5 },
          effects: { healthcareMultiplier: 0, incomeTax: 0.04 },
          note: 'Premiums go to $0, paid for by an income-based tax on pay and withdrawals.',
        },
        aiDisplacement: {
          label: 'AI displaces white-collar work', on: true,
          probability: 0.40, window: [2027, 2035],
          effects: { earnedIncomeMultiplier: 0.50, regimeTilt: { aiBoom: 1.8, bust: 1.3 } },
          note: 'Pay drops for anyone still working; markets turn more bimodal (boom for owners of capital, or a demand-driven bust).',
        },
        ubi: {
          label: 'Universal basic income', on: true,
          probability: 0.15, window: [2030, 2045],
          boostedBy: { aiDisplacement: 3.0 },
          effects: { ubiPerAdult: 12000, vat: 0.10, inflationDelta: 0.005 },
          note: 'A yearly payment per adult from retirement, paid for by a VAT, with some added inflation.',
        },
        fiscalCrisis: {
          label: 'US fiscal / debt crisis', on: true,
          probability: 0.20, window: [2027, 2040],
          effects: { forceRegime: { regime: 'inflationary', years: 3 }, ordinaryTaxDelta: 0.02, regimeTilt: { inflationary: 1.5 } },
          note: 'The bond market forces a reckoning; inflation is used to shrink the debt; taxes rise.',
        },
        capitalTaxes: {
          label: 'Higher taxes on capital', on: true,
          probability: 0.25, window: [2027, 2040],
          boostedBy: { ubi: 2.0, fiscalCrisis: 2.0 },
          effects: { capitalGainsDelta: 0.05 },
          note: 'Higher rates on investment gains.',
        },
        longevity: {
          label: 'Longevity breakthrough', on: true,
          probability: 0.10, window: [2030, 2050],
          boostedBy: { aiDisplacement: 1.5 },
          effects: { planExtension: 8 },
          note: 'Good news that is a financial risk: the money has to last longer.',
        },
      },
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DEFAULTS;
  else root.DEFAULTS = DEFAULTS;
})(this);
