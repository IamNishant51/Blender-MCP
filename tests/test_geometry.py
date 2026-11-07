"""Bounding-box tests for the built-in templates (P1-7).

Every template script is executed against tests/geometry.py's fake bpy and
its world-space bounding boxes are asserted: nothing below the ground, sane
heights, and the right parts in the right places. The old Y-up bug fails
every one of these tests (tower sideways, pillars underground).

Run with:  python -m pytest
(needs the mcp package: pip install -e ".[test]")
"""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest

from geometry import execute_script, scene_bounds

from blender_mcp.config import BlenderConfig, PathsConfig, ServerConfig
from blender_mcp.server import BlenderMCPServer
from blender_mcp.utils import setup_logging


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


def test_rickshaw_wheels_touch_the_ground(server):
    objects = execute_script(server._generate_rickshaw_script(""))
    assert_on_ground(objects)
    wheels = [o for o in objects if o.name == "Wheel"]
    assert len(wheels) == 3, f"expected 3 wheels, got {len(wheels)}"
    for w in wheels:
        lo, hi = w.world_bounds()
        assert abs(lo.z) < 0.001, f"wheel floats or sinks: min z = {lo.z:.3f}"
        assert abs((hi.z - lo.z) - 1.0) < 0.01, "wheel diameter should be 1.0 m"
    lo, hi = scene_bounds(objects)
    assert hi.z - lo.z < 2.0, "rickshaw should be under 2 m tall, not 4.4 m"
    body = by_name(objects)["BodyMain"]
    b_lo, b_hi = body.world_bounds()
    assert abs((b_hi.y - b_lo.y) - 2.2) < 0.01, "rickshaw body should be 2.2 m long"


def test_thali_is_a_small_flat_plate(server):
    objects = execute_script(server._generate_thali_script(""))
    assert len(objects) == 5  # plate + rice mound + 3 bowls
    assert_on_ground(objects)
    lo, hi = scene_bounds(objects)
    assert hi.z - lo.z < 0.25, "thali should be flat, under 0.25 m tall"
    plate = by_name(objects)["ThaliPlate"]
    p_lo, p_hi = plate.world_bounds()
    assert abs((p_hi.x - p_lo.x) - 0.7) < 0.01, "plate should be 0.7 m across"
    assert abs(p_hi.z - 0.03) < 0.01, "plate top should be at z = 0.03"


def test_haveli_floors_stack_upwards(server):
    objects = execute_script(server._generate_building_script(""))
    assert_on_ground(objects)
    names = by_name(objects)
    ground_lo, ground_hi = names["GroundFloor"].world_bounds()
    first_lo, first_hi = names["FirstFloor"].world_bounds()
    roof_lo, roof_hi = names["MainRoof"].world_bounds()
    assert abs(ground_hi.z - 3.0) < 0.01, "ground floor should top out at z = 3"
    assert abs(first_lo.z - 3.0) < 0.01, "first floor should start at z = 3"
    assert abs(first_hi.z - 5.5) < 0.01, "first floor should top out at z = 5.5"
    assert abs(roof_lo.z - 5.5) < 0.01, "roof should start at z = 5.5"
    lo, hi = scene_bounds(objects)
    assert 7.5 < hi.z < 8.0, f"haveli height {hi.z:.2f} m is wrong"


def test_character_stands_upright(server):
    objects = execute_script(server._generate_character_script(""))
    assert_on_ground(objects)
    names = by_name(objects)
    head = names["Head"]
    torso = names["Torso"]
    dhoti = names["Dhoti"]
    # Head above torso above dhoti, feet on the ground.
    assert head.location.z > torso.location.z > dhoti.location.z
    d_lo, _ = dhoti.world_bounds()
    assert abs(d_lo.z) < 0.001, "dhoti must start at the ground"
    h_lo, h_hi = head.world_bounds()
    assert abs(h_hi.z - 1.87) < 0.01, f"figure should be 1.87 m tall, got {h_hi.z:.2f}"
    lo, hi = scene_bounds(objects)
    assert hi.x - lo.x < 1.2, "figure footprint should be about 1 m wide"


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
