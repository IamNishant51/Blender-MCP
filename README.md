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

## What's new in 1.3.0

- **New tool `generate_3d` — AI generation (Meshy first, Tripo second):**
  text-to-3D and image-to-3D. Meshy text-to-3D is two billed steps
  (`preview` 20 credits → `refine` 10 credits = 30 for a textured model;
  `texture:false` stops after the mesh-only preview); image-to-3D is 30
  credits and takes a URL or a base64 data URI (≤ 20 MB). Tripo is
  $0.20 (text) / $0.30 (image) for a textured model. Keys come from
  environment variables only — `MESHY_API_KEY` / `TRIPO_API_KEY` — never
  baked into source. The GLB is downloaded immediately (Meshy keeps
  assets 3 days; Tripo's model URL expires in 5 minutes, so it is
  downloaded inside the poll loop), then imported through the existing
  import path and normalised (longest side = `target_size`, origin at
  bottom, min z = 0). Polling reports progress and a timeout never cancels
  the provider task — keep the task id and poll again. **No key = the
  tool says so honestly and points at the free local path** (`research_model`
  → `build_from_spec` / `execute_blender_code`); it never fails silently
  and never invents a model. Hunyuan3D and Hyper3D Rodin are not
  implemented yet (Hunyuan needs TC3-HMAC-SHA256 signing + a Tencent Cloud
  account; Rodin needs the $120/mo Business plan for full API access).
- **Reference-image input:** `research_model` accepts `reference_image`
  (local path or URL). With a generation key it drives image-to-3D; without
  one it becomes the visual reference the spec is built from (parts,
  proportions as ratios, palette, materials, unseen sides flagged
  "to be invented plausibly").
- **Cycles studio pipeline in `render_model`:** new `engine` option —
  Cycles (CPU) alongside the existing EEVEE path. Studio HDRI/world
  lighting: `hdri: "polyhaven:<slug>"` auto-downloads a Poly Haven CC0
  HDRI (1k by default; falls back to the world+sun setup if the download
  fails), plus a 3-point + rim light rig derived from the product bounding
  box. Denoising is on (OpenImageDenoise, RGB_ALBEDO_NORMAL passes).
  Colour: Khronos PBR Neutral for catalogue shots, AgX for hero shots
  (Filmic is deprecated). Camera: 50 mm default, 85 mm hero,
  90–105 mm macro for small products. New `turntable_frames` renders
  exactly 360° about Z, and `transparent: true` gives transparent-
  background product shots (Cycles Shadow Catcher + Film Transparent —
  EEVEE has no shadow catcher, so EEVEE + transparent hides the ground
  and gives no contact shadow). Cycles timeout floor is 1800 s
  (EEVEE 600 s); samples are kept modest (128–256 + OIDN) because this
  VM has no GPU and Cycles runs on CPU.
- **New tool `add_detail` — detail helpers library:** bevels,
  subdivision surfaces, panel lines, screws, bolts, seams, grilles/vents
  and text labels, applied to a named object of a saved `.blend` with
  parameters (e.g. `bevel` width/segments, `grille` rows, `label` text).
  Every helper runs in real Blender 4.2.0 (smoke-tested).
- **New tool `critique_model` — vision critique loop:** renders 5 views
  (front ¾, side, back, top, close-up), runs programmatic checks (PNG
  exists and decodes, every spec part present, min z ≥ 0, parts
  connected/grounded, dimensions vs spec within 10%), and returns the
  views plus a structured critique prompt (per-spec-item pass/fail,
  problem→fix pairs as concrete operations on named parts, 8-dimension
  scores, dual Yes/No gate). **Honest limit: this MCP cannot see images
  — the calling model is the critic; the MCP renders, returns the image,
  and runs the fix iteration.** Max 3 auto-refine rounds, keep-best +
  revert.
- **Prefer a real asset over primitives:** `research_model` now returns
  `recommended_path` — if a Poly Haven / Sketchfab / Poly Pizza asset fits
  the request it is named as the recommended path (import via
  `import_from_url`) before modelling from primitives.
- **Fixes:** `add_detail` used to emit `bpy.ops.wm.open_mainfile(...)`
  before any `import bpy`, so every detail call died with a `NameError`
  in real Blender. Fixed — and the run was only caught because Blender
  exits 0 even when the `--python` script raises, so `runBlender` now
  treats a Python traceback on stderr as a failure instead of
  `success:true` with nothing saved (the same false-success class of bug
  as v1.1.0). The `seam` detail used to draw a circular ring sized by the
  target's longest dimension, which floated far off any flat or long
  object (the demo headband got a giant ring); it is now a unit torus
  scaled into an ellipse that hugs the object's actual cross-section.
  Turntable frames were rendered to disk but never listed in the
  `render_model` result (the host rebuilt the list from `views` only);
  it now parses the script's `RENDER_DONE_JSON`, so the returned list
  includes every frame. **Headless-Linux note:** EEVEE needs `libEGL.so.1`
  (package `libegl1`); Cycles CPU rendering does not.
- **Fix round (2026-11-08, still 1.3.0): the demo renders were rejected
  outright, so the products were rebuilt properly.** New tool
  `retrieve_asset` — free real-asset retrieval first: Poly Haven (CC0,
  no key) is searched and the 1k glTF package downloaded; the smartwatch
  now uses the real Poly Haven `digital_wrist_watch` (vintage digital
  watch, CC0). Poly Pizza search needs the user's own `POLY_PIZZA_API_KEY`
  (its search endpoint returns HTTP 401 without a key since 2026-11-08) —
  without one the tool says so honestly. New tool `build_product` —
  proper builders with real curves, not stacked primitives: headphones
  (arched swept band + inner cushion + padded torus cup cushions),
  sneaker (lofted sole with footprint taper + toe spring, lofted upper,
  bezier-curve laces through metal eyelets, toe cap, heel counter),
  perfume (bevelled glass body, amber liquid, gold neck ring, bevelled
  cap seated on the neck with no gap, NOIR label), smartwatch
  (procedural fallback: bevelled case, dial with 12 markers + hands at
  10:10, crown, curved strap). New materials `smooth_leather`,
  `matte_plastic`, `rubber`, `white_leather`, `amber_liquid` — all with
  NO noise nodes: the v1.3.0 watch strap used `fabric` (Noise→Bump),
  which read as a scribbled artifact on a 22 mm strap. `render_model`
  now frames EXACTLY: per view the camera pulls back until the subject's
  binding axis fills `fill_fraction` (default 0.7) of the frame — the old
  `max_dim * 2.5 + 0.5` heuristic rendered the demo watch at ~30% of the
  frame. Retrieved assets are downloaded on demand into the asset cache
  and never committed (binary files cannot go through snapshot-push).

### Honest limits of 1.3.0

- Without a generation API key there are **no AI-generated meshes** —
  the free local path builds from primitives + details + real textures +
  studio rendering, which is visibly better than v1.2.0 but still cannot
  match a human 3D artist's mesh. The realistic leap needs
  `generate_3d` with a key, or a retrieved real asset.
- The MCP itself does not see images: `critique_model` renders and
  checks programmatically, but the visual judgement is the calling
  model's job.
- Cycles on CPU is slow (a 128-sample 1280×720 hero frame takes minutes
  on this VM); EEVEE is the fast path.

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
| `research_model` | Research-first step: search references for a model and get the part-breakdown schema. No code is written before this step — produce a JSON scene spec, then call `build_from_spec`. Accepts `reference_image` (local path or URL): with a generation key it drives image-to-3D, without one it is the visual reference the spec is built from. Returns `recommended_path` when a real Poly Haven / Sketchfab / Poly Pizza asset fits — prefer that over modelling from primitives. |
| `build_from_spec` | Build a scene from a validated JSON scene spec (metres, Z-up, bottom-centre positions, mate attachments). Returns object names, bounding boxes and min z. |
| `generate_3d` | AI generation (Meshy first, Tripo second): text-to-3D or image-to-3D. Needs `MESHY_API_KEY` or `TRIPO_API_KEY` — without a key it says so honestly and points at the free local path. Downloads the GLB immediately, imports it and normalises (longest side = `target_size`, min z = 0). |
| `retrieve_asset` | Free real-asset retrieval before building from primitives: searches Poly Haven (CC0, no key) and downloads the 1k glTF package. Known good: smartwatch → Poly Haven `digital_wrist_watch`. Poly Pizza needs the user's own `POLY_PIZZA_API_KEY` (search is HTTP 401 without a key). |
| `build_product` | Build a catalogue product with real curves: headphones (arched band + padded cups), sneaker (lofted sole + toe spring + bezier laces), perfume (bevelled glass, seated gold cap), smartwatch (real dial + curved strap; `source: auto` prefers the retrieved Poly Haven watch). |
| `add_detail` | Apply a named detail to an object of a saved `.blend`: `bevel`, `subdivision`, `panel_line`, `screw`, `bolt`, `seam`, `grille`, `label` — with parameters. |
| `critique_model` | Vision critique loop: renders 5 views, runs programmatic checks (PNG decodes, parts present, min z ≥ 0, connected/grounded, dimensions vs spec), returns the views plus a structured critique prompt for the calling model (the MCP itself cannot see images). Max 3 auto-refine rounds. |
| `render_model` | Render a saved `.blend` with the studio preset (50 mm camera, 3-point + rim lighting, ground plane) as verified PNGs, one per view. `engine: "CYCLES"` for Cycles CPU + OpenImageDenoise (AgX hero / PBR Neutral catalogue, 85 mm hero lens, `polyhaven:<slug>` studio HDRI, turntable 360° about Z, transparent-background product shots); default is EEVEE. Camera framing is exact: the subject fills `fill_fraction` (default 0.7) of the frame on its binding axis. |
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
| `MESHY_API_KEY` | — | Meshy API key for `generate_3d` (text/image-to-3D). No key = the tool says so and points at the free local path. Never put a key in source. |
| `TRIPO_API_KEY` | — | Tripo API key for `generate_3d` (second provider after Meshy). Same no-key behaviour. |
| `POLY_PIZZA_API_KEY` | — | Poly Pizza API key for `retrieve_asset` (source `poly_pizza`). Poly Pizza search returns HTTP 401 without a key; without one the tool says so honestly and searches Poly Haven instead. Never put a key in source. |

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
