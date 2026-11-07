"""Real-Blender verification (P1-7).

Runs every built-in template (Python + TypeScript versions) and the import
normalisation script through an actual headless Blender and asserts the
same bounding-box expectations as the fake-bpy tests. This is the check
that proves the models are really right, not just right in the simulator.

Usage::

    BLENDER_EXECUTABLE=/path/to/blender python3 tests/verify_blender.py
    # or, with blender on PATH:
    python3 tests/verify_blender.py

Requires Blender 4.x and the compiled TypeScript (npm run build).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tests"))
sys.path.insert(0, str(REPO))

BLENDER = os.environ.get("BLENDER_EXECUTABLE") or shutil.which("blender")
FAILURES = []

BOUNDS_SNIPPET = """
import bpy, json
from mathutils import Vector

objs = []
for o in bpy.data.objects:
    if o.type == 'MESH':
        corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
        xs = [v.x for v in corners]; ys = [v.y for v in corners]; zs = [v.z for v in corners]
        objs.append({"name": o.name,
                     "min": [min(xs), min(ys), min(zs)],
                     "max": [max(xs), max(ys), max(zs)]})
all_min = [min(o["min"][i] for o in objs) for i in range(3)] if objs else [0, 0, 0]
all_max = [max(o["max"][i] for o in objs) for i in range(3)] if objs else [0, 0, 0]
print("BLENDER_BOUNDS_JSON:" + json.dumps({
    "objects": objs, "scene_min": all_min, "scene_max": all_max,
    "scene_size": [all_max[i] - all_min[i] for i in range(3)],
}))
"""


def check(name, cond, detail=""):
    status = "ok  " if cond else "FAIL"
    print(f"  {status} - {name}" + (f" ({detail})" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def run_blender(script: str, timeout=180):
    """Run a Blender script headless; return parsed bounds JSON."""
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(script + "\n" + BOUNDS_SNIPPET)
        path = f.name
    try:
        proc = subprocess.run(
            [BLENDER, "--background", "--python", path],
            capture_output=True, text=True, timeout=timeout,
        )
    finally:
        os.unlink(path)
    for line in proc.stdout.splitlines():
        if line.startswith("BLENDER_BOUNDS_JSON:"):
            return json.loads(line.split(":", 1)[1])
    raise RuntimeError(
        "Blender produced no bounds JSON.\nSTDOUT:\n" + proc.stdout[-2000:]
        + "\nSTDERR:\n" + proc.stderr[-2000:]
    )


def python_templates():
    """Template scripts from the Python server (no full server needed)."""
    from blender_mcp.server import BlenderMCPServer

    inst = BlenderMCPServer.__new__(BlenderMCPServer)
    return {
        "temple": inst._generate_temple_script(""),
        "rickshaw": inst._generate_rickshaw_script(""),
        "thali": inst._generate_thali_script(""),
        "building": inst._generate_building_script(""),
        "character": inst._generate_character_script(""),
    }


def ts_templates():
    """Template scripts from the compiled TypeScript server."""
    script = f"""
import {{ generateModelScript }} from '{REPO}/dist/commands/generators.js';
import {{ writeFileSync }} from 'node:fs';
const out = process.argv[2];
const scripts = {{
  temple: generateModelScript('indian temple', ''),
  rickshaw: generateModelScript('auto rickshaw', ''),
  thali: generateModelScript('thali', ''),
  building: generateModelScript('haveli palace', ''),
  character: generateModelScript('person', ''),
}};
writeFileSync(out, JSON.stringify(scripts));
"""
    with tempfile.TemporaryDirectory() as d:
        gen = Path(d) / "gen.mjs"
        out = Path(d) / "scripts.json"
        gen.write_text(script)
        subprocess.run(
            ["node", str(gen), str(out)], cwd=REPO, check=True, capture_output=True, text=True
        )
        return json.loads(out.read_text())


def assert_template(name, result):
    print(name)
    for o in result["objects"]:
        check(f"{name}: {o['name']} min z >= 0", o["min"][2] >= -0.001, f"min z = {o['min'][2]:.3f}")
    size = result["scene_size"]
    if name == "temple":
        check("temple: height 6-8 m", 6.0 < size[2] < 8.0, f"height = {size[2]:.2f}")
        check("temple: taller than wide", size[2] > size[0])
    elif name == "rickshaw":
        wheels = [o for o in result["objects"] if o["name"].startswith("Wheel")]
        check("rickshaw: 3 wheels", len(wheels) == 3, f"got {len(wheels)}")
        check("rickshaw: under 2 m tall", size[2] < 2.0, f"height = {size[2]:.2f}")
    elif name == "thali":
        check("thali: 5 objects", len(result["objects"]) == 5)
        check("thali: under 0.25 m tall", size[2] < 0.25, f"height = {size[2]:.3f}")
    elif name == "building":
        check("building: height 7.5-8 m", 7.5 < size[2] < 8.0, f"height = {size[2]:.2f}")
    elif name == "character":
        check("character: 1.87 m tall", abs(size[2] - 1.87) < 0.05, f"height = {size[2]:.2f}")


def verify_import():
    """End-to-end import: make a real GLB, import + normalise it, check bounds."""
    print("import (real GLB)")
    with tempfile.TemporaryDirectory() as d:
        glb_path = Path(d) / "big_box.glb"
        make_glb = f"""
import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 3))
box = bpy.context.active_object
box.name = "BigBox"
box.scale = (2.0, 1.0, 0.25)
bpy.ops.export_scene.gltf(filepath={str(glb_path)!r}, export_format='GLB')
"""
        script_path = Path(d) / "make_glb.py"
        script_path.write_text(make_glb)
        subprocess.run(
            [BLENDER, "--background", "--python", str(script_path)],
            check=True, capture_output=True, text=True, timeout=120,
        )
        assert glb_path.exists(), "test GLB was not created"

        from blender_mcp.server import BlenderMCPServer

        script = BlenderMCPServer._build_import_script(
            str(glb_path), "bpy.ops.import_scene.gltf", str(Path(d) / "out.blend"), 1.0
        )
        result = run_blender(script)
        longest = max(result["scene_size"])
        check("import: normalised longest side 1.0 m", abs(longest - 1.0) < 0.05, f"longest = {longest:.3f}")
        check("import: normalised min z = 0", abs(result["scene_min"][2]) < 0.01, f"min z = {result['scene_min'][2]:.3f}")


def main():
    if not BLENDER:
        print("No Blender found: set BLENDER_EXECUTABLE or put blender on PATH.")
        return 2
    print(f"Using Blender: {BLENDER}")

    print("\nPython templates (real Blender):")
    for name, script in python_templates().items():
        assert_template(name, run_blender(script))

    print("\nTypeScript templates (real Blender):")
    for name, script in ts_templates().items():
        assert_template(name, run_blender(script))

    print()
    verify_import()

    print(f"\n{'All real-Blender checks passed.' if not FAILURES else str(len(FAILURES)) + ' check(s) FAILED: ' + ', '.join(FAILURES)}")
    return 0 if not FAILURES else 1


if __name__ == "__main__":
    sys.exit(main())
