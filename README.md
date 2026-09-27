# Nonlinear Planner

A personal financial planner that doesn't assume the next 30 years will look like the last 30.

Most planners, including most Monte Carlo tools, pick one set of assumptions (average return,
volatility, inflation) and roll them forward for decades. The randomness is real, but the
*system* is treated as fixed. This planner runs your plan in two worlds side by side:

- **Linear world:** the classic assumption. One set of market statistics, forever.
- **Nonlinear world:** the economy moves between regimes that last years, and structural
  disruptions (Social Security cuts, means testing, UBI, universal healthcare, AI labor
  displacement, fiscal crisis, higher capital taxes, longevity breakthroughs) can permanently
  change the rules partway through your plan.

Both worlds are calibrated to about the same long-run average returns, so the gap between
them comes from the *shape* of the future, not from being more pessimistic.

## Run it on your computer

You need Python 3.10 or newer ([python.org/downloads](https://www.python.org/downloads/)).

```bash
git clone https://github.com/tomyoungjr/FinancialPlanner.git
cd FinancialPlanner
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
streamlit run app.py
```

Your browser opens to `http://localhost:8501`. Everything runs on your machine; nothing is uploaded.

For a quick text report without the browser: `python -m planner`

## Make it yours

1. **`config/household.yaml`**: your ages, assets, income, spending, Social Security, allocation.
   Every number there now is a placeholder.
2. **`config/world.yaml`**: your worldview. Odds and timing for each disruption, what each
   one does, and the market regimes. This is the file worth arguing about.

To keep your real numbers out of GitHub, copy `config/household.yaml` to
`config/household.local.yaml` and put your real numbers there. The planner uses the
`.local` file whenever it exists, and git ignores it.

<!-- about -->
## How it works

**Each simulated future, year by year:**

1. **Disruptions.** Each one has *your* odds of happening somewhere in a window of years.
   Some make others more likely (`boosted_by`), so they cascade: AI job loss raises the
   odds of UBI, and a debt crisis raises the odds of Social Security cuts. Once a disruption
   happens, its effects are permanent.
2. **Regime.** The economy is in one of four regimes: *steady growth*, *fiscal dominance /
   stagflation*, *deflationary bust*, or *AI productivity boom*. Regimes tend to persist,
   and disruptions can push the economy into one (a debt crisis forces 3 years of inflation).
3. **Markets.** Returns and inflation are drawn from that regime's statistics, including
   its stock/bond correlation. In the inflationary regime stocks and bonds fall *together*,
   which is exactly when a 60/40 portfolio stops protecting you.
4. **Cash flow.** Income (salary, Social Security, UBI) minus spending, healthcare, and taxes,
   all adjusted by whatever disruptions have happened, determines the withdrawal.
5. **Spending rule.** *Fixed* spends the same no matter what (the classic 4% rule).
   *Guardrails* trims discretionary spending when the withdrawal rate drifts too high.

**What "success" means:** the portfolio covers the gap every year through the end of the
plan. The end date moves out if a longevity breakthrough happens.

**What this is not:** a forecast or financial advice. The disruption odds are judgment
calls. The point is to see which assumptions your plan is fragile to and which ones
don't matter, then decide what to do about the fragile ones.

**Known simplifications (good next steps):**
- One blended tax rate instead of real brackets or account types (IRA/Roth/taxable)
- Social Security changes applied uniformly; no spousal detail or claiming strategy
- No house, mortgage, annuity, or long-term care modeling
- Disruption effects switch on all at once rather than phasing in
<!-- /about -->

## Project layout

```
app.py                 web interface (Streamlit)
planner/simulate.py    Monte Carlo engine: regimes + disruptions + cash flows
planner/analysis.py    summaries, disruption attribution, regime analysis
planner/config.py      loads and checks the YAML files
config/household.yaml  your situation
config/world.yaml      your worldview
tests/                 run with: pytest
```
