import pytest
from config import LAYER_RULES, ADVANCED_ONLY_COMBOS, MAX_ACTIVE_LAYERS
from models import AppMode


def can_activate_layer(product_id: str, current_layers: list[str], mode: AppMode) -> tuple[bool, str | None]:
    """Replicate the layer validation logic (same as routers/radar.py validate-layers)."""
    all_layers = current_layers + [product_id]

    if len(all_layers) > MAX_ACTIVE_LAYERS:
        return False, f"Max {MAX_ACTIVE_LAYERS} active layers"

    if product_id not in LAYER_RULES:
        return False, f"Unknown product: {product_id}"

    active_set = set(all_layers)
    if mode == AppMode.basic:
        for combo in ADVANCED_ONLY_COMBOS:
            if combo.issubset(active_set):
                return False, f"Combination {combo} requires advanced mode"

    return True, None


def test_max_two_layers():
    """AC-9: Cannot activate more than 2 layers."""
    ok, reason = can_activate_layer("cc", ["reflectivity", "srv"], AppMode.advanced)
    assert ok is False
    assert "Max 2" in reason


def test_single_layer_allowed():
    """Single layer always allowed."""
    ok, _ = can_activate_layer("reflectivity", [], AppMode.basic)
    assert ok is True


def test_two_layers_allowed():
    """Two compatible layers allowed in basic mode."""
    ok, _ = can_activate_layer("srv", ["reflectivity"], AppMode.basic)
    assert ok is True


def test_srv_cc_allowed_basic():
    """SRV + CC allowed in basic mode (site-aligned, designed to work together)."""
    ok, _ = can_activate_layer("cc", ["srv"], AppMode.basic)
    assert ok is True


def test_srv_cc_allowed_advanced():
    """SRV + CC allowed in advanced mode."""
    ok, _ = can_activate_layer("cc", ["srv"], AppMode.advanced)
    assert ok is True


def test_reflectivity_srv_basic():
    """Reflectivity + SRV allowed in basic mode."""
    ok, _ = can_activate_layer("srv", ["reflectivity"], AppMode.basic)
    assert ok is True


def test_reflectivity_cc_basic():
    """Reflectivity + CC allowed in basic mode."""
    ok, _ = can_activate_layer("cc", ["reflectivity"], AppMode.basic)
    assert ok is True


def test_unknown_product_rejected():
    """Unknown product ID rejected."""
    ok, reason = can_activate_layer("fake_product", [], AppMode.basic)
    assert ok is False
    assert "Unknown" in reason


def test_layer_rules_completeness():
    """All required products have rules defined."""
    assert "reflectivity" in LAYER_RULES
    assert "srv" in LAYER_RULES
    assert "cc" in LAYER_RULES


def test_reflectivity_is_base():
    """Reflectivity is not overlay-eligible (it's the base)."""
    assert LAYER_RULES["reflectivity"]["overlay_eligible"] is False


def test_srv_is_overlay():
    """SRV is overlay-eligible."""
    assert LAYER_RULES["srv"]["overlay_eligible"] is True
    assert LAYER_RULES["srv"]["opacity"] == 0.65


def test_cc_is_overlay():
    """CC is overlay-eligible."""
    assert LAYER_RULES["cc"]["overlay_eligible"] is True
    assert LAYER_RULES["cc"]["opacity"] == 0.55


def test_no_product_requires_advanced_alone():
    """No single product requires advanced mode on its own."""
    for pid, rules in LAYER_RULES.items():
        assert rules["requires_advanced"] is False, f"{pid} should not require advanced alone"
