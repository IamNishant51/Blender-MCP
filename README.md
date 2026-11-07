<!--
  Blender MCP Server
  Connect AI assistants to Blender for 3D creation
-->
<h1 align="center">
  <br>
  <img src="https://raw.githubusercontent.com/IamNishant51/Blender-MCP/main/logo.png" alt="Blender MCP" width="120">
  <br>
  <br>
  Blender MCP Server
  <br>
</h1>

<p align="center">
  <strong>MCP server for controlling Blender via AI assistants</strong>
  <br>
  Claude Code | OpenCode | GitHub Copilot
</p>

---

## Overview

Blender MCP enables AI assistants to control Blender programmatically, allowing you to:

- Create complex 3D models with detailed planning and procedural generation
- Search the internet for 3D models and textures
- Apply materials and textures to objects
- Modify existing models
- Import and export 3D files

---

## What's new in 1.2.0

- **Research-first pipeline:** new `research_model` tool — search references
  first, break the subject into parts with real dimensions, then build.
  New `build_from_spec` tool — build from a validated JSON scene spec
  (`{objects: [{name, kind, size_m, position_m, rotation_deg, material,
  attach}]}`) in metres, Z-up, position = bottom-centre. The spec is
  validated before Blender runs (sizes > 0, z >= 0, inside a 10 m work
  area, `on_top_of` mates must touch within 0.05 m) and returns the exact
  failed checks; placement is solved from parent bounding boxes by mate
  helpers (`grounded`, `on_top_of`, `centred_on`), never guessed.
- **New tool `render_model`:** renders a saved `.blend` with the
  presentation preset (50 mm camera auto-framed on the bounding-box centre,
  3-point area-light rig — key ~100 W at 2 m, fill at most half the key, rim
  behind — sun + world light, ground plane) as EEVEE PNGs (front / side /
  perspective by default). Only the key casts shadows and TAA samples are
  32 (preview-grade): on software GL each view takes ~1 min, so renders get
  a 600 s timeout floor. Every PNG is verified to exist on disk and be
  non-empty before success is reported — the v1.1.0 false-`success:true`
  with no PNG written is now impossible.
- **Materials v2:** procedural Principled BSDF node trees instead of flat
  colours — wood (Noise → ColorRamp + Bump), marble (Voronoi veins +
  Subsurface), metal (Noise-varied roughness), fabric (Sheen), steel, glass,
  skin, sandstone — all on Generated coordinates (no UVs needed). Smart UV
  Project runs before any image-texture application. `apply_texture` now
  supports `polyhaven:<slug>`: downloads the real 1k maps, wires them with
  correct colour spaces (sRGB colour, Non-Color data, Normal Map node),
  packs the images into the `.blend`, and writes Poly Haven provenance
  (id / url / CC0 licence) onto the material. If the Poly Haven API is
  unreachable it fails with a clear error, never a silent fallback.
  `apply_texture` also takes an optional `blend_path`: without it the
  material is created in an empty scene and applied to nothing, so pass
  the `.blend` to texture an actual model.
- **Fixed templates (research dimensions):** the rickshaw is now a real
  Bajaj RE (2.66 × 1.30 × 1.70 m, wheelbase 2.00, 3 wheels, Ø 0.42 tyres,
  low curved black canopy peaking at 1.70 on 4 support pillars, yellow + black two-tone); the
  thali is a Ø 0.32 m bright polished-steel plate with white rice, 4 katoris
  with distinct contents, and a golden roti; the haveli has a real 4×4
  open courtyard, two 3.2 m floors, parapet, arched windows, jharokha
  balconies, roof chhatris, and golden sandstone + fresco band (no temple
  spire); the character is 1.75 m / 7.5 heads with a visible 0.23 m head,
  kurta to the knee, arms reaching mid-thigh, and dhoti to the ankle.
  Temple and chair templates are unchanged.
- **Fixes found by looking at the renders:** the first lighting preset
  (world 1.0 + sun 3 + 150 W key) washed every colour to white, so the rig
  is dimmer now (world 0.35, sun 1.5, key ~100 W, ground 0.55 grey).
  Rotated spec objects used to be placed from `size[2]/2` even when the
  rotated height was different — both the spec builder and the validator
  now use the rotated bounding-box height, so a cylinder rotated 90° about
  Y is `size[0]` tall. A glossy `black` material was added (alien eyes,
  cannons, trim). Template materials now match on base names, so duplicated
  parts (`Wheel.001`, `Eye.001`, …) all get their material instead of only
  the first copy.

---

## What's new in 1.1.0

- **Axis fix:** all five built-in templates were rewritten Z-up, in metres,
  with every part standing on the ground (z = 0). Previously the templates
  were written Y-up, so towers ran sideways and pillars sat underground.
- **New tool `execute_blender_code`:** run arbitrary Blender Python (`bpy`)
  code for any model that is not one of the five built-in templates.
- **No more temple default:** a description that matches no template now
  returns an honest "no template matched" error pointing at
  `execute_blender_code`, instead of silently building a temple.
- **`import_from_url` works:** implemented in the TypeScript server
  (previously a stub) and fixed the STL operator in the Python server
  (`bpy.ops.import_mesh.stl`). Imported models are normalised to 1 m
  longest side and placed on the ground.
- **Logs go to stderr:** server logs no longer pollute the MCP protocol
  stream on stdout.
- **Real tests:** bounding-box tests for every template
  (`npm test`, `pytest`, `tests/verify_blender.py` with real Blender).

---

## Installation

```bash
# Install from npm
npm install -g blender-mcp

# Or use npx
npx blender-mcp
```

**Requirements:** Node.js 18+ and Blender installed

---

## Available Tools

| Tool | Description |
|------|-------------|
| `create_complex_model` | Build complex 3D models with internet search and detailed planning. Supports Indian themes: temples, vehicles, food, characters, buildings, and more. |
| `research_model` | Research-first step: search references for a model and get the part-breakdown schema. No code is written before this step — produce a JSON scene spec, then call `build_from_spec`. |
| `build_from_spec` | Build a scene from a validated JSON scene spec (metres, Z-up, bottom-centre positions, mate attachments). Returns object names, bounding boxes and min z. |
| `render_model` | Render a saved `.blend` with the presentation preset (50 mm camera, 3-point lighting, ground plane) as verified EEVEE PNGs, one per view. |
| `execute_blender_code` | Run arbitrary Blender Python (`bpy`) code. Use for any model that is not one of the five built-in templates. Z-up, dimensions in metres, ground at z = 0. |
| `modify_model` | Modify existing 3D models - change colors, materials, scale, rotation, or apply effects. |
| `apply_texture` | Apply procedural materials to 3D objects (wood, marble, stone, metal, etc.) — real Principled BSDF node trees, not flat colours. Use `polyhaven:<slug>` to download and apply a real Poly Haven texture (1k maps, colour-space-correct, packed into the `.blend`). Pass `blend_path` to texture a saved model; without it the material is created but applied to nothing. |
| `search_models` | Search the entire internet for 3D models across multiple sources. |
| `search_textures` | Search for free textures from online databases. |
| `get_scene_info` | Get information about the current Blender scene. |
| `import_from_url` | Import a 3D model directly from a URL. |

---

## Configuration

### Claude Code

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "blender": {
      "command": "npx",
      "args": ["blender-mcp"]
    }
  }
}
```

### OpenCode

```json
{
  "blender": "npx blender-mcp"
}
```

### Other MCP Clients

```bash
npx blender-mcp
# or
npm install -g blender-mcp && blender-mcp
```

---

## Built-in Model Templates

The server includes procedural generation for various Indian-themed 3D models. All templates are Z-up, dimensioned in metres, and stand on the ground (z = 0):

| Category | Description |
|----------|-------------|
| **Temples** | Detailed Indian temples with pillars, mandapa, shikhara, torana, and decorative elements |
| **Vehicles** | Auto-rickshaws (Tuk-Tuk) with wheels, cabin, headlights, and details |
| **Food** | Traditional Indian thali with plate, rice, curries, rotis, and accompaniments |
| **Buildings** | Haveli/Palace structures with multiple floors, jali windows, chattris, and courtyards |
| **Characters** | Human figures in traditional Indian attire (dhoti) |

### Material Library

Built-in procedural materials:

| Material | Variants |
|----------|----------|
| Marble | white, red, green |
| Metal | gold, copper, brass |
| Stone | stone, sandstone, terracotta |
| Wood | standard wood grain |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BLENDER_EXECUTABLE` | `blender` | Path to Blender executable |
| `BLENDER_TIMEOUT` | `120` | Timeout for Blender operations (seconds) |
| `BLENDER_MCP_DIR` | `~/Desktop/BLENDER-MCP` | Base directory for output files |
| `BLENDER_MCP_DEBUG` | `false` | Enable debug logging |

---

## Example Usage

Once connected to an AI assistant, you can create 3D scenes like:

1. "Create an Indian temple with red marble material"
2. "Build a traditional auto-rickshaw in yellow"
3. "Create a thali with rice and multiple curries"
4. "Add a marble texture to my model"
5. "Search for free 3D models of chairs"

---

## Architecture

```
+-----------+      MCP      +-------------+    subprocess   +---------+
| Claude/   |  <----------> | blender-mcp |  <-----------   | Blender |
| Copilot   |               |  (Node.js)  |  --background   |  --bg   |
+-----------+               +-------------+                 +---------+
```

The server runs Blender as a background subprocess and executes Python scripts using Blender's `bpy` API for each operation.

---

## Development

```bash
# Clone and install
npm install

# Build
npm run build

# Run
npm start
```

---
🌐 **Check out my portfolio:** [nishantunavane.qzz.io](https://nishantunavane.qzz.io)

---

## License

MIT License
