"""Bounding-box tests for the built-in templates (P1-7) + v1.2.0 spec/render tests.

Every template script is executed against tests/geometry.py's fake bpy and
its world-space bounding boxes are asserted: nothing below the ground, sane
heights, and the right parts in the right places. The old Y-up bug fails
every one of these tests (tower sideways, pillars underground).

Run with:  python -m pytest
(needs the mcp package: pip install -e ".[test]")
"""

import asyncio
import logging
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest

import geometry
from geometry import execute_script, scene_bounds

from blender_mcp.config import BlenderConfig, PathsConfig, ServerConfig
from blender_mcp.server import BlenderMCPServer
from blender_mcp.utils import setup_logging
from blender_mcp.spec import validate_spec, build_from_spec
from blender_mcp.grounding import mint_grounding
from blender_mcp.materials import MaterialLibrary, get_smart_uv_script, pick_polyhaven_maps


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    """A server instance pointed at temp dirs (never ~/Desktop).

    Built via __new__ on purpose: BlenderMCPServer.__init__ registers
    handlers with the old mcp SDK API (list_tools_handler /
    call_tool_handler), which the current mcp package no longer has, so a
    fresh `pip install mcp` cannot even instantiate the server today.
    That SDK migration is out of scope for this change; the geometry and
    tool tests below only need the generator / tool methods, so they use a
    minimally-wired instance with a stubbed search service.
    """
    base = tmp_path_factory.mktemp("blender-mcp")
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


def by_name(objects):
    return {o.name: o for o in objects}


def assert_on_ground(objects):
    """Every part's lowest point must be at or above the ground (z = 0)."""
    for o in objects:
        lo, _hi = o.world_bounds()
        assert lo.z >= -0.001, f"{o.name} dips below the ground: min z = {lo.z:.3f}"


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

def test_temple_stands_upright(server):
    objects = execute_script(server._generate_temple_script(""))
    assert len(objects) >= 10
    names = by_name(objects)
    assert_on_ground(objects)

    lo, hi = scene_bounds(objects)
    height = hi.z - lo.z
    width = hi.x - lo.x
    assert 6.0 < height < 8.0, f"temple height {height:.2f} m is wrong"
    assert height > width, "temple is wider than it is tall — the tower is sideways"

    # The tower rises in +Z: each tier higher than the last.
    tiers = sorted(
        (o for n, o in names.items() if n.startswith("ShikharaTier")),
        key=lambda o: o.location.z,
    )
    assert len(tiers) == 5
    assert tiers[-1].location.z > tiers[0].location.z + 2.0
    # The finial sits on top of the tower, not 8 m away on the ground.
    assert hi.z > 7.0
    # Pillars stand on the mandapa platform (z = 0.3), not underground.
    mandapa = names["Mandapa"]
    m_lo, _ = mandapa.world_bounds()
    assert abs(m_lo.z - 0.0) < 0.001


def test_rickshaw_is_a_real_bajaj_re(server):
    """Bajaj RE spec: 2.66 long x 1.30 wide x 1.70 high, wheelbase 2.00,
    ground clearance 0.20, 3 wheels (1 front, 2 rear), tyre Ø 0.42."""
    objects = execute_script(server._generate_rickshaw_script(""))
    assert_on_ground(objects)
    wheels = [o for o in objects if o.name == "Wheel"]
    assert len(wheels) == 3, f"expected 3 wheels, got {len(wheels)}"
    for w in wheels:
        lo, hi = w.world_bounds()
        assert abs(lo.z) < 0.001, f"wheel floats or sinks: min z = {lo.z:.3f}"
        assert abs((hi.z - lo.z) - 0.42) < 0.01, f"tyre diameter should be 0.42 m, got {hi.z - lo.z:.3f}"
    lo, hi = scene_bounds(objects)
    length = hi.x - lo.x
    height = hi.z - lo.z
    assert abs(length - 2.66) / 2.66 < 0.10, f"rickshaw length should be 2.66 m ±10%, got {length:.2f}"
    assert abs(height - 1.70) / 1.70 < 0.10, f"rickshaw height should be 1.70 m ±10%, got {height:.2f}"
    # Wheelbase: front wheel well forward of the rear axle.
    front = [w for w in wheels if w.location.x > 0][0]
    rear = [w for w in wheels if w.location.x < 0]
    assert abs((front.location.x - rear[0].location.x) - 2.00) < 0.01, "wheelbase should be 2.00 m"
    # Low canopy peaking at 1.70 — it must not swallow the body.
    canopy = by_name(objects)["Canopy"]
    c_lo, c_hi = canopy.world_bounds()
    assert abs(c_hi.z - 1.70) < 0.01, f"canopy must peak at 1.70 m, got {c_hi.z:.2f}"
    assert c_hi.z - c_lo.z < 0.2, "canopy must be a thin curved sheet, not a dome"
    # Floor at ground-clearance height.
    floor = by_name(objects)["FloorPan"]
    f_lo, _ = floor.world_bounds()
    assert abs(f_lo.z - 0.20) < 0.01, f"floor bottom should be at z = 0.20, got {f_lo.z:.2f}"


def test_thali_is_a_small_steel_plate(server):
    objects = execute_script(server._generate_thali_script(""))
    assert len(objects) == 11  # plate + rice + 4 katoris + 4 contents + roti
    assert_on_ground(objects)
    lo, hi = scene_bounds(objects)
    assert hi.z - lo.z < 0.25, "thali should be flat, under 0.25 m tall"
    plate = by_name(objects)["ThaliPlate"]
    p_lo, p_hi = plate.world_bounds()
    assert abs((p_hi.x - p_lo.x) - 0.32) / 0.32 < 0.10, f"plate should be Ø 0.32 m ±10%, got {p_hi.x - p_lo.x:.3f}"
    assert abs(p_hi.z - 0.022) < 0.002, f"plate top should be at z = 0.022, got {p_hi.z:.3f}"
    # Four katoris with distinct contents, in a ring around the rice.
    for food in ["Dal", "Sabzi", "Curd", "Kheer"]:
        assert f"Katori_{food}" in by_name(objects), f"missing katori {food}"
        assert food in by_name(objects), f"missing contents {food}"
    rice = by_name(objects)["RiceMound"]
    r_lo, r_hi = rice.world_bounds()
    assert abs((r_hi.x - r_lo.x) - 0.13) < 0.01, "rice mound should be Ø 0.13 m"
    assert abs(r_hi.z - 0.072) < 0.005, "rice dome top should be at z ≈ 0.072"


def test_haveli_has_a_real_courtyard(server):
    objects = execute_script(server._generate_building_script(""))
    assert_on_ground(objects)
    names = by_name(objects)
    assert not any(n.startswith("Shikhara") for n in names), "haveli must not have a temple spire"
    # Plinth footprint 12 x 10.
    plinth = names["Plinth"]
    pl_lo, pl_hi = plinth.world_bounds()
    assert abs((pl_hi.x - pl_lo.x) - 12.0) < 0.01, "plinth should be 12 m long"
    assert abs((pl_hi.y - pl_lo.y) - 10.0) < 0.01, "plinth should be 10 m deep"
    # Two floors, 3.2 m each: ground 0.5-3.7, first 3.7-6.9.
    gf = names["GroundFloor_Front"]
    ff = names["FirstFloor_Front"]
    _, gf_hi = gf.world_bounds()
    ff_lo, ff_hi = ff.world_bounds()
    assert abs(gf_hi.z - 3.7) < 0.01, "ground floor should top out at z = 3.7"
    assert abs(ff_lo.z - 3.7) < 0.01, "first floor should start at z = 3.7"
    assert abs(ff_hi.z - 6.9) < 0.01, "first floor should top out at z = 6.9"
    # Parapet top at 7.9; total height 7.9-9.4 (chhatri finials ~9.03).
    lo, hi = scene_bounds(objects)
    assert 7.9 < hi.z < 9.4, f"haveli height {hi.z:.2f} m is wrong"
    # Courtyard void: nothing but the paving slab may occupy the centre
    # column (x=0, y=0) above the plinth.
    blocking = [
        o for o in objects
        if o.name != "CourtyardPaving"
        and (lambda b: b[0].x < 0 < b[1].x and b[0].y < 0 < b[1].y and b[1].z > 0.6)(o.world_bounds())
    ]
    assert blocking == [], f"courtyard is blocked by: {[o.name for o in blocking]}"
    # Jharokhas project from the front face (y = -5) by ~1 m.
    jharokha = names["JharokhaSlab_3.0"]
    j_lo, j_hi = jharokha.world_bounds()
    assert j_lo.y < -5.9, f"jharokha should project to about y = -6, got min y = {j_lo.y:.2f}"


def test_character_stands_upright(server):
    objects = execute_script(server._generate_character_script(""))
    assert_on_ground(objects)
    names = by_name(objects)
    head = names["Head"]
    torso = names["Torso"]
    dhoti = names["Dhoti"]
    # Head above torso above dhoti, feet on the ground.
    assert head.location.z > torso.location.z > dhoti.location.z
    h_lo, h_hi = head.world_bounds()
    assert h_hi.z > 1.5, f"head top must be clearly visible above z = 1.5, got {h_hi.z:.2f}"
    lo, hi = scene_bounds(objects)
    assert abs((hi.z - lo.z) - 1.75) / 1.75 < 0.10, f"figure should be 1.75 m ±10%, got {hi.z - lo.z:.2f}"
    # No big white box: torso narrower than the shoulders.
    shoulders = names["Shoulders"]
    t_lo, t_hi = torso.world_bounds()
    s_lo, s_hi = shoulders.world_bounds()
    assert (t_hi.x - t_lo.x) < (s_hi.x - s_lo.x), "torso must be narrower than the shoulders"
    # Fingertips reach mid-thigh (z = 0.65).
    hands = [o for o in objects if o.name == "Hand"]
    assert len(hands) == 2
    for hand in hands:
        hand_lo, _ = hand.world_bounds()
        assert abs(hand_lo.z - 0.65) < 0.01, f"fingertips should reach z = 0.65, got {hand_lo.z:.2f}"
    # Feet/sandals on the ground, dhoti hem just above the ankle.
    feet = [o for o in objects if o.name == "Foot"]
    assert len(feet) == 2
    for foot in feet:
        f_lo, _ = foot.world_bounds()
        assert abs(f_lo.z) < 0.001, "feet must stand on the ground"
    d_lo, _ = dhoti.world_bounds()
    assert abs(d_lo.z - 0.02) < 0.001, f"dhoti hem should be at z = 0.02, got {d_lo.z:.2f}"


# ---------------------------------------------------------------------------
# No temple default + free-form code tool
# ---------------------------------------------------------------------------

def test_no_template_match_returns_none(server):
    assert server._generate_model_script("wooden chair", "") is None
    assert server._generate_model_script("red sports car", "") is None
    assert server._generate_model_script("a cat sitting", "") is None
    # ...while real templates still match.
    assert "ShikharaTier" in server._generate_model_script("indian temple", "")
    assert "Wheel" in server._generate_model_script("auto rickshaw", "")


def test_execute_blender_code_tool_exists(server):
    names = [t.name for t in server._list_tools()]
    assert "execute_blender_code" in names
    assert "create_complex_model" in names
    assert "research_model" in names
    assert "build_from_spec" in names
    assert "render_model" in names


def test_execute_blender_code_rejects_empty(server):
    import asyncio

    result = asyncio.run(server._execute_blender_code({"code": "  "}))
    assert result["success"] is False


def test_create_model_reports_no_template(server):
    import asyncio

    result = asyncio.run(server._create_model({"description": "wooden chair"}))
    assert result["success"] is False
    assert "execute_blender_code" in result["error"]
    assert "temple" not in result.get("output", "")


# ---------------------------------------------------------------------------
# Import script
# ---------------------------------------------------------------------------

def test_import_script_uses_correct_operators():
    glb = BlenderMCPServer._build_import_script("/tmp/m.glb", "bpy.ops.import_scene.gltf", "/tmp/o.blend", 1.0)
    assert "bpy.ops.import_scene.gltf" in glb
    stl = BlenderMCPServer._build_import_script("/tmp/m.stl", "bpy.ops.import_mesh.stl", "/tmp/o.blend", 1.0)
    assert "bpy.ops.import_mesh.stl" in stl
    assert "import_scene.stl" not in stl


def test_import_script_normalises_to_1m_on_the_ground():
    # The fake import creates a 4 x 2 x 0.5 m box floating at z = 3.
    script = BlenderMCPServer._build_import_script("/tmp/m.glb", "bpy.ops.import_scene.gltf", "/tmp/o.blend", 1.0)
    objects = execute_script(script)
    assert len(objects) == 1
    lo, hi = scene_bounds(objects)
    longest = max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
    assert abs(longest - 1.0) < 0.01, f"longest side should be 1.0 m, got {longest:.3f}"
    assert abs(lo.z) < 0.001, f"model must stand on the ground, min z = {lo.z:.3f}"


# ---------------------------------------------------------------------------
# Logging goes to stderr, never stdout
# ---------------------------------------------------------------------------

def test_logger_never_writes_to_stdout(tmp_path):
    logger = setup_logging(tmp_path, debug=False)
    stream_handlers = [
        h for h in logger.handlers
        if isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler)
    ]
    assert stream_handlers, "expected a console handler"
    for h in stream_handlers:
        assert h.stream is sys.stderr, "console logs must go to stderr (stdout is the MCP stream)"


# ---------------------------------------------------------------------------
# All generated scripts are valid Python
# ---------------------------------------------------------------------------

def test_all_templates_compile(server):
    for name in ["temple", "rickshaw", "thali", "building", "character"]:
        script = server._generate_model_script(name, "")
        assert script, f"no script for {name}"
        compile(script, f"<{name}>", "exec")
    import_script = BlenderMCPServer._build_import_script("/tmp/m.glb", "bpy.ops.import_scene.gltf", "/tmp/o.blend", 1.0)
    compile(import_script, "<import>", "exec")


# ---------------------------------------------------------------------------
# Scene spec validation (v1.2.0)
# ---------------------------------------------------------------------------

VALID_TABLE_SPEC = {
    "objects": [
        {"name": "Table", "kind": "cube", "size_m": [1.2, 0.8, 0.05],
         "position_m": [0, 0, 0.7], "material": "wood", "dimension_source": "measured"},
        {"name": "Leg", "kind": "cylinder", "size_m": [0.08, 0.08, 0.7],
         "position_m": [0, 0, 0], "attach": "grounded", "material": "steel",
         "dimension_source": "measured"},
        {"name": "Top", "kind": "cube", "size_m": [1.2, 0.8, 0.05],
         "position_m": [0, 0, 0.75], "attach": "on_top_of:Table", "material": "wood",
         "dimension_source": "measured"},
    ],
    # v1.3.1: every build needs grounding — minted here, as research_model
    # would mint it in production.
    "grounding": mint_grounding(
        "research_model", query="wooden table",
        references=[{"name": "Wooden table", "source": "test", "url": "https://example.com/table"}]),
}


def test_spec_accepts_valid_with_mates():
    assert validate_spec(VALID_TABLE_SPEC) == []


def test_spec_rejects_negative_z():
    spec = {"objects": [{"name": "X", "kind": "cube", "size_m": [1, 1, 1],
                         "position_m": [0, 0, -0.5]}]}
    errors = validate_spec(spec)
    assert errors, "negative z must fail validation"
    assert any("position_m.z" in e and "X" in e for e in errors), errors


def test_spec_rejects_zero_size():
    spec = {"objects": [{"name": "X", "kind": "cube", "size_m": [0, 1, 1],
                         "position_m": [0, 0, 0]}]}
    errors = validate_spec(spec)
    assert any("size_m.x" in e for e in errors), errors
    spec["objects"][0]["size_m"] = [1, 1, 0]
    errors = validate_spec(spec)
    assert any("size_m.z" in e for e in errors), errors


def test_spec_rejects_out_of_bounds():
    spec = {"objects": [{"name": "X", "kind": "cube", "size_m": [1, 1, 1],
                         "position_m": [6, 0, 0]}]}
    errors = validate_spec(spec)
    assert any("outside work area" in e for e in errors), errors
    spec["objects"][0]["position_m"] = [0, 0, 9.5]
    errors = validate_spec(spec)
    assert any("outside work area" in e for e in errors), errors


def test_spec_rejects_non_touching_attach():
    spec = {"objects": [
        {"name": "A", "kind": "cube", "size_m": [1, 1, 1], "position_m": [0, 0, 0]},
        {"name": "B", "kind": "cube", "size_m": [1, 1, 1], "position_m": [0, 0, 5],
         "attach": "on_top_of:A"},
    ]}
    errors = validate_spec(spec)
    assert any("does not touch" in e and "B" in e for e in errors), errors


def test_spec_rejects_unknown_attach_parent():
    spec = {"objects": [
        {"name": "B", "kind": "cube", "size_m": [1, 1, 1], "position_m": [0, 0, 1],
         "attach": "on_top_of:Missing"},
    ]}
    errors = validate_spec(spec)
    assert any("unknown object" in e for e in errors), errors


def test_spec_rejects_bad_kind():
    spec = {"objects": [{"name": "X", "kind": "torus_knot", "size_m": [1, 1, 1],
                         "position_m": [0, 0, 0]}]}
    errors = validate_spec(spec)
    assert any("kind" in e for e in errors), errors


def test_build_from_spec_solves_mates_from_bboxes():
    script, errors = build_from_spec(VALID_TABLE_SPEC)
    assert errors == [], errors
    assert script is not None
    compile(script, "<spec>", "exec")
    objects = execute_script(script)
    names = by_name(objects)
    # on_top_of: the Top sits exactly on the Table (0.75), never guessed.
    top_lo, top_hi = names["Top"].world_bounds()
    assert abs(top_lo.z - 0.75) < 0.001, f"Top should sit on the Table at z = 0.75, got {top_lo.z:.3f}"
    leg_lo, _ = names["Leg"].world_bounds()
    assert abs(leg_lo.z) < 0.001, "grounded Leg must stand on the ground"
    lo, hi = scene_bounds(objects)
    assert abs(lo.z) < 0.001
    assert abs(hi.z - 0.8) < 0.001


def test_build_from_spec_flat_caps_stay_flat_shaded():
    # v1.4.0: smooth-shading a flat cylinder/cone cap interpolates normals
    # across the n-gon fan and renders triangular streaks — the v1.3.1
    # coffee disc read as faceted grey instead of a flat coffee surface.
    # Caps (|normal.z| ~ 1) stay flat; curved sides stay smooth.
    script, errors = build_from_spec(VALID_TABLE_SPEC)
    assert errors == [], errors
    assert "abs(_p.normal.z) < 0.999" in script
    assert "for _p in _obj.data.polygons: _p.use_smooth = True" not in script


def test_build_from_spec_returns_errors_not_script():
    spec = {"objects": [{"name": "X", "kind": "cube", "size_m": [1, 1, 1],
                         "position_m": [0, 0, -1]}]}
    script, errors = build_from_spec(spec)
    assert script is None
    assert errors, "invalid spec must report the failed checks"


def test_build_from_spec_tool_rejects_invalid(server):
    result = asyncio.run(server._build_from_spec({"spec": {"objects": [
        {"name": "X", "kind": "cube", "size_m": [1, 1, 1], "position_m": [0, 0, -1]},
    ]}}))
    assert result["success"] is False
    assert result["errors"], "tool must return the exact failed checks"


def test_research_model_returns_schema(server):
    result = asyncio.run(server._research_model({"query": "wooden chair"}))
    assert result["success"] is True
    assert isinstance(result["references"], list)
    assert "part_breakdown_schema" in result
    assert "build_from_spec" in result["next_step"]


# ---------------------------------------------------------------------------
# Materials v2 + Smart UV + Poly Haven
# ---------------------------------------------------------------------------

def test_material_scripts_are_node_trees():
    for name in ["wood", "marble", "metal", "fabric", "steel", "glass", "skin", "sandstone"]:
        script = MaterialLibrary.get_material_script(name)
        assert "ShaderNode" in script, f"{name} should build a node tree"
        assert "Principled BSDF" in script
    assert "ShaderNodeTexNoise" in MaterialLibrary.get_material_script("wood")
    assert "ShaderNodeTexVoronoi" in MaterialLibrary.get_material_script("marble")
    assert "Subsurface Weight" in MaterialLibrary.get_material_script("skin")
    assert "Sheen Weight" in MaterialLibrary.get_material_script("fabric")
    assert "Transmission Weight" in MaterialLibrary.get_material_script("glass")
    assert "Metallic" in MaterialLibrary.get_material_script("metal")
    # Unknown names fall back to a flat colour (no node tree).
    fallback = MaterialLibrary.get_material_script("not_a_material")
    assert "ShaderNodeTexNoise" not in fallback
    assert "Base Color" in fallback


def test_smart_uv_script_runs_before_texturing():
    setup = '''
import bpy, math
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.5))
mat = bpy.data.materials.new(name="M")
mat.use_nodes = True
targets = [o for o in bpy.data.objects if o.type == "MESH"]
'''
    execute_script(setup + get_smart_uv_script())
    assert geometry.LAST_CONTEXT is not None
    # 66 degrees in radians, island margin 0.02 — and back to OBJECT mode.
    assert geometry.LAST_CONTEXT.smart_uv_calls == [(math.radians(66), 0.02)]
    assert geometry.LAST_CONTEXT.mode == "OBJECT"


def test_polyhaven_map_picking():
    files = {
        "Diffuse": {"1k": {"jpg": {"url": "https://x/diff_1k.jpg"}}},
        "Rough": {"1k": {"jpg": {"url": "https://x/rough_1k.jpg"}}},
        "nor_gl": {"1k": {"jpg": {"url": "https://x/nor_1k.jpg"}}},
        "AO": {"1k": {"jpg": {"url": "https://x/ao_1k.jpg"}}},
    }
    maps = pick_polyhaven_maps(files)
    assert maps["color"] == "https://x/diff_1k.jpg"
    assert maps["roughness"] == "https://x/rough_1k.jpg"
    assert maps["normal"] == "https://x/nor_1k.jpg"
    assert maps["ao"] == "https://x/ao_1k.jpg"
    # ARM fallback when no Rough map exists.
    files2 = {
        "Diffuse": {"1k": {"jpg": {"url": "https://x/diff_1k.jpg"}}},
        "arm": {"1k": {"jpg": {"url": "https://x/arm_1k.jpg"}}},
    }
    assert pick_polyhaven_maps(files2)["roughness_from_arm"] == "https://x/arm_1k.jpg"
    with pytest.raises(ValueError):
        pick_polyhaven_maps({})


def test_polyhaven_missing_slug_fails_cleanly(server):
    # A slug that does not exist (404) — or no network at all — must fail
    # with a clear Poly Haven error, never a silent fallback.
    result = asyncio.run(server._apply_texture(
        {"texture_type": "polyhaven:does_not_exist_xyz", "object_name": ""}))
    assert result["success"] is False
    assert "Poly Haven" in result["error"]


def test_apply_texture_blend_path(server, tmp_path, monkeypatch):
    # apply_texture takes an optional blend_path: without it the material
    # is created in an empty scene and applied to nothing, so the script
    # must open the model first when one is given, and a missing file
    # must fail cleanly instead of rendering an empty scene.
    result = asyncio.run(server._apply_texture(
        {"texture_type": "wood", "blend_path": str(tmp_path / "nope.blend")}))
    assert result["success"] is False
    assert "not found" in result["error"]

    captured = {}

    def fake_create_mesh(script):
        captured["script"] = script
        return {"success": True, "output": str(tmp_path / "textured.blend")}

    # monkeypatch restores the real create_mesh after this test: the server
    # fixture is module-scoped, and a bare assignment here used to leak the
    # fake into every later test — the real-Blender add_detail test then
    # got success:true for a .blend that was never written.
    monkeypatch.setattr(server.model_builder, "create_mesh", fake_create_mesh)
    blend = tmp_path / "model.blend"
    blend.write_bytes(b"fake")
    result = asyncio.run(server._apply_texture(
        {"texture_type": "wood", "blend_path": str(blend)}))
    assert result["success"] is True
    assert f'open_mainfile(filepath="{blend}")' in captured["script"]


# ---------------------------------------------------------------------------
# Render verification (real Blender)
# ---------------------------------------------------------------------------

def _blender_exe():
    return os.environ.get("BLENDER_EXECUTABLE") or shutil.which("blender")


def test_render_model_missing_blend_fails(server, tmp_path):
    result = server.model_builder.render_model(
        str(tmp_path / "nope.blend"), str(tmp_path / "x"), ["front"])
    assert result["success"] is False
    assert "not found" in result["error"]


def test_build_from_spec_and_render_with_real_blender(server, tmp_path):
    blender = _blender_exe()
    if not blender:
        pytest.skip("Blender not found: set BLENDER_EXECUTABLE")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300

    # build_from_spec end to end: valid spec -> .blend + bounds + min z.
    built = asyncio.run(server._build_from_spec({"spec": VALID_TABLE_SPEC}))
    assert built["success"], built.get("error")
    assert built["min_z"] is not None and abs(built["min_z"]) < 0.001
    assert {o["name"] for o in built["objects"]} == {"Table", "Leg", "Top"}
    blend = built["output"]
    assert Path(blend).exists()

    # render_model: PNGs must exist on disk and be non-empty.
    out = tmp_path / "table_render"
    rendered = server.model_builder.render_model(blend, str(out), ["front", "side", "perspective"])
    assert rendered["success"], rendered.get("error")
    assert len(rendered["renders"]) == 3
    for r in rendered["renders"]:
        p = Path(r["path"])
        assert p.exists(), f"render PNG missing: {p}"
        assert p.stat().st_size > 0, f"render PNG empty: {p}"
        assert r["size_bytes"] > 0

    # Unknown view is a clean failure, not a crash.
    bad = server.model_builder.render_model(blend, str(tmp_path / "bad"), ["diagonal"])
    assert bad["success"] is False


# ---------------------------------------------------------------------------
# v1.3.0 — generate_3d (Meshy first, Tripo second)
# ---------------------------------------------------------------------------

import json  # noqa: E402  (test file has no top-level json import)

from blender_mcp.generate import (
    build_meshy_text_request,
    build_meshy_refine_request,
    build_meshy_image_request,
    build_tripo_text_request,
    build_tripo_image_request,
    is_meshy_terminal,
    is_tripo_terminal,
    extract_meshy_glb,
    extract_tripo_glb,
    run_generate_3d,
)
from blender_mcp.details import get_detail_script, DETAIL_KINDS
from blender_mcp.critique import (
    build_critique_script,
    parse_critique_json,
    build_critique_prompt,
    png_decodes,
    MAX_REFINE_ROUNDS,
)
from blender_mcp.render import build_render_script as py_build_render_script


def test_meshy_text_request_shape():
    req = build_meshy_text_request("a red leather armchair", {})
    assert req["mode"] == "preview"
    assert req["prompt"] == "a red leather armchair"
    assert req["target_formats"] == ["glb"]
    assert req["auto_size"] is True
    assert req["origin_at"] == "bottom"
    assert req["target_polycount"] == 30000
    with pytest.raises(ValueError):
        build_meshy_text_request("x" * 801, {})
    refine = build_meshy_refine_request("preview-1", {})
    assert refine["mode"] == "refine"
    assert refine["preview_task_id"] == "preview-1"
    assert refine["enable_pbr"] is True


def test_meshy_image_request_accepts_url_and_base64():
    req = build_meshy_image_request({"image_url": "https://example.com/chair.jpg"})
    assert req["image_url"] == "https://example.com/chair.jpg"
    assert req["should_texture"] is True
    req2 = build_meshy_image_request({"image_base64": "iVBORw0KGgo="})
    assert req2["image_url"].startswith("data:image/png;base64,iVBORw0KGgo=")
    with pytest.raises(ValueError):
        build_meshy_image_request({})


def test_tripo_request_shape():
    req = build_tripo_text_request("a brass desk lamp", {})
    assert req["model"] == "v3.1-20260211"
    assert req["texture"] is True and req["pbr"] is True and req["auto_size"] is True
    with pytest.raises(ValueError):
        build_tripo_text_request("x" * 1025, {})
    img = build_tripo_image_request({"image_url": "https://example.com/lamp.jpg"})
    assert img["input"] == "https://example.com/lamp.jpg"
    with pytest.raises(ValueError):
        build_tripo_image_request({})


def test_terminal_states_and_glb_extraction():
    # Meshy: a rescheduled task can go back to PENDING — not terminal, not an error.
    assert is_meshy_terminal("SUCCEEDED") and is_meshy_terminal("FAILED") and is_meshy_terminal("CANCELED")
    assert not is_meshy_terminal("PENDING") and not is_meshy_terminal("IN_PROGRESS")
    assert is_tripo_terminal("success") and is_tripo_terminal("failed") and is_tripo_terminal("banned")
    assert not is_tripo_terminal("queued") and not is_tripo_terminal("running")
    assert extract_meshy_glb({"model_urls": {"glb": "https://x/m.glb", "obj": "https://x/m.obj"}}) == "https://x/m.glb"
    assert extract_meshy_glb({"model_urls": {}}) is None
    assert extract_tripo_glb({"output": {"model_url": "https://x/m.glb"}}) == "https://x/m.glb"
    assert extract_tripo_glb({}) is None


def test_generate_3d_no_key_is_honest(monkeypatch, tmp_path):
    # No MESHY_API_KEY / TRIPO_API_KEY anywhere: the tool must say so
    # honestly and point at the free local path — never fail silently.
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    monkeypatch.delenv("TRIPO_API_KEY", raising=False)
    for provider in ("meshy", "tripo"):
        result = run_generate_3d(
            {"provider": provider, "mode": "text", "prompt": "a red chair"},
            tmp_path, "no_key_test",
        )
        assert result["success"] is False
        assert result["generation_available"] is False
        assert f"{provider.upper()}_API_KEY" in result["error"]
        assert "research_model" in result["error"]
        assert not (tmp_path / "no_key_test.glb").exists(), "no key must mean no download attempt"


def test_generate_3d_meshy_mocked_preview_refine(tmp_path):
    """Mocked HTTP layer: text -> preview -> refine -> GLB download."""
    calls = []

    def fake_http(method, url, api_key, body):
        calls.append((method, url))
        assert api_key == "msy_test_key"
        if method == "POST" and url.endswith("/v2/text-to-3d") and body["mode"] == "preview":
            assert body["target_formats"] == ["glb"] and body["origin_at"] == "bottom"
            return 200, {"result": "preview-1"}
        if method == "POST" and url.endswith("/v2/text-to-3d") and body["mode"] == "refine":
            assert body["preview_task_id"] == "preview-1"
            return 200, {"result": "refine-1"}
        if method == "GET" and url.endswith("/v2/text-to-3d/preview-1"):
            return 200, {"status": "SUCCEEDED", "model_urls": {"glb": "https://cdn.meshy.ai/preview.glb"}}
        if method == "GET" and url.endswith("/v2/text-to-3d/refine-1"):
            return 200, {"status": "SUCCEEDED", "model_urls": {"glb": "https://cdn.meshy.ai/refined.glb"}}
        raise AssertionError(f"unexpected call {method} {url}")

    downloaded = {}

    def fake_download(url, dest):
        downloaded[url] = dest
        Path(dest).write_bytes(b"fake-glb-bytes")
        return dest

    result = run_generate_3d(
        {"provider": "meshy", "mode": "text", "prompt": "a red chair",
         "poll_interval_seconds": 0, "timeout_seconds": 60},
        tmp_path, "meshy_mock", http=fake_http, download=fake_download, api_key="msy_test_key",
    )
    assert result["success"] is True, result
    assert result["preview_task_id"] == "preview-1"
    assert result["task_id"] == "refine-1"
    assert "30 credits" in result["credits_note"]
    assert Path(result["glb_path"]).read_bytes() == b"fake-glb-bytes"
    assert "https://cdn.meshy.ai/refined.glb" in downloaded
    # Preview GLB must NOT be downloaded when texture=True (only the refined one).
    assert "https://cdn.meshy.ai/preview.glb" not in downloaded


def test_generate_3d_meshy_texture_false_stops_after_preview(tmp_path):
    def fake_http(method, url, api_key, body):
        if method == "POST":
            return 200, {"result": "preview-1"}
        return 200, {"status": "SUCCEEDED", "model_urls": {"glb": "https://cdn.meshy.ai/preview.glb"}}

    result = run_generate_3d(
        {"provider": "meshy", "mode": "text", "prompt": "a chair", "texture": False,
         "poll_interval_seconds": 0},
        tmp_path, "meshy_draft", http=fake_http,
        download=lambda url, dest: (Path(dest).write_bytes(b"draft"), dest)[1],
        api_key="msy_test_key",
    )
    assert result["success"] is True
    assert result["task_id"] == "preview-1"
    assert "mesh-only" in result["credits_note"]


def test_generate_3d_tripo_mocked_download_inside_poll(tmp_path):
    """Tripo GLB URL expires in 5 min — it must be downloaded inside the
    poll loop, i.e. by the time run_generate_3d returns the file is local."""
    polls = {"n": 0}

    def fake_http(method, url, api_key, body):
        if method == "POST":
            assert body["model"] == "v3.1-20260211"
            return 200, {"task_id": "tripo-1"}
        polls["n"] += 1
        if polls["n"] == 1:
            return 200, {"status": "queued", "progress": 10}
        return 200, {"status": "success", "output": {"model_url": "https://cdn.tripo.ai/m.glb"}}

    result = run_generate_3d(
        {"provider": "tripo", "mode": "text", "prompt": "a brass lamp",
         "poll_interval_seconds": 0},
        tmp_path, "tripo_mock", http=fake_http,
        download=lambda url, dest: (Path(dest).write_bytes(b"tripo-glb"), dest)[1],
        api_key="tripo_test_key",
    )
    assert result["success"] is True, result
    assert result["task_id"] == "tripo-1"
    assert polls["n"] == 2
    assert Path(result["glb_path"]).read_bytes() == b"tripo-glb"


def test_generate_3d_meshy_failed_task_reports_error(tmp_path):
    def fake_http(method, url, api_key, body):
        if method == "POST":
            return 200, {"result": "preview-9"}
        return 200, {"status": "FAILED", "task_error": {"message": "content moderated"}}

    result = run_generate_3d(
        {"provider": "meshy", "mode": "text", "prompt": "x", "poll_interval_seconds": 0},
        tmp_path, "meshy_fail", http=fake_http, api_key="msy_test_key",
    )
    assert result["success"] is False
    assert "FAILED" in result["error"]
    assert "refunded" in result["error"]


def test_generate_3d_tool_exists_and_no_key(server):
    names = [t.name for t in server._list_tools()]
    for tool in ("generate_3d", "add_detail", "critique_model"):
        assert tool in names
    result = asyncio.run(server._generate_3d({"prompt": "a red chair"}))
    assert result["success"] is False
    assert result["generation_available"] is False
    assert "MESHY_API_KEY" in result["error"]


# ---------------------------------------------------------------------------
# v1.3.0 — detail helpers
# ---------------------------------------------------------------------------

def test_detail_kinds_documented():
    assert set(DETAIL_KINDS) == {"bevel", "subdivision", "panel_line", "screw", "bolt", "seam", "grille", "label",
                                 "condensation", "emissive_ring", "glow_strip"}
    for d in DETAIL_KINDS:
        script = get_detail_script(d, "Table", {})
        compile(script, f"<detail:{d}>", "exec")


def test_detail_validation():
    with pytest.raises(ValueError, match="Unknown detail"):
        get_detail_script("engrave", "Table", {})
    with pytest.raises(ValueError, match="target"):
        get_detail_script("bevel", "", {})
    with pytest.raises(ValueError, match="width_m"):
        get_detail_script("bevel", "Table", {"width_m": 0})
    with pytest.raises(ValueError, match="face"):
        get_detail_script("screw", "Table", {"face": "diagonal"})
    with pytest.raises(ValueError, match="axis"):
        get_detail_script("seam", "Table", {"axis": "w"})


def test_detail_scripts_run_on_fake_bpy():
    # Every helper except label (needs Font curves) runs against the fake
    # bpy and creates the expected geometry on the target.
    base = '''
import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.5))
bpy.context.active_object.name = "Table"
bpy.context.active_object.scale = (0.6, 0.4, 0.025)
'''
    for detail in ["bevel", "subdivision", "panel_line", "screw", "bolt", "seam", "grille"]:
        objects = execute_script(base + get_detail_script(detail, "Table", {}))
        assert any("Table" in o.name for o in objects), f"{detail} left no objects"
    # Modifiers really attached (fake bpy records them).
    execute_script(base + get_detail_script("bevel", "Table", {"width_m": 0.002, "segments": 3}))
    table = [o for o in geometry.LAST_CONTEXT._objects if o.name == "Table"][0]
    assert any(m.type == "BEVEL" for m in table.modifiers._mods)
    execute_script(base + get_detail_script("subdivision", "Table", {"levels": 2}))
    table = [o for o in geometry.LAST_CONTEXT._objects if o.name == "Table"][0]
    assert any(m.type == "SUBSURF" for m in table.modifiers._mods)
    # panel_line / screw / grille add new objects on the target.
    objects = execute_script(base + get_detail_script("panel_line", "Table", {"face": "front"}))
    assert any("PanelLine" in o.name for o in objects)
    objects = execute_script(base + get_detail_script("grille", "Table", {"face": "front", "rows": 3}))
    assert sum(1 for o in objects if "GrilleSlat" in o.name) == 3
    # Unknown target fails loudly in Blender, not silently.
    with pytest.raises(RuntimeError, match="no mesh object matching"):
        execute_script(base + get_detail_script("bevel", "Missing", {}))


def test_label_script_has_text_object():
    script = get_detail_script("label", "Table", {"face": "front", "text": "NOIR"})
    compile(script, "<label>", "exec")
    assert "ShaderNode" not in script  # label builds geometry, not a node tree
    assert "type='FONT'" in script and "NOIR" in script


# ---------------------------------------------------------------------------
# v1.3.0 — critique loop (programmatic checks + prompt template)
# ---------------------------------------------------------------------------

def _make_png(path):
    """Write a minimal valid 1x1 RGB PNG (stdlib only)."""
    import struct
    import zlib

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    raw = b"\x00\xff\x00\x00"
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def test_critique_script_compiles_and_parses():
    spec = {"objects": [{"name": "Table", "size_m": [1.2, 0.8, 0.05]}]}
    script = build_critique_script(json.dumps(spec))
    compile(script, "<critique>", "exec")
    assert "CRITIQUE_JSON:" in script
    assert "connected:" in script and "min_z:" in script and "dimensions:" in script
    parsed = parse_critique_json("noise\nCRITIQUE_JSON:" + json.dumps({"checks": [
        {"check": "min_z:Table", "passed": True, "detail": "min z = 0.0000 m"},
        {"check": "connected:Table", "passed": False, "detail": "FLOATING"},
    ]}) + "\nmore noise")
    assert parsed is not None and len(parsed["checks"]) == 2
    assert parse_critique_json("no json here") is None


def test_critique_prompt_is_structured():
    spec = {"objects": [{"name": "Table", "size_m": [1.2, 0.8, 0.05]}]}
    checks = [{"check": "min_z:Table", "passed": True, "detail": "min z = 0.0000 m"}]
    prompt = build_critique_prompt(spec, checks)
    assert "Table" in prompt
    assert "PER-SPEC-ITEM PASS/FAIL" in prompt
    assert "PROBLEM -> FIX PAIRS" in prompt
    assert "DUAL GATE" in prompt
    assert "Content Match" in prompt and "Geometric Quality" in prompt
    assert "max 3 auto-refine rounds" in prompt
    assert "LOCALISED EDITS" in prompt
    assert "cannot see" in prompt
    assert MAX_REFINE_ROUNDS == 3


def test_png_decodes(tmp_path):
    good = tmp_path / "good.png"
    _make_png(good)
    assert png_decodes(str(good)) is True
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"not a png at all")
    assert png_decodes(str(bad)) is False
    truncated = tmp_path / "trunc.png"
    truncated.write_bytes(Path(good).read_bytes()[:20])
    assert png_decodes(str(truncated)) is False
    assert png_decodes(str(tmp_path / "missing.png")) is False


def test_research_model_recommends_real_asset(server):
    result = asyncio.run(server._research_model({"query": "wooden chair"}))
    assert result["success"] is True
    assert "recommended_path" in result
    assert result["recommended_path"]["kind"] in ("import_asset", "model_from_primitives")


def test_research_model_reference_image_route_b(monkeypatch, server):
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    monkeypatch.delenv("TRIPO_API_KEY", raising=False)
    result = asyncio.run(server._research_model({
        "query": "headphones",
        "reference_image": "https://example.com/headphones.jpg",
    }))
    ref = result["reference_image"]
    assert ref["kind"] == "url"
    assert ref["route"].startswith("B (reference-as-spec)")
    assert "generate_3d" in ref["route"]
    assert ref["reference_spec_brief"]["fields"] == ["parts", "proportions_ratios", "palette_hex", "materials", "unseen_sides"]


# ---------------------------------------------------------------------------
# v1.3.0 — product render pipeline options
# ---------------------------------------------------------------------------

def test_render_script_cycles_options():
    script = py_build_render_script(["front"], {"engine": "CYCLES", "samples": 128,
                                                "view_transform": "AgX", "lens": 85,
                                                "resolution": [1280, 720]})
    assert "scene.render.engine = 'CYCLES'" in script
    assert "scene.cycles.device = 'CPU'" in script
    assert "SAMPLES = 128" in script
    assert "scene.cycles.samples = SAMPLES" in script
    assert "OPENIMAGEDENOISE" in script
    assert "RGB_ALBEDO_NORMAL" in script
    assert 'VIEW_TRANSFORM = "AgX"' in script
    assert "scene.view_settings.view_transform = VIEW_TRANSFORM" in script
    assert "LENS = 85" in script
    assert "RES_X, RES_Y = 1280, 720" in script
    # EEVEE default unchanged.
    eevee = py_build_render_script(["front"])
    assert "BLENDER_EEVEE_NEXT" in eevee
    assert "LENS = 50" in eevee


def test_render_script_transparent_and_turntable():
    script = py_build_render_script(["perspective"], {"engine": "CYCLES", "transparent": True,
                                                     "turntable_frames": 4})
    assert "scene.render.film_transparent = True" in script
    assert "ground.is_shadow_catcher = True" in script
    assert "TURNTABLE_FRAMES = 4" in script
    assert "turntable_" in script
    eevee_transparent = py_build_render_script(["front"], {"transparent": True})
    assert "ground.hide_render = True" in eevee_transparent  # EEVEE has no shadow catcher


def test_render_script_rejects_bad_options():
    with pytest.raises(ValueError, match="engine"):
        py_build_render_script(["front"], {"engine": "WORKBENCH"})
    with pytest.raises(ValueError, match="samples"):
        py_build_render_script(["front"], {"engine": "CYCLES", "samples": 0})
    with pytest.raises(ValueError, match="Lens"):
        py_build_render_script(["front"], {"lens": 300})
    with pytest.raises(ValueError, match="turntable"):
        py_build_render_script(["front"], {"turntable_frames": 61})


def test_render_model_cycles_and_critique_with_real_blender(server, tmp_path):
    blender = _blender_exe()
    if not blender:
        pytest.skip("Blender not found: set BLENDER_EXECUTABLE")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300

    built = asyncio.run(server._build_from_spec({"spec": VALID_TABLE_SPEC}))
    assert built["success"], built.get("error")
    blend = built["output"]

    # Cycles hero render: small resolution to keep CPU time sane, AgX, 85 mm.
    out = tmp_path / "table_cycles"
    rendered = server.model_builder.render_model(
        blend, str(out), ["perspective"],
        {"engine": "CYCLES", "samples": 32, "view_transform": "AgX",
         "lens": 85, "resolution": [640, 360]})
    assert rendered["success"], rendered.get("error")
    png = Path(rendered["renders"][0]["path"])
    assert png.exists() and png.stat().st_size > 0
    assert png_decodes(str(png)), "Cycles PNG must decode"

    # Transparent Cycles shot: RGBA PNG (IHDR colour type 6).
    out2 = tmp_path / "table_transparent"
    rendered2 = server.model_builder.render_model(
        blend, str(out2), ["front"],
        {"engine": "CYCLES", "samples": 32, "transparent": True, "resolution": [640, 360]})
    assert rendered2["success"], rendered2.get("error")
    png2 = Path(rendered2["renders"][0]["path"])
    assert png_decodes(str(png2))
    import struct as _struct
    assert _struct.unpack(">I", png2.read_bytes()[16:20])[0] == 640
    assert png2.read_bytes()[25] == 6, "transparent PNG must be RGBA (colour type 6)"

    # Turntable: 2 EEVEE orbit frames.
    out3 = tmp_path / "table_turntable"
    rendered3 = server.model_builder.render_model(
        blend, str(out3), ["perspective"],
        {"turntable_frames": 2, "resolution": [640, 360]})
    assert rendered3["success"], rendered3.get("error")
    assert len(rendered3["renders"]) == 3  # 1 view + 2 turntable frames
    for r in rendered3["renders"]:
        assert Path(r["path"]).exists() and Path(r["path"]).stat().st_size > 0


def test_add_detail_with_real_blender(server, tmp_path):
    blender = _blender_exe()
    if not blender:
        pytest.skip("Blender not found: set BLENDER_EXECUTABLE")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300

    built = asyncio.run(server._build_from_spec({"spec": VALID_TABLE_SPEC}))
    assert built["success"], built.get("error")
    blend = built["output"]

    # Every detail helper must actually run in Blender 4.2.0.
    seam_blend = None
    for detail in ["bevel", "subdivision", "panel_line", "screw", "bolt", "seam", "grille", "label"]:
        result = asyncio.run(server._add_detail(
            {"detail": detail, "target": "Table", "params": {}, "blend_path": blend}))
        assert result["success"], f"{detail} failed: {result.get('error')}"
        assert Path(result["output"]).exists()
        if detail == "seam":
            # Copy immediately: create_mesh names outputs by second, so a
            # later detail in the same second would overwrite this file.
            seam_blend = tmp_path / "seam_result.blend"
            shutil.copy(result["output"], seam_blend)
    # Seam regression (v1.3.0 demo): the seam must hug the target's
    # cross-section ellipse, not a circle sized by max() — the old ring
    # floated far off flat/long objects (the headband got a giant ring).
    # Table is 1.2 x 0.8 m: the old seam was a 1.2 x 1.2 m circle.
    assert seam_blend is not None
    check = tmp_path / "seam_check.py"
    check.write_text(
        "import bpy\n"
        "from mathutils import Vector\n"
        f"bpy.ops.wm.open_mainfile(filepath={str(seam_blend)!r})\n"
        "def _bbox(n):\n"
        "    o = bpy.data.objects[n]\n"
        "    cs = [o.matrix_world @ Vector(c) for c in o.bound_box]\n"
        "    return (max(c.x for c in cs) - min(c.x for c in cs), max(c.y for c in cs) - min(c.y for c in cs))\n"
        "tx, ty = _bbox('Table')\n"
        "sx, sy = _bbox('Table_Seam')\n"
        "assert sx <= tx + 0.01 and sy <= ty + 0.01, f'seam bbox {(sx, sy)} exceeds table {(tx, ty)}'\n"
        "print('SEAM_OK')\n"
    )
    r = subprocess.run([blender, "--background", "--python", str(check)],
                       capture_output=True, text=True, timeout=120)
    assert "SEAM_OK" in r.stdout, r.stderr[-500:]
    # Unknown detail / missing target fail cleanly.
    bad = asyncio.run(server._add_detail({"detail": "engrave", "target": "Table", "blend_path": blend}))
    assert bad["success"] is False
    missing = asyncio.run(server._add_detail({"detail": "bevel", "target": "Nope", "blend_path": blend}))
    assert missing["success"] is False


def test_build_from_spec_marble_and_skin_with_real_blender(server, tmp_path):
    # Regression (v1.3.0 demo): the marble/skin material builders set
    # "Subsurface Color", which Blender 4.2's Principled BSDF does not
    # have (subsurface takes its colour from Base Color) — the whole
    # build died with KeyError. A spec using both materials must build.
    blender = _blender_exe()
    if not blender:
        pytest.skip("Blender not found: set BLENDER_EXECUTABLE")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300
    spec = {"objects": [
        {"name": "Slab", "kind": "cube", "size_m": [0.3, 0.2, 0.05], "position_m": [0, 0, 0], "material": "marble", "dimension_source": "measured"},
        {"name": "Head", "kind": "sphere", "size_m": [0.12, 0.12, 0.12], "position_m": [0, 0, 0.05], "material": "skin", "dimension_source": "measured"},
    ],
        "grounding": VALID_TABLE_SPEC["grounding"]}
    built = asyncio.run(server._build_from_spec({"spec": spec}))
    assert built["success"], built.get("error")
    assert {o["name"] for o in built["objects"]} == {"Slab", "Head"}
    assert Path(built["output"]).exists()


def test_critique_model_with_real_blender(server, tmp_path):
    blender = _blender_exe()
    if not blender:
        pytest.skip("Blender not found: set BLENDER_EXECUTABLE")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300

    built = asyncio.run(server._build_from_spec({"spec": VALID_TABLE_SPEC}))
    assert built["success"], built.get("error")
    blend = built["output"]

    result = asyncio.run(server._critique_model({
        "blend_path": blend,
        "spec": VALID_TABLE_SPEC,
        "output_path": str(tmp_path / "table_critique"),
    }))
    assert result["success"], result.get("error")
    assert len(result["renders"]) == 5
    for r in result["renders"]:
        assert Path(r["path"]).exists()
        assert png_decodes(r["path"])
    checks = {c["check"]: c for c in result["checks"]}
    assert checks["part_present:Table"]["passed"] is True
    assert checks["min_z:Table"]["passed"] is True
    assert any(k.startswith("connected:") and v["passed"] for k, v in checks.items())
    assert any(k.startswith("png_decodes:") and v["passed"] for k, v in checks.items())
    assert result["passed"] is True
    assert result["refine_round"] == 1 and result["max_rounds"] == 3
    assert "PER-SPEC-ITEM PASS/FAIL" in result["critique_prompt"]
    assert "cannot see" in result["note"]


# ---------------------------------------------------------------------------
# v1.3.0 fix round — proper product builders, free retrieval, fill framing
# ---------------------------------------------------------------------------

from blender_mcp.materials import MaterialLibrary as _FixRoundMaterialLibrary
from blender_mcp.products import get_product_script, PRODUCTS
from blender_mcp.retrieve import (
    retrieve_asset,
    search_polyhaven_catalogue,
    pick_polyhaven_gltf_package,
    poly_pizza_search_status,
    KNOWN_GOOD_ASSETS,
)


def test_smooth_leather_has_no_noise():
    # v1.3.0 fix: the watch strap used `fabric` (Noise -> Bump at scale 25),
    # which read as a scribbled artifact on a 22 mm strap. Straps and
    # cushions must use smooth_leather — plain Principled, no noise nodes.
    script = _FixRoundMaterialLibrary.get_material_script("smooth_leather")
    assert "ShaderNodeTexNoise" not in script
    assert "ShaderNodeTexVoronoi" not in script
    assert "Roughness" in script
    # fabric keeps its noise (it is fine for large soft goods); the rule is
    # that product builders must not use it for straps.
    assert "ShaderNodeTexNoise" in _FixRoundMaterialLibrary.get_material_script("fabric")
    for name in ("matte_plastic", "rubber", "white_leather", "amber_liquid",
                 "polished_steel", "white", "accent_red"):
        assert "ShaderNodeTexNoise" not in _FixRoundMaterialLibrary.get_material_script(name)


def test_product_scripts_have_real_curves_not_boxes():
    # Headphones: arched swept band + cushion, not a straight bar.
    hp, err = get_product_script("headphones")
    assert err is None and hp
    assert "_arc_spine" in hp and "_sweep_strip" in hp
    assert "HeadbandCushion" in hp and "EarCushion" in hp and "Yoke" in hp
    # Sneaker: lofted sole + bezier laces through eyelets, no floating rods.
    sn, _ = get_product_script("sneaker")
    assert "_loft" in sn and "LacesCurve" in sn and "Eyelet" in sn
    assert "ToeCap" in sn and "HeelCounter" in sn and "AnkleOpening" in sn
    assert "toe spring" in sn.lower() or "Toe spring" in sn
    # Perfume: bevelled body, seated cap, NOIR label.
    pf, _ = get_product_script("perfume")
    assert "bevel=0.008" in pf and "NOIR" in pf and "NeckRing" in pf
    # Smartwatch: real dial with markers + hands, curved strap.
    sw, _ = get_product_script("smartwatch")
    assert "Marker" in sw and "HourHand" in sw and "MinuteHand" in sw
    assert "Crown" in sw and "Strap" in sw
    # No product uses the noisy fabric material (the strap artifact).
    for script in (hp, sn, pf, sw):
        assert "MAT_fabric" not in script and '"fabric"' not in script
    # Straps and cushions use smooth leather, never noisy fabric.
    for script in (hp, sn, sw):
        assert "smooth_leather" in script or "MAT_smooth_leather" in script
    # Unknown product is a clean error, not a crash.
    script, error = get_product_script("spaceship")
    assert script is None and "Unknown product" in error
    assert set(PRODUCTS) == {"headphones", "sneaker", "perfume", "smartwatch"}


def test_retrieve_polyhaven_catalogue_search():
    catalogue = {
        "digital_wrist_watch": {"name": "Digital Wrist Watch"},
        "bleach_bottle": {"name": "Bleach Bottle"},
        "ArmChair_01": {"name": "Arm Chair 01"},
    }
    assert search_polyhaven_catalogue(catalogue, "watch") == ["digital_wrist_watch"]
    assert search_polyhaven_catalogue(catalogue, "bottle") == ["bleach_bottle"]
    assert search_polyhaven_catalogue(catalogue, "headphones") == []
    assert search_polyhaven_catalogue(catalogue, "") == []
    assert KNOWN_GOOD_ASSETS["smartwatch"]["slug"] == "digital_wrist_watch"
    assert KNOWN_GOOD_ASSETS["smartwatch"]["licence"] == "CC0"


def test_retrieve_polyhaven_gltf_package_pick():
    # Real /files/<slug> shape (verified against the live API 2026-11-08):
    # include is nested INSIDE the gltf entry, not a sibling of it.
    files = {"gltf": {"1k": {"gltf": {"url": "https://x/m.gltf",
                                     "include": {"textures/a.jpg": {"url": "https://x/a.jpg"},
                                                 "m.bin": {"url": "https://x/m.bin"}}}}}}
    plan = pick_polyhaven_gltf_package(files, "1k")
    assert plan["main"]["url"] == "https://x/m.gltf"
    assert "textures/a.jpg" in plan["include"]
    assert "m.bin" in plan["include"]  # the .bin is what Blender needs to import
    with pytest.raises(ValueError, match="No glTF package"):
        pick_polyhaven_gltf_package(files, "4k")
    with pytest.raises(ValueError, match="No glTF package"):
        pick_polyhaven_gltf_package({}, "1k")


def test_poly_pizza_search_needs_key(monkeypatch):
    # Verified 2026-11-08: Poly Pizza search is HTTP 401 without a key.
    monkeypatch.delenv("POLY_PIZZA_API_KEY", raising=False)
    ok, message = poly_pizza_search_status()
    assert ok is False
    assert "401" in message and "POLY_PIZZA_API_KEY" in message


def test_retrieve_asset_mocked_download(tmp_path):
    """Mocked HTTP: smartwatch resolves to the known Poly Haven asset."""
    def fake_http(url, timeout=30):
        assert "polyhaven.com" in url
        if url.endswith("/files/digital_wrist_watch"):
            return 200, {"gltf": {"1k": {"gltf": {"url": "https://dl/x/watch.gltf",
                                                 "include": {"textures/d.jpg": {"url": "https://dl/x/d.jpg"},
                                                             "watch.bin": {"url": "https://dl/x/watch.bin"}}}}}}
        raise AssertionError(f"unexpected URL {url}")

    def fake_download(url, dest):
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_bytes(b"fake-gltf-bytes")

    result = retrieve_asset({"product": "smartwatch"}, tmp_path,
                            http_json=fake_http, download=fake_download)
    assert result["success"], result.get("error")
    asset = result["asset"]
    assert asset["slug"] == "digital_wrist_watch"
    assert asset["licence"] == "CC0"
    assert asset["source_url"] == "https://polyhaven.com/a/digital_wrist_watch"
    assert Path(asset["gltf_path"]).exists()
    assert len(asset["files"]) == 3  # .gltf + texture + .bin (Blender needs the .bin)
    # Poly Pizza without a key is an honest failure, not a search.
    no_key = retrieve_asset({"product": "headphones", "source": "poly_pizza"}, tmp_path)
    assert no_key["success"] is False
    assert "401" in no_key["error"]


def test_render_script_fill_fraction():
    script = py_build_render_script(["perspective"], {"engine": "CYCLES"})
    assert "FILL_FRACTION = 0.7" in script
    assert "_frame_camera" in script and "CAMERA_DIST:" in script
    # v1.4.0 note: `max_dim * 2.5` still appears in the script, but only as
    # the cinematic fog-cube size — scope the check to _frame_camera, the
    # framing code the old tiny-watch heuristic lived in.
    start = script.index("def _frame_camera")
    end = script.index("\ndef ", start + 1)
    assert "max_dim * 2.5" not in script[start:end]  # the old tiny-watch heuristic is gone
    with pytest.raises(ValueError, match="fill_fraction"):
        py_build_render_script(["front"], {"fill_fraction": 0.1})
    with pytest.raises(ValueError, match="fill_fraction"):
        py_build_render_script(["front"], {"fill_fraction": 1.0})


def test_build_product_unknown_product(server):
    result = asyncio.run(server._build_product({"product": "spaceship"}))
    assert result["success"] is False
    assert "Unknown product" in result["error"]


def test_build_all_products_with_real_blender(server, tmp_path):
    """Every procedural product builds in real Blender: grounded, sane size."""
    blender = _blender_exe()
    if not blender:
        pytest.skip("Blender not found: set BLENDER_EXECUTABLE")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300
    expected_parts = {
        "headphones": {"Headband", "HeadbandCushion", "EarCup", "EarCushion"},
        "sneaker": {"Midsole", "Outsole", "Upper", "Laces", "ToeCap"},
        "perfume": {"BottleBody", "Liquid", "Cap", "LabelText"},
        "smartwatch": {"WatchCase", "Dial", "HourHand", "MinuteHand", "Strap"},
    }
    expected_size = {
        "headphones": (0.21, 0.10, 0.23),
        "sneaker": (0.28, 0.10, 0.11),
        "perfume": (0.08, 0.05, 0.15),
        "smartwatch": (0.24, 0.05, 0.03),
    }
    for product, parts in expected_parts.items():
        built = asyncio.run(server._build_product({"product": product, "source": "procedural"}))
        assert built["success"], f"{product}: {built.get('error')}"
        assert built["source"] == "procedural"
        assert built["min_z"] is not None and abs(built["min_z"]) < 0.001, f"{product} min_z {built['min_z']}"
        names = {o["name"].split(".")[0] for o in built["objects"]}
        assert parts <= names, f"{product}: missing {parts - names} in {names}"
        lo, hi = built["scene_min"], built["scene_max"]
        size = [hi[i] - lo[i] for i in range(3)]
        want = expected_size[product]
        for got, w in zip(size, want):
            assert abs(got - w) < 0.03, f"{product}: size {size} vs {want}"


def test_render_fill_frames_small_product_with_real_blender(server, tmp_path):
    """The v1.3.0 watch rendered at ~30% of the frame; the fill-based
    framing must put the subject at ~70%. Assert on the camera distance
    Blender prints: it must be far tighter than the old heuristic
    (max_dim * 2.5 + 0.5) for the same 0.24 m watch."""
    import re
    blender = _blender_exe()
    if not blender:
        pytest.skip("Blender not found: set BLENDER_EXECUTABLE")
    server.model_builder.config.blender.executable = blender
    server.model_builder.config.blender.timeout = 300
    built = asyncio.run(server._build_product({"product": "smartwatch", "source": "procedural"}))
    assert built["success"], built.get("error")
    out = tmp_path / "watch_fill"
    rendered = server.model_builder.render_model(
        built["output"], str(out), ["perspective"],
        {"engine": "CYCLES", "samples": 64, "resolution": [1280, 720]})
    assert rendered["success"], rendered.get("error")
    png = Path(rendered["renders"][0]["path"])
    assert png.exists() and png_decodes(str(png))
    m = re.search(r"CAMERA_DIST:perspective:([\d.]+)", rendered.get("stdout", ""))
    assert m, f"no CAMERA_DIST in stdout: {rendered.get('stdout', '')[-500:]}"
    dist = float(m.group(1))
    old_heuristic = 0.24 * 2.5 + 0.5  # 1.10 m — the distance that made the watch tiny
    assert dist < old_heuristic, f"camera still at old-heuristic distance {dist} (old {old_heuristic})"
    assert dist > 0.2, f"camera implausibly close: {dist}"
