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
         "position_m": [0, 0, 0.7], "material": "wood"},
        {"name": "Leg", "kind": "cylinder", "size_m": [0.08, 0.08, 0.7],
         "position_m": [0, 0, 0], "attach": "grounded"},
        {"name": "Top", "kind": "cube", "size_m": [1.2, 0.8, 0.05],
         "position_m": [0, 0, 0.75], "attach": "on_top_of:Table"},
    ]
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


def test_apply_texture_blend_path(server, tmp_path):
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

    server.model_builder.create_mesh = fake_create_mesh
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
