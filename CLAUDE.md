# Nonlinear Planner

Personal retirement planner as a single static web page (open `index.html`; no build, no server,
no network). It merges TJ's "Get FIREd" planning model with a nonlinear layer: regime-switching
markets and structural disruptions at the owner's odds.

## Architecture
- `js/engine.js`: all math, UMD so tests run in Node. Three stages, each with its own random stream:
  `drawTimelines` (disruptions) → `drawMarkets` (regimes, returns, inflation) → `simulate` (household).
  `makeContext` builds markets once; `ctx.run(household, policies)` reuses them.
- `js/defaults.js`: placeholder inputs, policy switches, regimes, disruptions. No real personal data.
- `js/app.js`: screens; state in localStorage; export/import as `*.local.json` (git-ignored).
- `js/charts.js`: hand-rolled SVG; no external libraries or CDNs (the page must work offline).
- Scripts are plain `<script>` tags, not ES modules, so the page works from `file://`.

## Principles to keep
- Common random numbers: policy switches and household changes must not change market draws.
  Draw random numbers unconditionally so turning something on/off doesn't reshuffle the rest.
- Policy switches (Scenarios) change cash flows only, carry no odds, and each includes what pays for it.
  Disruptions (Your world) use the same effects vocabulary but may also move markets and carry odds.
- New effect keys: handle in `mergeEffects`/`simulate` (or `drawMarkets` for market effects),
  describe in `describeEffects` in app.js, and list in the defaults.js header comment.
- Keep the linear and regime worlds calibrated to similar long-run averages (`longRunAverages`; there is a test).
- The engine is advice-only math. Nothing here moves money or calls out to any service.
- All inputs are today's dollars; the engine applies per-path inflation.
- The owner is not a programmer. Explain changes in plain language.

## Commands
- `node --test tests/` (or `npm test`): engine tests
- Open `index.html` in a browser to use it
