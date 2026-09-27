"""Monte Carlo engine: regime-switching markets plus structural disruptions.

Everything runs vectorized across simulation paths; the only Python loop is
over years. Cash flows are computed in today's dollars ("real") and converted
to nominal with each path's own price index, so inflation shocks compound.
"""

from dataclasses import dataclass, field

import numpy as np

from .config import ASSETS

VARS = ["inflation"] + ASSETS

# Correlations used unless a regime overrides them ("a|b" keys).
DEFAULT_CORR = {
    "inflation|equities": -0.1,
    "inflation|bonds": -0.3,
    "inflation|real_assets": 0.4,
    "inflation|cash": 0.5,
    "equities|bonds": 0.0,
    "equities|real_assets": 0.3,
    "bonds|real_assets": 0.1,
}


@dataclass
class SimResult:
    ages: np.ndarray               # (T,) age at the start of each simulated year
    years: np.ndarray              # (T,) calendar year
    real_portfolio: np.ndarray     # (N, T) end-of-year portfolio, today's dollars; NaN past end of plan
    real_spending: np.ndarray      # (N, T) spending actually achieved, today's dollars
    regime: np.ndarray             # (N, T) regime index
    regime_names: list
    regime_labels: list
    success: np.ndarray            # (N,) money lasted through the (possibly extended) plan
    depletion_age: np.ndarray      # (N,) age money ran out; NaN if it never did
    end_age: np.ndarray            # (N,) plan end age per path
    occurred_year: dict = field(default_factory=dict)  # disruption -> (N,) calendar year or -1
    first_withdrawal_rate: float = float("nan")

    @property
    def success_rate(self):
        return float(self.success.mean())


def _corr_matrix(overrides):
    corr = dict(DEFAULT_CORR)
    corr.update(overrides or {})
    n = len(VARS)
    m = np.eye(n)
    for key, value in corr.items():
        a, b = key.split("|")
        i, j = VARS.index(a), VARS.index(b)
        m[i, j] = m[j, i] = value
    # Hand-entered correlations may not be mutually consistent; nudge to positive definite.
    vals, vecs = np.linalg.eigh(m)
    if vals.min() <= 1e-8:
        m = vecs @ np.diag(np.clip(vals, 1e-6, None)) @ vecs.T
        d = np.sqrt(np.diag(m))
        m = m / np.outer(d, d)
    return m


def _market_model(world, linear):
    if linear:
        states = {"linear": dict(world["linear_baseline"], label="Linear baseline")}
        names = ["linear"]
        trans = np.ones((1, 1))
        start = 0
    else:
        states = world["regimes"]["states"]
        names = list(states)
        trans = np.array([[world["regimes"]["transitions"][a].get(b, 0.0) for b in names] for a in names])
        start = names.index(world["regimes"].get("start", names[0]))
    mu = np.array([[states[s][v]["mean"] for v in VARS] for s in names])
    vol = np.array([[states[s][v]["vol"] for v in VARS] for s in names])
    chol = np.array([np.linalg.cholesky(_corr_matrix(states[s].get("correlations"))) for s in names])
    labels = [states[s].get("label", s) for s in names]
    return names, labels, trans, start, mu, vol, chol


def _annual_hazard(probability, window):
    """Convert 'X% chance somewhere in this window' into a constant yearly chance."""
    n_years = window[1] - window[0] + 1
    if probability >= 1:
        return 1.0
    return 1 - (1 - probability) ** (1 / n_years)


def simulate(household, world, linear=False, forced=None, disabled=None, paths=None, seed=None):
    """Run the Monte Carlo.

    linear   -- True runs the classic single-regime world with no disruptions.
    forced   -- {disruption_key: calendar_year} guarantees a disruption in that year (stress test).
    disabled -- iterable of disruption keys to switch off.
    """
    h = household
    sim_cfg = world.get("simulation", {})
    N = int(paths or sim_cfg.get("paths", 5000))
    rng = np.random.default_rng(seed if seed is not None else sim_cfg.get("seed"))
    forced = forced or {}
    disabled = set(disabled or [])

    names, labels, trans, start, mu, vol, chol = _market_model(world, linear)
    R = len(names)
    disruptions = {} if linear else {
        k: d for k, d in world.get("disruptions", {}).items() if k not in disabled
    }
    dkeys = list(disruptions)
    max_ext = max([d.get("effects", {}).get("plan_extension_years", 0) for d in disruptions.values()] + [0])

    base_T = h["plan_to_age"] - h["current_age"]
    T = base_T + max_ext
    ages = h["current_age"] + np.arange(T)
    years = h["start_year"] + np.arange(T)
    weights = np.array([h["allocation"].get(a, 0.0) for a in ASSETS])

    portfolio = np.full(N, float(h["portfolio"]))   # nominal dollars
    price = np.ones(N)
    regime = np.full(N, start)
    forced_regime = np.full(N, -1)
    forced_left = np.zeros(N, dtype=int)
    occurred = {k: np.full(N, -1) for k in dkeys}
    disc_adj = np.ones(N)
    initial_wr = np.full(N, np.nan)
    end_age = np.full(N, h["plan_to_age"], dtype=float)
    depletion_age = np.full(N, np.nan)

    out_port = np.full((N, T), np.nan)
    out_spend = np.full((N, T), np.nan)
    out_regime = np.zeros((N, T), dtype=int)
    gr = h.get("guardrails", {})
    first_wr = []

    for t in range(T):
        year, age = years[t], ages[t]

        # 1. Which disruptions happen this year?
        for k in dkeys:
            d = disruptions[k]
            fresh = occurred[k] < 0
            if k in forced:
                fire = fresh & (year == forced[k])
            else:
                lo, hi = d["window"]
                if not (lo <= year <= hi):
                    continue
                hz = np.full(N, _annual_hazard(d["probability"], d["window"]))
                for other, mult in d.get("boosted_by", {}).items():
                    if other in occurred:
                        hz = np.where(occurred[other] >= 0, hz * mult, hz)
                fire = fresh & (rng.random(N) < np.minimum(hz, 1.0))
            if fire.any():
                occurred[k][fire] = year
                fr = d.get("effects", {}).get("force_regime")
                if fr:
                    forced_regime[fire] = names.index(fr["regime"])
                    forced_left[fire] = fr["years"]

        # 2. Combine the effects of everything that has happened so far.
        ss_mult = np.ones(N); hc_mult = np.ones(N); earn_mult = np.ones(N); spend_mult = np.ones(N)
        tax_delta = np.zeros(N); infl_delta = np.zeros(N); eq_delta = np.zeros(N); extra = np.zeros(N)
        tilt = np.ones((N, R))
        real_port_now = portfolio / price
        for k in dkeys:
            active = occurred[k] >= 0
            if not active.any():
                continue
            fx = disruptions[k].get("effects", {})
            ss_mult = np.where(active, ss_mult * fx.get("ss_multiplier", 1.0), ss_mult)
            hc_mult = np.where(active, hc_mult * fx.get("healthcare_multiplier", 1.0), hc_mult)
            earn_mult = np.where(active, earn_mult * fx.get("earned_income_multiplier", 1.0), earn_mult)
            spend_mult = np.where(active, spend_mult * fx.get("spending_multiplier", 1.0), spend_mult)
            tax_delta += np.where(active, fx.get("tax_rate_delta", 0.0), 0.0)
            infl_delta += np.where(active, fx.get("inflation_delta", 0.0), 0.0)
            eq_delta += np.where(active, fx.get("equity_return_delta", 0.0), 0.0)
            extra += np.where(active, fx.get("extra_income", 0.0), 0.0)
            mt = fx.get("ss_means_test")
            if mt:
                hit = active & (real_port_now >= mt["asset_threshold"])
                ss_mult = np.where(hit, ss_mult * (1 - mt["reduction"]), ss_mult)
            for r, m in fx.get("regime_tilt", {}).items():
                tilt[active, names.index(r)] *= m
            ext = fx.get("plan_extension_years", 0)
            if ext:
                end_age = np.where(active, np.maximum(end_age, h["plan_to_age"] + ext), end_age)

        # 3. Economic regime for this year.
        if R > 1:
            p = trans[regime] * tilt
            p /= p.sum(axis=1, keepdims=True)
            regime = (rng.random((N, 1)) > np.cumsum(p, axis=1)).sum(axis=1)
            regime = np.minimum(regime, R - 1)
            jolt = forced_left > 0
            regime = np.where(jolt, forced_regime, regime)
            forced_left = np.where(jolt, forced_left - 1, 0)
        out_regime[:, t] = regime

        # 4. Market draws (correlated within each regime).
        z = rng.standard_normal((N, len(VARS)))
        zc = np.einsum("nij,nj->ni", chol[regime], z)
        shock = mu[regime] + vol[regime] * zc
        inflation = shock[:, 0] + infl_delta
        rets = shock[:, 1:]
        rets[:, 0] += eq_delta
        rets = np.maximum(rets, -0.95)

        # 5. Cash flows for the year, in today's dollars.
        working = age < h["retirement_age"]
        earned = h["earned_income"] * earn_mult if working else np.zeros(N)
        ss = h["social_security_benefit"] * ss_mult if age >= h["social_security_age"] else np.zeros(N)
        income = earned + ss + extra + h.get("other_income", 0)
        hc = h["healthcare_cost"] * hc_mult * (1 + h["healthcare_real_growth"]) ** t
        if working:
            spend = h["pre_retirement_spending"] * spend_mult
        else:
            spend = (h["essential_spending"] + h["discretionary_spending"] * disc_adj) * spend_mult
        tax = np.clip(h["effective_tax_rate"] + tax_delta, 0, 0.6)
        need = spend + hc - income * (1 - tax)
        withdrawal = np.where(need > 0, need / (1 - tax), need)  # negative = saving

        # Guardrails: compare this year's withdrawal rate with the one retirement started at.
        if not working:
            with np.errstate(divide="ignore", invalid="ignore"):
                wr = np.where(real_port_now > 0, withdrawal / real_port_now, np.inf)
            if np.isnan(initial_wr).all():
                first_wr.append(np.nanmedian(np.where(np.isfinite(wr), wr, np.nan)))
            initial_wr = np.where(np.isnan(initial_wr), np.maximum(wr, 1e-4), initial_wr)
            if h.get("strategy") == "guardrails":
                band = gr.get("band", 0.2)
                high = wr > initial_wr * (1 + band)
                low = wr < initial_wr * (1 - band)
                disc_adj = np.where(high, np.maximum(disc_adj * (1 - gr.get("cut", 0.1)), gr.get("min_discretionary", 0.3)), disc_adj)
                disc_adj = np.where(low, np.minimum(disc_adj * (1 + gr.get("raise", 0.05)), gr.get("max_discretionary", 1.3)), disc_adj)

        # 6. Take the money out (can't take more than is there).
        available = np.maximum(real_port_now, 0)
        taken = np.minimum(withdrawal, available)
        shortfall = np.maximum(withdrawal - taken, 0) * (1 - tax)
        newly_depleted = (shortfall > 1.0) & np.isnan(depletion_age) & (age < end_age)
        depletion_age = np.where(newly_depleted, age, depletion_age)
        portfolio = (real_port_now - taken) * price

        # 7. Markets move, prices rise.
        portfolio = portfolio * (1 + rets @ weights)
        price = price * (1 + inflation)

        in_plan = age < end_age
        out_port[:, t] = np.where(in_plan, portfolio / price, np.nan)
        out_spend[:, t] = np.where(in_plan, spend + hc - shortfall, np.nan)

    return SimResult(
        ages=ages,
        years=years,
        real_portfolio=out_port,
        real_spending=out_spend,
        regime=out_regime,
        regime_names=names,
        regime_labels=labels,
        success=np.isnan(depletion_age),
        depletion_age=depletion_age,
        end_age=end_age,
        occurred_year=occurred,
        first_withdrawal_rate=float(first_wr[0]) if first_wr else float("nan"),
    )
