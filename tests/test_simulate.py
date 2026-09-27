import copy

import numpy as np
import pytest

from planner.config import load_household, load_world, validate
from planner.simulate import _annual_hazard, simulate


@pytest.fixture
def cfg():
    return load_household(), load_world()


def test_shipped_config_is_valid(cfg):
    assert validate(*cfg) == []


def test_hazard_matches_window_probability():
    h = _annual_hazard(0.5, [2030, 2034])
    assert 1 - (1 - h) ** 5 == pytest.approx(0.5)


def test_disruption_frequency_matches_stated_odds(cfg):
    household, world = cfg
    world = copy.deepcopy(world)
    for d in world["disruptions"].values():
        d.pop("boosted_by", None)
    res = simulate(household, world, paths=20000, seed=1)
    hit = (res.occurred_year["universal_healthcare"] >= 0).mean()
    assert hit == pytest.approx(world["disruptions"]["universal_healthcare"]["probability"], abs=0.02)


def test_forced_disruption_happens_in_that_year(cfg):
    res = simulate(*cfg, forced={"ss_across_the_board_cut": 2033}, paths=500, seed=1)
    assert (res.occurred_year["ss_across_the_board_cut"] == 2033).all()


def test_ss_cut_lowers_success(cfg):
    household, world = cfg
    world = copy.deepcopy(world)
    world["disruptions"]["ss_across_the_board_cut"]["effects"]["ss_multiplier"] = 0.0
    base = simulate(household, world, disabled=["ss_across_the_board_cut"], paths=3000, seed=7)
    cut = simulate(household, world, forced={"ss_across_the_board_cut": 2027}, paths=3000, seed=7)
    assert cut.success_rate < base.success_rate


def test_zero_volatility_linear_world_is_deterministic(cfg):
    household, world = cfg
    world = copy.deepcopy(world)
    for v in world["linear_baseline"].values():
        if isinstance(v, dict) and "vol" in v:
            v["vol"] = 0.0
    res = simulate(household, world, linear=True, paths=50, seed=3)
    assert np.allclose(res.real_portfolio, res.real_portfolio[0])


def test_longevity_extends_plan(cfg):
    res = simulate(*cfg, forced={"longevity_breakthrough": 2031}, paths=200, seed=2)
    assert (res.end_age == cfg[0]["plan_to_age"] + 8).all()
