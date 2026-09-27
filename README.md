# Nonlinear Planner

A personal retirement planner that doesn't assume the next 30 years will look like the last 30.

It combines two designs:

- **TJ's Get FIREd planning model:** accounts by tax type, taxes and the early-withdrawal
  penalty, required minimum distributions, spending by life stage, health costs that outpace
  inflation, spending guardrails, an inheritance range, policy switches that each include
  what pays for them, and a ranked list of "top moves".
- **A nonlinear layer:** the economy moves between regimes that last for years (steady growth,
  stagflation, deflationary bust, AI boom), and structural disruptions (Social Security cuts
  and means testing, universal health care, UBI, AI job displacement, a debt crisis, higher
  capital taxes, a longevity breakthrough) happen at *your* odds, cascade, and can move markets.

The headline compares the **classic plan** (one steady set of market statistics, today's law)
with **your world**. Both are calibrated to about the same long-run returns, so the gap comes from
the shape of the future, not from being more pessimistic.

## Open it

It's a single web page. There's nothing to install, no server, and no internet needed.

1. Download this repository: on GitHub click **Code → Download ZIP** and unzip it, or
   `git clone https://github.com/tomyoungjr/FinancialPlanner.git`.
2. Double-click **`index.html`**. It opens in your browser.

Your numbers go in the **Inputs** screen and are saved only in that browser on that computer.
Use **Export** to keep a backup file; files ending in `.local.json` are ignored by git so they
never end up on GitHub.

On a phone, it lays out like an app with a tab bar along the bottom. **Hide $** scales every
dollar figure by one hidden factor so you can show the screens to someone without showing
your real amounts.

## Screens

| Screen | The question it answers |
|---|---|
| Plan | Will the money last, in the classic plan and in your world? |
| Scenarios | What if a specific law passes? Each switch alone and in combination, through identical markets. |
| Your world | Your odds for each disruption, which ones the plan is fragile to, stress tests, and the regime you retire into |
| Moves | Which changes raise the odds most, measured one at a time |
| Inputs | Your household |
| How it works | The model, its principles, and its simplifications |

## Project layout

```
index.html          the page and its styles
js/defaults.js      placeholder household, policy switches, regimes and disruptions
js/engine.js        the planning math (no AI, no network)
js/charts.js        small SVG charts
js/app.js           screens and inputs
tests/              engine tests: node --test tests/  (or npm test)
```

To change the model itself (new disruptions, different regimes), edit `js/defaults.js`, or
open this folder in Claude Code and ask.

This is a tool for testing your thinking, not a forecast or financial advice.
