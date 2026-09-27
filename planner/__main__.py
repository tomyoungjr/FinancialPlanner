"""Command-line report: python -m planner"""

import sys

import pandas as pd

from .analysis import disruption_attribution, failure_regimes, summary
from .config import load_household, load_world, validate
from .simulate import simulate


def main():
    household, world = load_household(), load_world()
    problems = validate(household, world)
    if problems:
        print("Config problems:\n  " + "\n  ".join(problems))
        sys.exit(1)

    linear = simulate(household, world, linear=True)
    nonlinear = simulate(household, world)
    a, b = summary(linear), summary(nonlinear)

    pd.set_option("display.width", 120)
    print(f"First-year retirement withdrawal rate: {b['first_withdrawal_rate']:.1%}\n")
    print(f"{'':32}{'Linear world':>16}{'Nonlinear world':>18}")
    print(f"{'Chance money lasts':32}{a['success_rate']:>16.0%}{b['success_rate']:>18.0%}")
    print(f"{'Median ending portfolio (real)':32}{a['median_end_portfolio']:>16,.0f}{b['median_end_portfolio']:>18,.0f}")
    print(f"{'Bad-case (10th pct) ending':32}{a['p10_end_portfolio']:>16,.0f}{b['p10_end_portfolio']:>18,.0f}")
    print("\nDisruptions, worst first:")
    print(disruption_attribution(nonlinear, world).to_string(index=False, float_format=lambda x: f"{x:.2f}"))
    print("\nRegime you retire into:")
    print(failure_regimes(nonlinear).to_string(index=False, float_format=lambda x: f"{x:.2f}"))


if __name__ == "__main__":
    main()
