"""Local web app: streamlit run app.py"""

import copy
import json

import altair as alt
import pandas as pd
import streamlit as st

from planner.analysis import (
    disruption_attribution,
    failure_regimes,
    long_run_averages,
    percentile_bands,
    regime_share,
    summary,
)
from planner.config import ASSETS, load_household, load_world, validate
from planner.simulate import simulate

st.set_page_config(page_title="Nonlinear Planner", layout="wide")


@st.cache_data(show_spinner="Simulating thousands of futures...")
def run(household_json, world_json, linear, forced_json="{}", disabled_json="[]"):
    return simulate(
        json.loads(household_json),
        json.loads(world_json),
        linear=linear,
        forced=json.loads(forced_json),
        disabled=json.loads(disabled_json),
    )


def money(x):
    return "—" if x is None else f"${x:,.0f}"


def fan_chart(bands_by_world, title):
    frames = [b.assign(world=name) for name, b in bands_by_world.items()]
    df = pd.concat(frames)
    base = alt.Chart(df).encode(x=alt.X("age:Q", title="Age"))
    names = list(bands_by_world)
    color = alt.Color("world:N", title=None, sort=names,
                      scale=alt.Scale(domain=names, range=["#6b7280", "#ea580c"]),
                      legend=alt.Legend(orient="top"))
    band = base.mark_area(opacity=0.18).encode(
        y=alt.Y("p10:Q", title="Portfolio (today's dollars)", axis=alt.Axis(format="$.2~s")),
        y2="p90:Q", color=color,
    )
    median = base.mark_line(strokeWidth=3).encode(y="p50:Q", color=color)
    low = base.mark_line(strokeDash=[4, 4]).encode(y="p10:Q", color=color)
    return (band + median + low).properties(title=title, height=380)


# ---------------------------------------------------------------- inputs
household = load_household()
world = load_world()

with st.sidebar:
    st.header("Your household")
    st.caption("Starts from config/household.yaml. Changes here are for exploring; edit the file to make them stick.")
    h = household
    h["current_age"] = st.number_input("Current age", 18, 100, h["current_age"])
    h["retirement_age"] = st.number_input("Retirement age", 18, 100, h["retirement_age"])
    h["plan_to_age"] = st.number_input("Plan to age", 60, 120, h["plan_to_age"])
    h["portfolio"] = st.number_input("Investable assets", 0, None, h["portfolio"], step=50_000)
    h["earned_income"] = st.number_input("Earned income (pre-tax)", 0, None, h["earned_income"], step=5_000)
    h["essential_spending"] = st.number_input("Essential spending in retirement", 0, None, h["essential_spending"], step=5_000)
    h["discretionary_spending"] = st.number_input("Discretionary spending in retirement", 0, None, h["discretionary_spending"], step=5_000)
    h["healthcare_cost"] = st.number_input("Healthcare per year", 0, None, h["healthcare_cost"], step=1_000)
    h["social_security_benefit"] = st.number_input("Social Security (scheduled, per year)", 0, None, h["social_security_benefit"], step=1_000)
    h["social_security_age"] = st.number_input("Social Security start age", 62, 70, h["social_security_age"])
    h["strategy"] = st.radio(
        "Spending rule", ["guardrails", "fixed"],
        index=["guardrails", "fixed"].index(h["strategy"]),
        help="fixed = spend the same no matter what (classic 4% rule). guardrails = trim discretionary spending when markets hurt.",
    )
    st.subheader("Allocation")
    alloc = {}
    remaining = 100
    for a in ASSETS[:-1]:
        alloc[a] = st.slider(a.replace("_", " ").title(), 0, 100, int(round(h["allocation"].get(a, 0) * 100)), 5)
        remaining -= alloc[a]
    st.write(f"Cash: **{remaining}%**")
    if remaining < 0:
        st.error("Allocation is over 100%.")
    alloc["cash"] = max(remaining, 0)
    h["allocation"] = {a: v / 100 for a, v in alloc.items()}
    world["simulation"]["paths"] = st.select_slider("Simulated futures", [1000, 2500, 5000, 10000], world["simulation"]["paths"])

problems = validate(household, world)
if problems:
    st.error("Fix these first:\n\n- " + "\n- ".join(problems))
    st.stop()

# ---------------------------------------------------------------- pages
st.title("Nonlinear Planner")
st.caption(
    "A classic plan assumes one steady set of market statistics for 30 years. "
    "This one also runs a world where the economy changes regimes and the rules themselves change."
)

tab_compare, tab_disrupt, tab_stress, tab_regimes, tab_about = st.tabs(
    ["Linear vs. nonlinear", "Disruptions", "Stress test", "Regimes", "How it works"]
)

# Disruption edits live in the Disruptions tab but feed every tab, so read them first.
if "disruption_table" not in st.session_state:
    st.session_state.disruption_table = pd.DataFrame([
        {"key": k, "on": True, "disruption": d["label"], "probability": d["probability"],
         "from": d["window"][0], "to": d["window"][1]}
        for k, d in world["disruptions"].items()
    ])
table = st.session_state.disruption_table.copy()
for i, changes in st.session_state.get("disruption_editor", {}).get("edited_rows", {}).items():
    for col, val in changes.items():
        table.at[int(i), col] = val
for _, row in table.iterrows():
    d = world["disruptions"][row["key"]]
    d["probability"] = float(row["probability"])
    d["window"] = [int(row["from"]), int(row["to"])]
disabled = [r["key"] for _, r in table.iterrows() if not r["on"]]

hj, wj = json.dumps(household), json.dumps(world)
lin = run(hj, wj, True)
non = run(hj, wj, False, "{}", json.dumps(disabled))
s_lin, s_non = summary(lin), summary(non)

with tab_compare:
    st.markdown(f"First-year retirement withdrawal rate: **{s_non['first_withdrawal_rate']:.1%}** of the portfolio")
    c1, c2, c3 = st.columns(3)
    c1.metric("Chance the money lasts (linear world)", f"{s_lin['success_rate']:.0%}")
    c2.metric("Chance the money lasts (nonlinear world)", f"{s_non['success_rate']:.0%}",
              delta=f"{(s_non['success_rate'] - s_lin['success_rate']) * 100:+.0f} pts")
    c3.metric("If it runs out, typical age", "never" if s_non["median_depletion_age"] is None else f"{s_non['median_depletion_age']:.0f}")
    st.altair_chart(fan_chart({
        "Linear world": percentile_bands(lin.real_portfolio, lin.ages),
        "Nonlinear world": percentile_bands(non.real_portfolio, non.ages),
    }, "Portfolio in today's dollars: median (solid), bad case 10th percentile (dashed), 10–90% range (shaded)"),
        use_container_width=True)
    st.table(pd.DataFrame({
        "": ["Median ending portfolio", "Bad case (10th percentile) ending portfolio", "Lowest yearly spending, typical future"],
        "Linear world": [money(s_lin[k]) for k in ("median_end_portfolio", "p10_end_portfolio", "median_min_spending")],
        "Nonlinear world": [money(s_non[k]) for k in ("median_end_portfolio", "p10_end_portfolio", "median_min_spending")],
    }).set_index(""))
    st.info(
        "Both worlds have roughly the same long-run average returns (see the Regimes tab). "
        "The gap comes from how the returns arrive: regimes that last for years, stocks and bonds falling together, "
        "and rule changes that permanently change your income, costs, and taxes."
    )

with tab_disrupt:
    st.markdown(
        "**This table is your worldview.** Set your own odds that each change happens inside the window. "
        "Changes rerun everything. To change *what* a disruption does, edit `config/world.yaml`."
    )
    st.data_editor(
        st.session_state.disruption_table,
        column_config={
            "key": None,
            "on": st.column_config.CheckboxColumn("On"),
            "disruption": st.column_config.TextColumn("Disruption", disabled=True, width="large"),
            "probability": st.column_config.NumberColumn("Chance in window", min_value=0.0, max_value=1.0, step=0.05, format="%.2f"),
            "from": st.column_config.NumberColumn("From", step=1),
            "to": st.column_config.NumberColumn("To", step=1),
        },
        hide_index=True, use_container_width=True, key="disruption_editor",
    )

    st.subheader("Which disruptions hurt this plan most")
    attr = disruption_attribution(non, world)
    st.dataframe(
        attr.style.format({
            "happened in % of futures": "{:.0%}", "success if it happened": "{:.0%}",
            "success if it didn't": "{:.0%}", "impact on success": "{:+.0%}", "median year": "{:.0f}",
        }),
        hide_index=True, use_container_width=True,
    )
    st.caption("Read with care: disruptions cascade (a debt crisis makes Social Security cuts more likely), so their effects overlap.")
    with st.expander("What each disruption does"):
        for k, d in world["disruptions"].items():
            st.markdown(f"**{d['label']}**: {d.get('note', '')}  \n`effects: {d.get('effects')}`"
                        + (f"  \nmore likely after: `{d['boosted_by']}`" if d.get("boosted_by") else ""))

with tab_stress:
    st.markdown("Force specific changes to happen in a specific year and see what the plan does.")
    options = {d["label"]: k for k, d in world["disruptions"].items()}
    picks = st.multiselect("Force these to happen", list(options))
    forced = {}
    cols = st.columns(max(len(picks), 1))
    for col, label in zip(cols, picks):
        lo, hi = world["disruptions"][options[label]]["window"]
        forced[options[label]] = col.number_input(f"{label}: year", household["start_year"], household["start_year"] + 60,
                                                  max(lo, household["start_year"]), key=f"yr_{label}")
    if forced:
        stressed = run(hj, wj, False, json.dumps(forced), json.dumps(disabled))
        s_st = summary(stressed)
        c1, c2 = st.columns(2)
        c1.metric("Nonlinear world", f"{s_non['success_rate']:.0%}")
        c2.metric("With these forced", f"{s_st['success_rate']:.0%}",
                  delta=f"{(s_st['success_rate'] - s_non['success_rate']) * 100:+.0f} pts")
        st.altair_chart(fan_chart({
            "Nonlinear world": percentile_bands(non.real_portfolio, non.ages),
            "Stress test": percentile_bands(stressed.real_portfolio, stressed.ages),
        }, "Portfolio in today's dollars"), use_container_width=True)

with tab_regimes:
    st.markdown("**The regime you retire into matters most** (sequence-of-returns risk):")
    st.dataframe(failure_regimes(non).style.format({"% of futures": "{:.0%}", "success rate": "{:.0%}"}),
                 hide_index=True, use_container_width=True)
    averages, shares = long_run_averages(world)
    c1, c2 = st.columns(2)
    c1.markdown("**Fairness check:** long-run averages of both worlds")
    c1.dataframe(averages.style.format({"linear world": "{:.1%}", "nonlinear world (long run)": "{:.1%}"}), hide_index=True)
    c2.markdown("**Time spent in each regime** (this simulation)")
    c2.dataframe(regime_share(non).style.format({"share of years": "{:.0%}"}), hide_index=True)
    st.markdown("**Regime details** (edit in `config/world.yaml`)")
    rows = []
    for k, r in world["regimes"]["states"].items():
        rows.append({"regime": r["label"], **{f"{v} avg": r[v]["mean"] for v in ["inflation"] + ASSETS},
                     "stock/bond correlation": r.get("correlations", {}).get("equities|bonds", 0.0),
                     "chance it continues next year": world["regimes"]["transitions"][k][k]})
    st.dataframe(pd.DataFrame(rows), hide_index=True, use_container_width=True)

with tab_about:
    st.markdown(open("README.md").read().split("<!-- about -->")[1].split("<!-- /about -->")[0])
