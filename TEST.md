# 🧪 Blender MCP Server — Tests

## Prerequisites

- Node.js 18+
- Python 3.10+
- Blender 4.x (only for `tests/verify_blender.py`; the other suites do not
  need Blender)

Install the Python test dependencies:

```bash
pip install -e ".[test]"   # installs mcp, pytest, pytest-asyncio
```

## Test suites

### 1. TypeScript template checks — `npm test`

```bash
npm test   # runs `tsc` build, then node tests/check_ts_templates.mjs
```

No Blender needed. Each generated template script is executed against a
fake `bpy` (`tests/geometry.py`) and its bounding boxes are asserted:
nothing below the ground, sane heights, wheels touching the ground, floors
stacked in +Z, the haveli courtyard void open to the sky, the character's
head above z = 1.5 with fingertips at mid-thigh. It also checks that
unmatched descriptions return an empty script (no temple default), that
the import script uses the correct Blender import operators, that the
scene-spec validator rejects bad specs (negative z, zero size,
out-of-bounds, non-touching `on_top_of`), that `build_from_spec` solves
mates from bounding boxes, and that the materials-v2 node trees and the
render script are well formed.

### 2. Python tests — `pytest`

```bash
python -m pytest
# with real Blender for the render test:
BLENDER_EXECUTABLE=/path/to/blender python -m pytest
```

Same bounding-box expectations for the Python templates, plus:

- no template match returns `None` (and `create_complex_model` reports
  "no template matched" with a pointer to `execute_blender_code`)
- `execute_blender_code` is registered and rejects empty code
- `research_model`, `build_from_spec` and `render_model` are registered;
  `research_model` returns references + the part-breakdown schema;
  `build_from_spec` returns the exact failed checks for an invalid spec
- spec validation rejects negative z, zero size, out-of-bounds boxes,
  non-touching `on_top_of` mates and unknown attach parents
- materials v2 are real node trees (Noise wood, Voronoi marble, Sheen
  fabric, Subsurface skin); unknown names fall back to a flat colour
- Smart UV Project runs (angle 66°, island margin 0.02) before texturing
- Poly Haven map picking (1k, colour/roughness/normal/AO, ARM fallback)
  and a clean failure for a missing slug (no silent fallback)
- `apply_texture` with a `blend_path` opens the model before texturing
  (a missing `.blend` fails cleanly) and the generated script contains
  the `open_mainfile` call; without a path the material would be created
  in an empty scene and applied to nothing
- the import script uses `bpy.ops.import_mesh.stl` (never
  `import_scene.stl`) and normalises a too-big floating model to 1 m on
  the ground
- the Python logger never writes to stdout (stdout is the MCP stream)
- render verification (needs real Blender, skipped otherwise):
  `build_from_spec` + `render_model` end to end — the PNGs must exist on
  disk and be non-empty, and a render against a missing `.blend` must
  return `success:false`

### 3. Real-Blender verification — `tests/verify_blender.py`

```bash
BLENDER_EXECUTABLE=/path/to/blender python3 tests/verify_blender.py
# or, with blender on PATH:
python3 tests/verify_blender.py
```

Runs all five templates (Python and TypeScript versions) plus a real GLB
import through an actual headless Blender and asserts the same bounds.
Then verifies `build_from_spec` + `render_model` end to end in both
servers (Python directly, TypeScript via a node driver): the built model
reports min z = 0, and every rendered PNG exists on disk and is non-empty.
This is the check that proves the models are really right, not just right
in the simulator.

Note: EEVEE rendering in headless Blender needs `libEGL.so.1` on the
system (`sudo apt-get install libegl1 libgl1` on Debian/Ubuntu). Without
it the render step fails with "Couldn't open libEGL.so.1" — that is an
environment problem, not a code problem.

## The one test that matters most

Run this and look at the render: **"Create an Indian temple with red
marble material."** The screenshot must show a temple — tower up, steps
up, pillars on the ground, red marble. Before v1.1.0 it showed walls, a
sideways tower, and a hall under the floor.

## Manual check

After running the suites, try the server end to end (needs Blender):

```bash
npm run build
BLENDER_EXECUTABLE=$(which blender) node dist/index.js
# then send JSON-RPC over stdio: initialize, tools/list, tools/call
# execute_blender_code with a small bpy script
```

Every stdout line must be valid JSON — logs go to stderr, never stdout.

## Known issue (not covered by these tests)

The Python server's `__init__` registers handlers with the old mcp SDK
API (`list_tools_handler` / `call_tool_handler`), which the current `mcp`
package no longer has. A fresh `pip install mcp` therefore cannot even
instantiate the Python server. The geometry tests work around this by
building the server object without `__init__`. Migrating the Python
server to the current mcp SDK decorator API is a known follow-up; the
TypeScript server (the one shipped on npm) is unaffected.
