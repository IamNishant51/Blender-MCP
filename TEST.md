# 🧪 Blender MCP Server — Test Suite

Welcome! This file will help you verify that the MCP server is working correctly before publishing to npm.

---

## Prerequisites

- [x] Blender installed (`blender --version`)
- [x] Python 3.10+
- [x] Package installed: `pip install -e .`

---

## Quick Test — Create a Cube

Run this command to create a simple cube:

```bash
cd ~/Desktop/best
python -c "
import subprocess
import json
import tempfile
import os

script = '''
import bpy, json
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0), scale=(1, 1, 1))
obj = bpy.context.active_object
print(json.dumps({\"name\": obj.name, \"type\": obj.type}))
'''

with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
    f.write(script)
    script_path = f.name

result = subprocess.run(
    ['blender', '--background', '--python', script_path],
    capture_output=True, text=True, timeout=30
)
os.unlink(script_path)

print('STDOUT:', result.stdout)
print('STDERR:', result.stderr[:500] if result.stderr else '')
print('Return code:', result.returncode)
"
```

**Expected:** `{"name": "Cube", "type": "MESH"}` in stdout

---

## Full MCP Server Test

### Step 1: Start the MCP server

In one terminal:
```bash
cd ~/Desktop/best
python -m blender_mcp.server
```

### Step 2: Test with MCP client

The server exposes these tools:

| # | Tool | Test Command |
|---|------|--------------|
| 1 | `create_cube` | Create a cube |
| 2 | `create_sphere` | Create a sphere |
| 3 | `create_material` | Make a red material |
| 4 | `add_light` | Add a light |
| 5 | `get_scene_info` | List all objects |

---

## Manual Blender Verification

After running tests, open Blender manually:

```bash
blender
```

Check if:
- ✓ Cube/sphere objects appear in the scene
- ✓ Materials are attached to objects
- ✓ Lights are visible in the viewport

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `blender: command not found` | Add Blender to PATH or update `blender_path` in `server.py` |
| Timeout errors | Increase timeout in `BlenderExecutor.run_script()` |
| Import errors | Run `pip install -e .` again |

---

## Next Steps

Once tests pass:

```bash
cd ~/Desktop/best
npm publish
```

---

**Happy Testing!** 🎉