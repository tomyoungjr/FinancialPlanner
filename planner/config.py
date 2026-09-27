"""Load and validate the YAML configuration files."""

from pathlib import Path

import yaml

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"
ASSETS = ["equities", "bonds", "real_assets", "cash"]


def load_yaml(path):
    with open(path) as f:
        return yaml.safe_load(f)


def load_household(path=None):
    """Prefer a private household.local.yaml (git-ignored) over the placeholder file."""
    if path is None:
        local = CONFIG_DIR / "household.local.yaml"
        path = local if local.exists() else CONFIG_DIR / "household.yaml"
    return load_yaml(path)


def load_world(path=None):
    return load_yaml(path or CONFIG_DIR / "world.yaml")


def validate(household, world):
    """Return a list of human-readable problems (empty if the config is usable)."""
    problems = []
    alloc = household["allocation"]
    total = sum(alloc.get(a, 0) for a in ASSETS)
    if abs(total - 1.0) > 1e-6:
        problems.append(f"Allocation sums to {total:.2f}, should be 1.00")
    if household["retirement_age"] < household["current_age"]:
        problems.append("Retirement age is before current age")

    states = world["regimes"]["states"]
    for src, row in world["regimes"]["transitions"].items():
        if src not in states:
            problems.append(f"Transition row '{src}' is not a defined regime")
        for dst in row:
            if dst not in states:
                problems.append(f"Transition '{src}' -> '{dst}': unknown regime")
        if abs(sum(row.values()) - 1.0) > 1e-6:
            problems.append(f"Transitions from '{src}' sum to {sum(row.values()):.2f}, should be 1.00")

    names = set(world.get("disruptions", {}))
    for key, d in world.get("disruptions", {}).items():
        if not 0 <= d["probability"] <= 1:
            problems.append(f"Disruption '{key}': probability must be between 0 and 1")
        if d["window"][0] > d["window"][1]:
            problems.append(f"Disruption '{key}': window start is after end")
        for other in d.get("boosted_by", {}):
            if other not in names:
                problems.append(f"Disruption '{key}': boosted_by unknown disruption '{other}'")
        fx = d.get("effects", {})
        for r in list(fx.get("regime_tilt", {})) + [fx.get("force_regime", {}).get("regime")]:
            if r is not None and r not in states:
                problems.append(f"Disruption '{key}': unknown regime '{r}'")
    return problems
