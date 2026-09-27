"""Turn raw simulation output into tables a person can read."""

import numpy as np
import pandas as pd


def percentile_bands(values, ages, qs=(10, 25, 50, 75, 90)):
    """Percentiles of a (paths x years) array by age. NaNs (after plan end) are ignored."""
    with np.errstate(all="ignore"):
        data = {f"p{q}": np.nanpercentile(values, q, axis=0) for q in qs}
    df = pd.DataFrame(data)
    df.insert(0, "age", ages)
    return df.dropna()


def summary(result):
    depleted = result.depletion_age[~np.isnan(result.depletion_age)]
    retired_spend = result.real_spending
    return {
        "success_rate": result.success_rate,
        "median_end_portfolio": float(np.nanmedian(_last_valid(result.real_portfolio))),
        "p10_end_portfolio": float(np.nanpercentile(_last_valid(result.real_portfolio), 10)),
        "median_depletion_age": float(np.median(depleted)) if len(depleted) else None,
        "median_min_spending": float(np.nanmedian(np.nanmin(retired_spend, axis=1))),
        "first_withdrawal_rate": result.first_withdrawal_rate,
    }


def _last_valid(arr):
    """Value in the last non-NaN column of each row (each path's plan end)."""
    idx = (~np.isnan(arr)).cumsum(axis=1).argmax(axis=1)
    return arr[np.arange(arr.shape[0]), idx]


def disruption_attribution(result, world):
    """For each disruption: how often it happened and how the plan fared with vs without it."""
    rows = []
    for key, yr in result.occurred_year.items():
        hit = yr >= 0
        d = world["disruptions"][key]
        rows.append({
            "disruption": d.get("label", key),
            "happened in % of futures": hit.mean(),
            "success if it happened": result.success[hit].mean() if hit.any() else np.nan,
            "success if it didn't": result.success[~hit].mean() if (~hit).any() else np.nan,
            "median year": float(np.median(yr[hit])) if hit.any() else np.nan,
        })
    df = pd.DataFrame(rows)
    if not df.empty:
        df["impact on success"] = df["success if it happened"] - df["success if it didn't"]
        df = df.sort_values("impact on success")
    return df


def regime_share(result):
    counts = np.bincount(result.regime.ravel(), minlength=len(result.regime_names))
    return pd.DataFrame({
        "regime": result.regime_labels,
        "share of years": counts / counts.sum(),
    })


def failure_regimes(result, first_years=10):
    """Which regime dominated the first decade, for failed vs successful paths.

    Sequence-of-returns risk means the regime you retire into matters most.
    """
    early = result.regime[:, :first_years]
    R = len(result.regime_names)
    dominant = np.array([np.bincount(row, minlength=R).argmax() for row in early])
    rows = []
    for i, label in enumerate(result.regime_labels):
        m = dominant == i
        rows.append({
            "first-decade regime": label,
            "% of futures": m.mean(),
            "success rate": result.success[m].mean() if m.any() else np.nan,
        })
    return pd.DataFrame(rows)


def long_run_averages(world):
    """Long-run average of each variable implied by the regime model vs the linear baseline."""
    from .simulate import VARS, _market_model

    names, labels, trans, start, mu, vol, chol = _market_model(world, linear=False)
    vals, vecs = np.linalg.eig(trans.T)
    pi = np.real(vecs[:, np.argmin(np.abs(vals - 1))])
    pi = pi / pi.sum()
    base = world["linear_baseline"]
    return pd.DataFrame({
        "variable": VARS,
        "linear world": [base[v]["mean"] for v in VARS],
        "nonlinear world (long run)": pi @ mu,
    }), pd.DataFrame({"regime": labels, "long-run share of years": pi})
