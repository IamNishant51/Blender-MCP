"""Anti-hallucination guardrail tests (Blender-MCP 1.3.1).

Proves the enforcement works in code, not just in docs:
- a build with no research is REFUSED;
- a spec with invented/missing dimensions is REJECTED;
- a floating part is REJECTED;
- a bad build reports FAILURE (never success:true);
- a grounded, valid build passes verification end to end (real Blender).
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest

from blender_mcp.config import BlenderConfig, PathsConfig, ServerConfig
from blender_mcp.server import BlenderMCPServer
from blender_mcp.utils import setup_logging


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    """Minimally-wired server (same pattern as test_geometry.py: the
    Python server cannot __init__ under the current mcp SDK, so the
    instance is built via __new__ with a stubbed search service)."""
    base = tmp_path_factory.mktemp("blender-mcp-grounding")
    cfg = ServerConfig(
        paths=PathsConfig(
            base_dir=base,
            temp_dir=base / ".temp",
            output_dir=base / "output",
            texture_dir=base / "textures",
            log_dir=base / "logs",
        ),
        blender=BlenderConfig(executable="blender", timeout=30),
    )

    class _StubSearch:
        def search_models(self, query):
            return {"all_results": []}

        def search_textures(self, query):
            return []

    instance = BlenderMCPServer.__new__(BlenderMCPServer)
    instance.config = cfg
    instance.logger = setup_logging(cfg.paths.log_dir, debug=False)
    instance.search_service = _StubSearch()
    from blender_mcp.server import ModelBuilder

    instance.model_builder = ModelBuilder(cfg)
    return instance


from blender_mcp.grounding import (
    DIMENSION_LIBRARY,
    check_grounding,
    get_dimensions,
    mint_grounding,
    build_verify_script,
    parse_verify_json,
    verify_build_report,
)
from blender_mcp.spec import validate_spec, build_from_spec


def _grounded_spec(objects, product="coffee_mug"):
    return {
        "objects": objects,
        "product": product,
        "grounding": mint_grounding(
            "research_model", query="coffee mug",
            references=[{"name": "Mug", "source": "test", "url": "https://example.com/mug"}]),
    }


MUG_SPEC = _grounded_spec([
    {"name": "MugBody", "kind": "cylinder", "size_m": [0.082, 0.082, 0.088],
     "position_m": [0, 0, 0], "material": "ceramic",
     "dimension_source": "library", "attach": "grounded"},
    {"name": "Handle", "kind": "torus", "size_m": [0.035, 0.05, 0.012],
     "position_m": [0.0525, 0, 0.025], "rotation_deg": [90, 0, 0],
     "material": "ceramic", "dimension_source": "library"},
    {"name": "Coffee", "kind": "cylinder", "size_m": [0.072, 0.072, 0.002],
     # v1.4.0: bottom 0.0865, top 0.0885 — 0.5 mm ABOVE the rim, never
     # exactly coplanar with the body cap (coplanar tops z-fight and the
     # white body cap wins, so the coffee renders grey).
     "position_m": [0, 0, 0.0865], "material": "coffee",
     "dimension_source": "library"},
])


# ---------------------------------------------------------------------------
# Grounding: research-first enforcement
# ---------------------------------------------------------------------------

def test_build_without_research_is_refused(server):
    """(a) The core guardrail: no grounding record, no build."""
    spec = {k: v for k, v in MUG_SPEC.items() if k != "grounding"}
    result = asyncio.run(server._build_from_spec({"spec": spec}))
    assert result["success"] is False
    assert "grounding" in result["error"].lower()
    assert "research_model" in result["error"]
    assert result["errors"], "refusal must name the exact failed check"


def test_build_with_fabricated_grounding_is_refused(server):
    """A made-up grounding_id with no references is not grounding."""
    result = asyncio.run(server._build_from_spec({
        "spec": MUG_SPEC,
        "grounding": {"source": "research_model", "grounding_id": "grd_madeup1234", "query": "coffee mug"},
    }))
    assert result["success"] is False
    assert "grounding" in result["error"].lower()


def test_build_with_valid_grounding_passes_gate(server):
    """Same spec + a grounding record minted by research passes the gate
    (the build itself still needs Blender — this test only proves the
    gate lets it through to the build step, mocked by a bad blender path
    failing at Blender, not at the gate)."""
    grounding = mint_grounding(
        "research_model", query="coffee mug",
        references=[{"name": "Mug", "source": "test", "url": "https://example.com/mug"}])
    assert check_grounding(grounding) == []
    # No blender configured in this stub server: the failure must be a
    # Blender failure, not a grounding refusal.
    result = asyncio.run(server._build_from_spec({"spec": MUG_SPEC, "grounding": grounding}))
    assert "grounding" not in (result.get("error") or "").lower() or "verification" in (result.get("error") or "").lower()


def test_reference_grounding_requires_observed_features():
    assert check_grounding({"source": "reference_image", "reference": "/tmp/mug.png"}) != []
    assert check_grounding({
        "source": "reference_image", "reference": "/tmp/mug.png",
        "observed_features": ["MugBody", "Handle"],
    }) == []


def test_dimension_library_grounding_requires_known_product():
    assert check_grounding({"source": "dimension_library", "product": "teleporter"}) != []
    assert check_grounding({"source": "dimension_library", "product": "coffee_mug"}) == []


def test_research_model_issues_grounding(server):
    result = asyncio.run(server._research_model({"query": "coffee mug"}))
    assert result["success"] is True
    grounding = result.get("grounding")
    assert grounding, "research_model must issue a grounding record"
    assert grounding["source"] == "research_model"
    assert check_grounding(grounding) == []
    assert "grounding" in result["next_step"]


# ---------------------------------------------------------------------------
# Strict spec validation: invented / missing dimensions, floating parts
# ---------------------------------------------------------------------------

def test_spec_rejects_missing_dimension_source():
    spec = {"objects": [{"name": "X", "kind": "cube", "size_m": [0.2, 0.2, 0.2],
                         "position_m": [0, 0, 0], "material": "wood"}]}
    errors = validate_spec(spec)
    assert any("dimension_source" in e for e in errors), errors


def test_spec_rejects_bad_dimension_source():
    spec = {"objects": [{"name": "X", "kind": "cube", "size_m": [0.2, 0.2, 0.2],
                         "position_m": [0, 0, 0], "material": "wood",
                         "dimension_source": "vibes"}]}
    errors = validate_spec(spec)
    assert any("dimension_source" in e for e in errors), errors


def test_spec_rejects_placeholder_unit_dimensions():
    spec = {"objects": [{"name": "X", "kind": "cube", "size_m": [1, 1, 1],
                         "position_m": [0, 0, 0], "material": "wood",
                         "dimension_source": "research"}]}
    errors = validate_spec(spec)
    assert any("placeholder" in e for e in errors), errors


def test_spec_rejects_missing_material():
    spec = {"objects": [{"name": "X", "kind": "cube", "size_m": [0.2, 0.2, 0.2],
                         "position_m": [0, 0, 0], "dimension_source": "measured"}]}
    errors = validate_spec(spec)
    assert any("material" in e for e in errors), errors


def test_spec_rejects_floating_part():
    spec = {"objects": [{"name": "X", "kind": "cube", "size_m": [0.2, 0.2, 0.2],
                         "position_m": [0, 0, 0.5], "material": "wood",
                         "dimension_source": "research"}]}
    errors = validate_spec(spec)
    assert any("FLOATING" in e for e in errors), errors


def test_spec_accepts_part_touching_another_part():
    """A part at z > 0 that touches a grounded part is not floating."""
    spec = {"objects": [
        {"name": "Base", "kind": "cube", "size_m": [0.3, 0.3, 0.1],
         "position_m": [0, 0, 0], "material": "wood", "dimension_source": "measured"},
        {"name": "Top", "kind": "cube", "size_m": [0.2, 0.2, 0.1],
         "position_m": [0, 0, 0.1], "material": "wood", "dimension_source": "measured"},
    ]}
    assert validate_spec(spec) == []


def test_library_claim_must_match_library_numbers():
    spec = _grounded_spec([
        {"name": "MugBody", "kind": "cylinder", "size_m": [0.5, 0.5, 0.5],
         "position_m": [0, 0, 0], "material": "ceramic",
         "dimension_source": "library", "attach": "grounded"},
    ])
    errors = validate_spec(spec)
    assert any("library" in e and "MugBody" in e for e in errors), errors


def test_library_claim_for_unknown_part_is_rejected():
    spec = _grounded_spec([
        {"name": "FluxCapacitor", "kind": "cube", "size_m": [0.1, 0.1, 0.1],
         "position_m": [0, 0, 0], "material": "metal",
         "dimension_source": "library", "attach": "grounded"},
    ])
    errors = validate_spec(spec)
    assert any("library" in e and "FluxCapacitor" in e for e in errors), errors


def test_valid_grounded_spec_passes_validation():
    assert validate_spec(MUG_SPEC) == []
    script, errors = build_from_spec(MUG_SPEC)
    assert errors == [], errors
    assert script is not None
    compile(script, "<mug>", "exec")


# ---------------------------------------------------------------------------
# Dimension library
# ---------------------------------------------------------------------------

def test_dimension_library_covers_required_products():
    for product in ["headphones", "sneaker", "perfume", "watch", "chair",
                    "temple", "rickshaw", "thali", "haveli", "character",
                    "spaceship", "alien", "robot"]:
        key = "smartwatch" if product == "watch" else product
        assert key in DIMENSION_LIBRARY, f"missing library product: {product}"
        assert DIMENSION_LIBRARY[key]["overall_size_m"][2] > 0


def test_get_dimensions_returns_real_numbers():
    mug = get_dimensions("coffee_mug")
    assert mug["success"] is True
    assert mug["overall_size_m"] == [0.111, 0.082, 0.088]
    assert mug["parts"]["MugBody"]["size_m"] == [0.082, 0.082, 0.088]
    assert get_dimensions("teleporter")["success"] is False
    assert "coffee_mug" in get_dimensions()["products"]


def test_library_numbers_match_research_sources():
    # Spot-check against the v1.2.0 report §3 (sourced values).
    assert DIMENSION_LIBRARY["rickshaw"]["overall_size_m"] == [2.658, 1.30, 1.70]
    assert DIMENSION_LIBRARY["thali"]["parts"]["ThaliPlate"]["size_m"] == [0.32, 0.32, 0.022]
    assert DIMENSION_LIBRARY["character"]["overall_size_m"][2] == 1.75
    assert DIMENSION_LIBRARY["alien"]["overall_size_m"][2] == 1.30


# ---------------------------------------------------------------------------
# Post-build verification: a bad build reports failure
# ---------------------------------------------------------------------------

def test_verify_script_compiles():
    compile(build_verify_script(json.dumps(MUG_SPEC)), "<verify>", "exec")


def test_verify_report_without_payload_is_failure():
    report = verify_build_report(MUG_SPEC, None)
    assert report["passed"] is False
    assert report["checks"][0]["check"] == "verification_ran"


def test_verify_report_with_failing_check_is_failure():
    report = verify_build_report(MUG_SPEC, {"checks": [
        {"check": "part_present:MugBody", "passed": True, "detail": "present"},
        {"check": "connected:Handle", "passed": False, "detail": "FLOATING / DISCONNECTED"},
    ]})
    assert report["passed"] is False


def test_verify_report_all_passing_is_success():
    report = verify_build_report(MUG_SPEC, {"checks": [
        {"check": "part_present:MugBody", "passed": True, "detail": "present"},
        {"check": "connected:Handle", "passed": True, "detail": "touches another part"},
    ]})
    assert report["passed"] is True


def test_parse_verify_json():
    stdout = "some blender noise\nVERIFY_JSON:" + json.dumps({"checks": [
        {"check": "part_count", "passed": True, "detail": "3 mesh objects vs 3 spec parts"}]})
    parsed = parse_verify_json(stdout)
    assert parsed["checks"][0]["check"] == "part_count"
    assert parse_verify_json("no json here") is None


# ---------------------------------------------------------------------------
# End to end with real Blender: grounded build verifies; bad build fails
# ---------------------------------------------------------------------------

def _blender_exe():
    import os
    return os.environ.get("BLENDER_EXECUTABLE") or "/home/hatch/workspace/.blender/blender-4.2.0-linux-x64/blender"


def test_grounded_build_verifies_with_real_blender(server, tmp_path):
    blender = _blender_exe()
    if not Path(blender).exists():
        pytest.skip("Blender not found")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300
    built = asyncio.run(server._build_from_spec({"spec": MUG_SPEC}))
    assert built["success"], built.get("error")
    assert built.get("verification", {}).get("passed") is True, built.get("verification")
    assert {o["name"] for o in built["objects"]} == {"MugBody", "Handle", "Coffee"}
    assert built["min_z"] is not None and abs(built["min_z"]) < 0.001
    assert Path(built["output"]).exists()


def test_execute_blender_code_without_grounding_is_flagged_unverified(server, tmp_path):
    blender = _blender_exe()
    if not Path(blender).exists():
        pytest.skip("Blender not found")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300
    code = (
        "import bpy\n"
        "bpy.ops.object.select_all(action='SELECT')\n"
        "bpy.ops.object.delete()\n"
        "bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.05))\n"
        "bpy.context.active_object.name = 'Box'\n"
        "bpy.context.active_object.scale = (0.05, 0.05, 0.05)\n"
    )
    result = asyncio.run(server._execute_blender_code({"code": code}))
    assert result["success"] is True  # escape hatch still runs
    assert "UNVERIFIED" in result.get("grounding_warning", ""), result


def test_execute_blender_code_with_no_meshes_fails(server, tmp_path):
    blender = _blender_exe()
    if not Path(blender).exists():
        pytest.skip("Blender not found")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300
    result = asyncio.run(server._execute_blender_code({
        "code": "import bpy\nbpy.ops.object.select_all(action='SELECT')\nbpy.ops.object.delete()\n"}))
    assert result["success"] is False
    assert "no mesh" in result["error"].lower()


def test_get_dimensions_tool_exists(server):
    result = asyncio.run(server._get_dimensions({"product": "rickshaw"}))
    assert result["success"] is True
    assert result["overall_size_m"] == [2.658, 1.30, 1.70]
    names = [t.name for t in server._list_tools()]
    assert "get_dimensions" in names
    assert "build_from_spec" in names
