# Nonlinear Planner

Personal retirement planner whose core idea is that the macro system is not stationary.
It compares a classic "linear" Monte Carlo against a "nonlinear" one with regime switching
and structural disruptions (policy and technology changes that permanently alter the rules).

## Principles to keep
- The linear and nonlinear worlds are calibrated to similar long-run averages
  (`long_run_averages` in planner/analysis.py). When changing regimes, keep that check
  roughly balanced so differences reflect path/structure, not pessimism.
- User judgments live in YAML (`config/world.yaml`, `config/household.yaml`), not in code.
  New disruption effects are added as a new key under `effects` and handled in step 2 of
  the year loop in planner/simulate.py; document the key in the world.yaml header.
- All cash-flow inputs are in today's dollars; the engine converts with per-path inflation.
- The engine is vectorized across paths (numpy); only loop over years.
- The owner is not a programmer. Explain changes in plain language.

## Commands
- `streamlit run app.py`: web UI at localhost:8501
- `python -m planner`: text report
- `pytest`: tests
