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
stacked in +Z. It also checks that unmatched descriptions return an empty
script (no temple default) and that the import script uses the correct
Blender import operators.

### 2. Python tests — `pytest`

```bash
python -m pytest
```

Same bounding-box expectations for the Python templates, plus:

- no template match returns `None` (and `create_complex_model` reports
  "no template matched" with a pointer to `execute_blender_code`)
- `execute_blender_code` is registered and rejects empty code
- the import script uses `bpy.ops.import_mesh.stl` (never
  `import_scene.stl`) and normalises a too-big floating model to 1 m on
  the ground
- the Python logger never writes to stdout (stdout is the MCP stream)

### 3. Real-Blender verification — `tests/verify_blender.py`

```bash
BLENDER_EXECUTABLE=/path/to/blender python3 tests/verify_blender.py
# or, with blender on PATH:
python3 tests/verify_blender.py
```

Runs all five templates (Python and TypeScript versions) plus a real GLB
import through an actual headless Blender and asserts the same bounds.
This is the check that proves the models are really right, not just right
in the simulator.

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
