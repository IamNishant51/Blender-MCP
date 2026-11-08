"""Blender MCP Server - Production Ready.

MCP server for controlling Blender via AI assistants.
"""

import asyncio
import json
import logging
import os
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from mcp.server import Server
from mcp.types import Tool, TextContent
from mcp.server.stdio import stdio_server

from blender_mcp.config import ServerConfig, config as default_config
from blender_mcp.utils import setup_logging, get_logger
from blender_mcp.materials import (
    MaterialLibrary,
    get_smart_uv_script,
    pick_polyhaven_maps,
    build_polyhaven_material_script,
    POLYHAVEN_API,
    USER_AGENT as POLYHAVEN_USER_AGENT,
    POLYHAVEN_LICENCE,
)
from blender_mcp.spec import parse_spec, validate_spec, build_from_spec
from blender_mcp.render import build_render_script, RENDER_VIEWS
from blender_mcp.generate import (
    run_generate_3d,
    build_meshy_text_request,
    build_meshy_image_request,
    build_tripo_text_request,
    build_tripo_image_request,
)
from blender_mcp.details import get_detail_script, DETAIL_TYPES
from blender_mcp.products import get_product_script, get_retrieved_product_script, PRODUCTS
from blender_mcp.retrieve import retrieve_asset
from blender_mcp.critique import (
    build_critique_script,
    parse_critique_json,
    build_critique_prompt,
    png_decodes,
    MAX_REFINE_ROUNDS,
    CRITIQUE_NOTE,
)


# ==============================================================================
# Search Functions
# ==============================================================================

class SearchService:
    """Handles internet searches for 3D models and textures."""

    def __init__(self, config: ServerConfig):
        self.config = config.search
        self.logger = get_logger("search")
        self._cache: dict = {}

    def _get_cache(self, key: str) -> Optional[list]:
        """Get cached results if not expired."""
        if key in self._cache:
            entry = self._cache[key]
            if (datetime.now() - entry["timestamp"]).seconds < self.config.cache_ttl:
                return entry["data"]
            del self._cache[key]
        return None

    def _set_cache(self, key: str, data: list):
        """Cache search results."""
        self._cache[key] = {"data": data, "timestamp": datetime.now()}

    def search_models(self, query: str) -> dict:
        """Search multiple sources for 3D models."""
        self.logger.info(f"Searching for models: {query}")

        # Check cache
        cache_key = f"models:{query}"
        cached = self._get_cache(cache_key)
        if cached:
            self.logger.debug("Using cached search results")
            return cached

        results = {
            "query": query,
            "timestamp": datetime.now().isoformat(),
            "sources": {},
            "all_results": [],
        }

        # Search all sources
        results["sources"]["sketchfab"] = self._search_sketchfab(query)
        results["sources"]["google"] = self._search_google(query)
        results["sources"]["databases"] = self._search_model_databases(query)

        # Combine and sort results
        for source in results["sources"].values():
            results["all_results"].extend(source)

        results["all_results"] = sorted(
            results["all_results"],
            key=lambda x: x.get("score", 0),
            reverse=True
        )

        # Cache results
        self._set_cache(cache_key, results)
        self.logger.info(f"Found {len(results['all_results'])} models")

        return results

    def _search_sketchfab(self, query: str) -> list:
        """Search Sketchfab API."""
        url = f"https://api.sketchfab.com/v3/search?type=models&q={urllib.parse.quote(query)}&downloadable=true&sort_by=-likeCount&count={self.config.sketchfab_limit}"

        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=self.config.timeout) as response:
                data = json.loads(response.read().decode())
                return [{
                    "source": "sketchfab",
                    "name": item.get("name"),
                    "uid": item.get("uid"),
                    "url": f"https://sketchfab.com/3d-models/{item.get('name', 'model').replace(' ', '-')}-{item.get('uid')}",
                    "likes": item.get("likeCount", 0),
                    "downloadable": item.get("isDownloadable", False),
                    "score": item.get("likeCount", 0),
                } for item in data.get("results", [])]
        except Exception as e:
            self.logger.warning(f"Sketchfab search failed: {e}")
            return []

    def _search_google(self, query: str) -> list:
        """Search Google for models."""
        url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}+3d+model+download+free+glb+site:thingiverse.com"
        results = []

        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=self.config.timeout) as response:
                html = response.read().decode()
                matches = re.findall(r'href="(https://thingiverse\.com/thing:[0-9]+[^"]*)', html)
                for url in list(set(matches))[:self.config.google_limit]:
                    results.append({
                        "source": "thingiverse",
                        "name": f"{query.title()} Model",
                        "url": url,
                        "score": 50,
                    })
        except Exception as e:
            self.logger.warning(f"Google search failed: {e}")

        return results

    def _search_model_databases(self, query: str) -> list:
        """Search Poly Pizza."""
        results = []

        try:
            url = f"https://poly.pizza/api/search?q={urllib.parse.quote(query)}&limit={self.config.poly_pizza_limit}"
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=self.config.timeout) as response:
                data = json.loads(response.read().decode())
                for item in data.get("data", [])[:self.config.poly_pizza_limit]:
                    results.append({
                        "source": "poly_pizza",
                        "name": item.get("name", "Model"),
                        "url": f"https://poly.pizza/model/{item.get('slug', '')}",
                        "score": 40,
                    })
        except Exception as e:
            self.logger.warning(f"Poly Pizza search failed: {e}")

        return results

    def search_textures(self, query: str) -> list:
        """Search for textures online."""
        self.logger.info(f"Searching for textures: {query}")
        results = []

        # Try Poly Haven
        try:
            url = f"https://api.polyhaven.com/assets?t=textures&s={urllib.parse.quote(query)}"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=self.config.timeout) as response:
                data = json.loads(response.read().decode())
                for name in list(data.keys())[:5]:
                    results.append({
                        "source": "poly_haven",
                        "name": name,
                        "url": f"https://polyhaven.com/textures/{name}",
                        "score": 80,
                    })
        except Exception as e:
            self.logger.warning(f"Poly Haven search failed: {e}")

        return results


# ==============================================================================
# Model Builders
# ==============================================================================

#: Blender snippet appended to a build script: prints object + scene bounds as JSON.
BOUNDS_SNIPPET = """
import bpy, json
from mathutils import Vector
bpy.context.view_layer.update()  # flush scale/location edits into matrix_world
_objs = []
for o in bpy.data.objects:
    if o.type == 'MESH':
        corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
        xs = [v.x for v in corners]; ys = [v.y for v in corners]; zs = [v.z for v in corners]
        _objs.append({"name": o.name, "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]})
_all_min = [min(o["min"][i] for o in _objs) for i in range(3)] if _objs else [0, 0, 0]
_all_max = [max(o["max"][i] for o in _objs) for i in range(3)] if _objs else [0, 0, 0]
print("BLENDER_BOUNDS_JSON:" + json.dumps({"objects": _objs, "scene_min": _all_min, "scene_max": _all_max, "scene_size": [_all_max[i] - _all_min[i] for i in range(3)]}))
"""


def parse_bounds_json(stdout: str) -> dict | None:
    """Parse the BOUNDS_SNIPPET JSON line out of Blender's stdout."""
    for line in stdout.splitlines():
        if line.startswith("BLENDER_BOUNDS_JSON:"):
            try:
                return json.loads(line.split(":", 1)[1])
            except json.JSONDecodeError:
                return None
    return None


class ModelBuilder:
    """Handles 3D model generation."""

    def __init__(self, config: ServerConfig):
        self.config = config
        self.logger = get_logger("model")

    def run_blender_args(self, args: list, timeout: float | None = None) -> dict:
        """Run Blender with an arbitrary argument list.

        ``timeout`` overrides the configured timeout in seconds; renders
        pass a higher floor because EEVEE on software GL is slow
        (~1 min/view). Returns {"success": bool, "stdout": str, "error": str}.
        """
        try:
            result = subprocess.run(
                [self.config.blender.executable, *args],
                capture_output=True,
                text=True,
                timeout=timeout if timeout is not None else self.config.blender.timeout,
            )
            # Blender exits 0 even when the --python script raises: the
            # traceback goes to stderr and nothing is saved. A traceback in
            # stderr is a failure, whatever the exit code says — otherwise a
            # broken script reports success:true with no .blend (the v1.1.0
            # false-success class of bug).
            if result.returncode == 0 and "Traceback (most recent call last)" not in result.stderr:
                return {"success": True, "stdout": result.stdout}
            return {
                "success": False,
                "error": result.stderr or f"Process exited with code {result.returncode}",
                "stdout": result.stdout,
            }
        except subprocess.TimeoutExpired:
            self.logger.error("Blender execution timed out")
            return {"success": False, "error": "Execution timed out", "stdout": ""}
        except FileNotFoundError:
            self.logger.error("Blender executable not found")
            return {"success": False, "error": "Blender not found", "stdout": ""}

    def create_mesh(self, script: str) -> dict:
        """Execute Blender script and create model."""
        self.logger.info("Creating 3D model")

        output_path = self.config.paths.output_dir / f"model_{datetime.now().strftime('%Y%m%d_%H%M%S')}.blend"
        script += f'\nbpy.ops.wm.save_mainfile(filepath="{output_path}")'

        # Write script to temp file
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(script)
            script_path = f.name

        try:
            result = self.run_blender_args(["--background", "--python", script_path])

            if result["success"]:
                self.logger.info(f"Model saved to: {output_path}")
                # Open in Blender
                subprocess.Popen(
                    [self.config.blender.executable, str(output_path)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
                return {"success": True, "output": str(output_path), "stdout": result["stdout"][-2000:]}
            else:
                self.logger.error(f"Blender script failed: {result['error']}")
                return {"success": False, "error": result["error"], "stdout": result.get("stdout", "")[-2000:]}

        except Exception as e:
            self.logger.error(f"Model creation failed: {e}")
            return {"success": False, "error": str(e)}
        finally:
            try:
                os.unlink(script_path)
            except OSError:
                pass

    def create_mesh_with_report(self, script: str) -> dict:
        """Like create_mesh, but also returns object names + bounding boxes.

        The bounds are parsed from the BOUNDS_SNIPPET line Blender prints.
        Used by build_from_spec: the caller needs numbers, not just exit 0.
        """
        self.logger.info("Creating 3D model (with bounds report)")

        output_path = self.config.paths.output_dir / f"model_{datetime.now().strftime('%Y%m%d_%H%M%S')}.blend"
        full_script = script + "\n" + BOUNDS_SNIPPET + f'\nbpy.ops.wm.save_mainfile(filepath="{output_path}")'

        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(full_script)
            script_path = f.name

        try:
            result = self.run_blender_args(["--background", "--python", script_path])
            if not result["success"]:
                return {"success": False, "error": result["error"], "stdout": result.get("stdout", "")[-2000:]}
            bounds = parse_bounds_json(result.get("stdout", ""))
            if bounds is None:
                return {
                    "success": False,
                    "output": str(output_path),
                    "error": "Blender ran but reported no object bounds (no meshes created?)",
                    "stdout": result.get("stdout", "")[-2000:],
                }
            return {
                "success": True,
                "output": str(output_path),
                "stdout": result.get("stdout", "")[-2000:],
                "objects": bounds["objects"],
                "scene_min": bounds["scene_min"],
                "scene_max": bounds["scene_max"],
                "min_z": bounds["scene_min"][2],
            }
        except Exception as e:
            self.logger.error(f"Model creation failed: {e}")
            return {"success": False, "error": str(e)}
        finally:
            try:
                os.unlink(script_path)
            except OSError:
                pass

    def render_model(self, blend_path: str, output_prefix: str, views: list, options: dict | None = None) -> dict:
        """Render a saved .blend with the presentation preset (see render.py).

        Every PNG is verified to exist on disk and be non-empty before
        success is reported — a missing/empty PNG is success:false.
        ``output_prefix`` is a file path prefix; each view renders to
        ``<prefix>_<view>.png`` (a trailing .png/.blend extension is stripped).
        ``options``: engine ('EEVEE'|'CYCLES'), samples, view_transform,
        lens, transparent, turntable_frames, resolution, hdri_path.
        """
        options = options or {}
        blend = Path(blend_path)
        if not blend.exists():
            return {"success": False, "error": f"Blend file not found: {blend_path}"}
        try:
            script = build_render_script(views, options)
        except ValueError as e:
            return {"success": False, "error": str(e)}
        prefix = re.sub(r"\.(png|blend)$", "", output_prefix, flags=re.IGNORECASE)
        out_dir = Path(prefix).parent
        if str(out_dir):
            out_dir.mkdir(parents=True, exist_ok=True)

        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(script)
            script_path = f.name
        try:
            # Renders are slow on software GL (~1 min/view at 960x720); Cycles
            # on CPU is slower still — give them at least 600 s (EEVEE) or
            # 1800 s (Cycles) no matter what the build timeout is.
            result = self.run_blender_args(
                ["--background", str(blend), "--python", script_path, "--", prefix, *views],
                timeout=max(self.config.blender.timeout, 1800 if options.get("engine") == "CYCLES" else 600),
            )
            if not result["success"]:
                self.logger.error(f"Render failed: {result['error']}")
                return {"success": False, "error": result["error"], "stdout": result.get("stdout", "")[-2000:]}
            # The script prints RENDER_DONE_JSON with every render it wrote
            # (views + turntable frames). Trust that list — rebuilding it
            # from `views` alone silently dropped the turntable frames
            # (they were rendered to disk but never reported).
            listed: list = []
            m = re.search(r"RENDER_DONE_JSON:(\{.*\})", result.get("stdout", "") or "")
            if m:
                try:
                    listed = json.loads(m.group(1)).get("renders", []) or []
                except (json.JSONDecodeError, AttributeError):
                    listed = []
            to_check = listed if listed else [
                {"view": v, "path": f"{prefix}_{v}.png"} for v in views
            ]
            renders = []
            for entry in to_check:
                png_path = Path(entry["path"])
                if not png_path.exists():
                    return {
                        "success": False,
                        "error": f"Render failed: {png_path} was not written by Blender",
                        "stdout": result.get("stdout", "")[-2000:],
                    }
                size = png_path.stat().st_size
                if size == 0:
                    return {
                        "success": False,
                        "error": f"Render failed: {png_path} is empty (0 bytes)",
                        "stdout": result.get("stdout", "")[-2000:],
                    }
                renders.append({"view": entry["view"], "path": str(png_path), "size_bytes": size})
            return {"success": True, "output": str(blend), "renders": renders,
                    "stdout": result.get("stdout", "")[-2000:]}
        finally:
            try:
                os.unlink(script_path)
            except OSError:
                pass


# ==============================================================================
# MCP Server
# ==============================================================================

class BlenderMCPServer:
    """Main MCP Server class."""

    def __init__(self, config: ServerConfig = None):
        self.config = config or default_config
        self.logger = setup_logging(
            self.config.paths.log_dir,
            debug=self.config.debug
        )
        self.logger.info(f"Starting Blender MCP Server v{self.config.version}")

        # Initialize services
        self.search_service = SearchService(self.config)
        self.model_builder = ModelBuilder(self.config)

        # Create MCP server
        self.app = Server(self.config.name)
        self._register_handlers()

    def _register_handlers(self):
        """Register tool handlers."""
        self.app.list_tools_handler(lambda: self._list_tools())
        self.app.call_tool_handler(self._call_tool)

    def _list_tools(self) -> list[Tool]:
        """List available tools."""
        return [
            Tool(
                name="research_model",
                description=(
                    "RESEARCH FIRST: Research a model before any code is written. "
                    "Runs the model/texture search and returns top references "
                    "(name, source, url) plus the part-breakdown schema. PREFER A "
                    "REAL ASSET OVER PRIMITIVES: if a Poly Haven / Sketchfab / "
                    "Poly Pizza asset in the results fits the request, the result "
                    "names it as recommended_path — import it with import_from_url "
                    "instead of modelling from primitives. Optional reference_image "
                    "(local path or URL): with a generation key (MESHY_API_KEY / "
                    "TRIPO_API_KEY) it drives image-to-3D via generate_3d (route A); "
                    "without one it is the visual reference the spec is built from — "
                    "parts, proportions, colours, materials recorded in the spec "
                    "(route B). Use the references to work out the real parts and "
                    "dimensions, then produce a JSON scene spec and call "
                    "build_from_spec. No code is written before this step."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What to model, e.g. 'Bajaj auto rickshaw' or 'Indian thali'"},
                        "reference_image": {"type": "string", "description": "Optional reference image: local file path or public URL. With a generation key it drives image-to-3D; without one it is the visual reference for the spec."},
                    },
                    "required": ["query"],
                },
            ),
            Tool(
                name="build_from_spec",
                description=(
                    "BUILD FROM SPEC: Build a scene from a JSON scene spec "
                    "{objects: [{name, kind, size_m, position_m, rotation_deg, "
                    "material, attach}]}. Conventions: position_m is the "
                    "BOTTOM-CENTRE of the object, sizes in metres, Z-up, ground "
                    "z = 0; kind is cube/sphere/cylinder/cone/torus; attach is a "
                    "mate (grounded, on_top_of:<name>, centred_on:<name>) solved "
                    "from the parent bounding box. The spec is validated first "
                    "(sizes > 0, z >= 0, inside a 10 m work area, mates must "
                    "touch within 0.05 m); on failure the exact failed checks "
                    "are returned and nothing is built. On success returns "
                    "object names, bounding boxes and min z."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "spec": {"description": "Scene spec object, or a JSON string of one"},
                    },
                    "required": ["spec"],
                },
            ),
            Tool(
                name="render_model",
                description=(
                    "RENDER / LOOK: Render a saved .blend with the presentation "
                    "preset (camera auto-framed on the bounding-box centre, "
                    "3-point + rim area-light rig, sun + world light, ground "
                    "plane) as PNGs, one per view. Engine EEVEE (default, fast "
                    "previews) or CYCLES (final stills: CPU path tracer, 128-256 "
                    "samples + OpenImageDenoise, Khronos PBR Neutral for catalogue "
                    "shots / AgX for hero shots). Optional studio HDRI via hdri "
                    "'polyhaven:<slug>' (CC0, verified licence; falls back to "
                    "world+sun if the download fails), transparent-background "
                    "product shots (Cycles Shadow Catcher + Film Transparent; "
                    "EEVEE has no shadow catcher), turntable_frames (extra orbit "
                    "frames, exactly 360 deg about Z). Lens: 50 mm default, "
                    "85 mm hero, 90-105 mm macro. Every PNG is verified to exist "
                    "on disk and be non-empty before success is reported — a "
                    "missing/empty PNG returns success:false, never success:true. "
                    "Returns the PNG paths and file sizes."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "blend_path": {"type": "string", "description": "Path to the .blend file to render"},
                        "output_path": {"type": "string", "description": "Output file prefix; each view renders to <prefix>_<view>.png"},
                        "views": {"type": "array", "items": {"type": "string"}, "description": "Views to render (default [\"front\",\"side\",\"perspective\"]); allowed: front, side, back, top, perspective"},
                        "engine": {"type": "string", "description": "EEVEE (default) or CYCLES (final stills)"},
                        "samples": {"type": "number", "description": "Cycles samples; default 128 (keep 128-256 on CPU)"},
                        "view_transform": {"type": "string", "description": "Khronos PBR Neutral (catalogue) or AgX (hero)"},
                        "lens": {"type": "number", "description": "Camera lens in mm; 50 default, 85 hero, 90-105 macro"},
                        "fill_fraction": {"type": "number", "description": "Fraction of the frame the subject fills on its binding axis; default 0.7 (exact fill-based framing — the old distance heuristic rendered small products tiny)"},
                        "transparent": {"type": "boolean", "description": "Transparent background product shot (Cycles shadow catcher)"},
                        "turntable_frames": {"type": "number", "description": "Extra orbit frames (0 = off); renders <prefix>_turntable_<nn>.png"},
                        "resolution": {"type": "array", "items": {"type": "number"}, "description": "Resolution [width, height]; default EEVEE [960,720], Cycles [1280,720]"},
                        "hdri": {"type": "string", "description": "Studio HDRI: 'polyhaven:<slug>' (CC0, auto-downloaded) or a local .hdr/.exr path. Empty = world+sun fallback."},
                    },
                    "required": ["blend_path", "output_path"],
                },
            ),
            Tool(
                name="generate_3d",
                description=(
                    "AI GENERATION (Meshy first, Tripo second): generate a textured "
                    "3D model from a text prompt or a reference image, then import "
                    "it normalised (longest side = target_size, origin at bottom, "
                    "min z = 0). Needs the user's own API key from env var "
                    "MESHY_API_KEY (Meshy) or TRIPO_API_KEY (Tripo) — never baked "
                    "into source. NO KEY = the tool says so honestly and points at "
                    "the free local path (research_model -> build_from_spec / "
                    "execute_blender_code); it never fails silently and never "
                    "invents a model. Meshy text-to-3D is two billed steps (preview "
                    "20 credits + refine 10 = 30 for a textured model; "
                    "texture:false stops after the mesh-only preview); Meshy "
                    "image-to-3D is 30 credits; assets are kept only 3 days so the "
                    "GLB is downloaded immediately. Tripo: text $0.20 / image $0.30 "
                    "textured; its GLB URL expires in 5 minutes so it is downloaded "
                    "inside the poll loop. No provider states a GLB up-axis — "
                    "orientation/scale are verified in Blender on import. "
                    "Hunyuan3D / Rodin are not implemented (see README)."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "prompt": {"type": "string", "description": "Text prompt (text mode). Meshy max 800 chars, Tripo max 1024."},
                        "image_url": {"type": "string", "description": "Image mode: public image URL (Meshy also accepts a data URI here)."},
                        "image_base64": {"type": "string", "description": "Image mode (Meshy only): raw base64 image data, or a data:image/...;base64,... URI."},
                        "provider": {"type": "string", "description": "meshy (default) or tripo"},
                        "texture": {"type": "boolean", "description": "Textured model (default true). Meshy text mode with texture:false stops after the mesh-only preview draft."},
                        "target_size": {"type": "number", "description": "Longest side in metres after import normalisation; default 1.0"},
                        "target_polycount": {"type": "number", "description": "Meshy target polycount, 100-300000, default 30000"},
                        "timeout_seconds": {"type": "number", "description": "Poll budget in seconds; default 600. A timeout does NOT cancel the provider task — keep the task_id and poll again."},
                    },
                    "required": [],
                },
            ),
            Tool(
                name="retrieve_asset",
                description=(
                    "FREE REAL-ASSET RETRIEVAL: try a real model before building "
                    "from primitives. Searches Poly Haven (CC0, no key, direct "
                    "downloads) by product or query and downloads the 1k glTF "
                    "package into the asset cache. Known good: smartwatch -> "
                    "Poly Haven 'digital_wrist_watch' (vintage digital watch, "
                    "CC0). Poly Pizza search needs the user's own "
                    "POLY_PIZZA_API_KEY env var (its search endpoint returns "
                    "HTTP 401 without a key since 2026-11-08) — without one the "
                    "tool says so honestly and Poly Haven is searched instead. "
                    "No account is ever created. Assets are never committed to "
                    "the repo (binary files cannot go through snapshot-push). "
                    "On success returns the glTF path + licence + source URL; "
                    "import it with build_product (source 'retrieved') or "
                    "import_from_url. On failure it says exactly why — use "
                    "build_product (procedural) instead of a wrong asset."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "product": {"type": "string", "description": "Product with a known good asset, e.g. 'smartwatch'"},
                        "query": {"type": "string", "description": "Free-text search, e.g. 'headphones' (Poly Haven catalogue)"},
                        "source": {"type": "string", "description": "polyhaven (default) or poly_pizza (needs POLY_PIZZA_API_KEY)"},
                        "resolution": {"type": "string", "description": "Download resolution; default '1k'"},
                    },
                    "required": [],
                },
            ),
            Tool(
                name="build_product",
                description=(
                    "PROPER PRODUCT BUILD: build one of the catalogue products "
                    "with real curves, not stacked primitives — headphones "
                    "(arched band + padded cups), sneaker (lofted sole with "
                    "toe spring + bezier laces through eyelets), perfume "
                    "(bevelled glass, seated gold cap, NOIR label), smartwatch "
                    "(bevelled case, real dial with markers + hands, curved "
                    "strap). Source 'auto' (default) prefers a retrieved real "
                    "asset for products that have one (smartwatch -> Poly "
                    "Haven CC0 digital watch) and falls back to the procedural "
                    "builder with a note; 'procedural' forces the builder; "
                    "'retrieved' fails if no asset is available. Returns the "
                    "saved .blend path, object names, bounding boxes and min z."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "product": {"type": "string", "description": "Product to build: headphones, sneaker, perfume, smartwatch"},
                        "source": {"type": "string", "description": "auto (default), procedural, or retrieved"},
                        "target_size": {"type": "number", "description": "Retrieved assets only: longest side in metres after normalisation; default 0.22"},
                    },
                    "required": ["product"],
                },
            ),
            Tool(
                name="add_detail",
                description=(
                    "DETAIL HELPERS: apply one manufactured detail to a target "
                    "object in a saved .blend (or the current build): "
                    + "; ".join(f"{d['kind']} ({d['description']})" for d in DETAIL_TYPES)
                    + " Details are real geometry/modifiers, not descriptions — "
                    "they run in Blender 4.2.0. Use after the base build, before "
                    "the final render; combine several calls for a manufactured "
                    "look (bevel + panel lines + screws + label)."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "detail": {"type": "string", "description": "Detail kind: bevel, subdivision, panel_line, screw, bolt, seam, grille, label"},
                        "target": {"type": "string", "description": "Object name (substring match) to apply the detail to"},
                        "params": {"type": "object", "description": "Detail parameters (see the tool description for each kind)"},
                        "blend_path": {"type": "string", "description": "Optional .blend file to open first; without it the detail is applied to an empty scene and fails"},
                    },
                    "required": ["detail", "target"],
                },
            ),
            Tool(
                name="critique_model",
                description=(
                    "VISION CRITIQUE LOOP: render 5 views of a saved .blend "
                    "(front 3/4, side, back, top, close-up), run programmatic "
                    "checks (PNG exists and decodes, every spec part present, "
                    "min z >= 0, parts connected/grounded, dimensions vs spec), "
                    "and return the views plus a structured critique prompt. "
                    "HONEST LIMIT: this MCP cannot see images — YOU, the calling "
                    "model, are the critic: look at the rendered PNGs and fill in "
                    "the per-spec-item pass/fail, problem->fix pairs (concrete "
                    "operations on named parts), 8-dimension scores and the dual "
                    "Yes/No gate from the prompt template. Then apply fixes as "
                    "LOCALISED EDITS (add_detail / execute_blender_code on the same "
                    "build, never a rebuild), re-render, and verify per fix "
                    "(applied / not applied / regressed). Max 3 auto-refine rounds; "
                    "keep the best render + code and REVERT if a round makes things "
                    "worse. refine_round tracks the round (1-3)."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "blend_path": {"type": "string", "description": "Path to the .blend file to critique"},
                        "spec": {"type": "object", "description": "Optional scene spec {objects: [{name, size_m, material}]} — the contract the critique checks against"},
                        "output_path": {"type": "string", "description": "Render output prefix; defaults to <blend>_critique"},
                        "refine_round": {"type": "number", "description": "Auto-refine round number, 1-3 (default 1)"},
                        "engine": {"type": "string", "description": "Render engine for the critique views: EEVEE (default, fast) or CYCLES"},
                    },
                    "required": ["blend_path"],
                },
            ),
            Tool(
                name="create_complex_model",
                description="CREATE: Build complex 3D models with internet search + detailed planning. Built-in templates only: temples, vehicles, food, buildings, characters. For anything else use execute_blender_code.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "description": {"type": "string", "description": "What to create (e.g., 'Indian temple', 'auto-rickshaw', 'thali', 'haveli palace')"},
                        "customization": {"type": "string", "description": "Customize: colors (red, blue, gold), materials, scale"},
                    },
                    "required": ["description"],
                },
            ),
            Tool(
                name="execute_blender_code",
                description=(
                    "CODE: Run arbitrary Blender Python (bpy) code in a headless Blender "
                    "and save the resulting scene. Use this for ANY model that is not one "
                    "of the five built-in templates (temple/mandir, auto-rickshaw/vehicle, "
                    "thali/food, haveli/palace/building, person/human/character). Write "
                    "Z-up code: Z is height, ground is z = 0, all dimensions in metres, "
                    "every part's lowest point at z >= 0. The script runs in a fresh empty "
                    "scene; the result includes Blender's stdout/stderr and the output "
                    ".blend path. Fix errors from the returned stderr and call again."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "code": {"type": "string", "description": "Blender Python code using bpy (imports bpy itself if needed)"},
                    },
                    "required": ["code"],
                },
            ),
            Tool(
                name="modify_model",
                description="MODIFY: Change existing 3D model - colors, materials, scale, rotation, effects.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "existing_model": {"type": "string", "description": "Path to existing .blend file"},
                        "modifications": {"type": "string", "description": "Changes: 'make red', 'add gold', 'scale up', 'rotate', 'make shiny'"},
                    },
                    "required": ["modifications"],
                },
            ),
            Tool(
                name="apply_texture",
                description="TEXTURE: Search and apply textures to 3D models.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "texture_type": {"type": "string", "description": "Texture type: wood, marble, stone, metal, gold, brass, tile, or polyhaven:<slug> for a real Poly Haven texture"},
                        "object_name": {"type": "string", "description": "Object to apply texture to"},
                        "blend_path": {"type": "string", "description": "Optional .blend file to open first; without it the material is created but applied to nothing"},
                    },
                    "required": ["texture_type"],
                },
            ),
            Tool(
                name="search_models",
                description="SEARCH: Search the internet for 3D models.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What to search for"},
                    },
                    "required": ["query"],
                },
            ),
            Tool(
                name="search_textures",
                description="SEARCH TEXTURES: Search for free textures online.",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What texture to find"},
                    },
                    "required": ["query"],
                },
            ),
            Tool(
                name="get_scene_info",
                description="Get current scene information",
                inputSchema={"type": "object", "properties": {}},
            ),
            Tool(
                name="import_from_url",
                description="Import 3D model from URL",
                inputSchema={
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "URL to 3D model file"},
                        "name": {"type": "string", "description": "Model name"},
                    },
                    "required": ["url"],
                },
            ),
        ]

    async def _call_tool(self, name: str, arguments: dict | None) -> list[TextContent]:
        """Handle tool calls."""
        if arguments is None:
            arguments = {}

        try:
            result = await self._execute_tool(name, arguments)
        except Exception as e:
            self.logger.error(f"Tool execution failed: {e}")
            result = {"success": False, "error": str(e)}

        return [TextContent(type="text", text=json.dumps(result, indent=2))]

    async def _execute_tool(self, name: str, arguments: dict) -> dict:
        """Execute specific tool."""
        if name == "research_model":
            return await self._research_model(arguments)

        elif name == "build_from_spec":
            return await self._build_from_spec(arguments)

        elif name == "render_model":
            return await self._render_model(arguments)

        elif name == "generate_3d":
            return await self._generate_3d(arguments)

        elif name == "retrieve_asset":
            return await self._retrieve_asset(arguments)

        elif name == "build_product":
            return await self._build_product(arguments)

        elif name == "add_detail":
            return await self._add_detail(arguments)

        elif name == "critique_model":
            return await self._critique_model(arguments)

        elif name == "search_models":
            return self.search_service.search_models(arguments.get("query", ""))

        elif name == "search_textures":
            results = self.search_service.search_textures(arguments.get("query", ""))
            return {"success": True, "found": len(results), "results": results}

        elif name == "create_complex_model":
            return await self._create_model(arguments)

        elif name == "execute_blender_code":
            return await self._execute_blender_code(arguments)

        elif name == "modify_model":
            return await self._modify_model(arguments)

        elif name == "apply_texture":
            return await self._apply_texture(arguments)

        elif name == "import_from_url":
            return await self._import_from_url(arguments)

        elif name == "get_scene_info":
            return await self._get_scene_info()

        return {"success": False, "error": f"Unknown tool: {name}"}

    async def _research_model(self, args: dict) -> dict:
        """Research a model before any code is written."""
        query = args.get("query", "")
        if not query.strip():
            return {"success": False, "error": "No query supplied."}
        self.logger.info(f"Researching model: {query}")
        model_results = self.search_service.search_models(query)
        texture_results = self.search_service.search_textures(query)
        references = [
            {"name": r.get("name"), "source": r.get("source"), "url": r.get("url")}
            for r in model_results.get("all_results", [])[:8]
        ]
        texture_references = [
            {"name": r.get("name"), "source": r.get("source"), "url": r.get("url")}
            for r in texture_results[:5]
        ]
        # Prefer a real asset over primitives: a fitting Poly Haven /
        # Sketchfab / Poly Pizza asset is the recommended path.
        all_results = model_results.get("all_results", [])
        asset_candidate = next(
            (r for r in all_results if r.get("source") in ("poly_pizza", "sketchfab")),
            None,
        ) or next((r for r in texture_references if r.get("source") == "poly_haven"), None)
        if asset_candidate:
            recommended_path = {
                "kind": "import_asset",
                "reason": "A real asset beats modelling from primitives — import this first with import_from_url and check it against the spec before building anything by hand.",
                "name": asset_candidate.get("name"),
                "source": asset_candidate.get("source"),
                "url": asset_candidate.get("url"),
            }
        else:
            recommended_path = {
                "kind": "model_from_primitives",
                "reason": "No fitting real asset was found in the search results, so build from a spec (research_model -> build_from_spec / execute_blender_code).",
            }

        # Reference image: route A (image-to-3D) needs a generation key,
        # route B (reference-as-spec) works without one.
        reference_image = args.get("reference_image", "") or ""
        reference = None
        if reference_image:
            is_url = reference_image.startswith("http://") or reference_image.startswith("https://")
            exists = None if is_url else Path(reference_image).exists()
            generation_available = bool(os.environ.get("MESHY_API_KEY") or os.environ.get("TRIPO_API_KEY"))
            reference = {
                "input": reference_image,
                "kind": "url" if is_url else "local_path",
                "exists": exists,
                "route": (
                    "A (image-to-3D): a generation key is configured — call generate_3d with image_url / image_base64 to import a neural mesh, then critique it."
                    if generation_available
                    else "B (reference-as-spec): no generation key is configured — extract the spec below FROM THE IMAGE (the calling model looks at it) and build procedurally; do not call generate_3d, it will report no key."
                ),
                "reference_spec_brief": {
                    "description": "Look at the reference image and record: parts list with semantic names and parent/child relations; proportions as RATIOS (e.g. canopy width ~ 0.6x body width) and bounding-box fractions, not absolute guesses; palette as 3-5 dominant hex colours with which part each belongs to; per-part material feel (matte / glossy / metallic / transparent + roughness); and what the reference does NOT show (back, underside) flagged as 'to be invented plausibly', so the critic does not penalise the builder for it. This spec becomes the builder brief AND the critic checklist (critique_model).",
                    "fields": ["parts", "proportions_ratios", "palette_hex", "materials", "unseen_sides"],
                },
            }
            if not is_url and not exists:
                reference["warning"] = f"Local file not found: {reference_image}. Check the path and call again."
        return {
            "success": True,
            "query": query,
            "references": references,
            "texture_references": texture_references,
            "recommended_path": recommended_path,
            **({"reference_image": reference} if reference else {}),
            "part_breakdown_schema": {
                "description": "Break the subject into named parts with REAL dimensions (metres) before building. One entry per part.",
                "objects": [
                    {
                        "name": "PartName",
                        "kind": "cube | sphere | cylinder | cone | torus",
                        "size_m": [0.5, 0.5, 0.5],
                        "position_m": [0, 0, 0],
                        "rotation_deg": [0, 0, 0],
                        "material": "wood | marble | metal | fabric | steel | glass | skin | sandstone | ...",
                        "attach": "grounded | on_top_of:<ParentName> | centred_on:<ParentName>",
                    }
                ],
            },
            "spec_rules": [
                "position_m is the BOTTOM-CENTRE of the object; sizes in metres; Z is up; ground is z = 0.",
                "Every size must be > 0; every position.z must be >= 0.",
                "Bounding boxes must stay inside a 10 m work area (|x|, |y| <= 5, z <= 10).",
                "attach mates are solved from the parent bounding box, never guessed: on_top_of:<name> means the part sits on the parent and must touch it within 0.05 m.",
                "Use the references above for real proportions; do not invent dimensions.",
            ],
            "next_step": (
                "Produce a JSON scene spec in the schema above (from the references "
                "and real dimensions) and call build_from_spec with it. No code is "
                "written before this step."
            ),
        }

    async def _build_from_spec(self, args: dict) -> dict:
        """Validate a scene spec, then build it and report bounding boxes."""
        spec = args.get("spec")
        if spec is None or spec == "":
            return {
                "success": False,
                "error": "No spec supplied. Call research_model first, then pass a scene spec object (or JSON string).",
            }
        parsed, parse_error = parse_spec(spec)
        if parse_error:
            return {"success": False, "errors": [parse_error], "error": f"Spec validation failed: {parse_error}"}
        errors = validate_spec(parsed)
        if errors:
            return {"success": False, "errors": errors, "error": f"Spec validation failed: {'; '.join(errors)}"}
        script, build_errors = build_from_spec(parsed)
        if script is None:
            return {"success": False, "errors": build_errors, "error": f"Spec validation failed: {'; '.join(build_errors)}"}
        result = self.model_builder.create_mesh_with_report(script)
        return {
            "success": result.get("success", False),
            "output": result.get("output", ""),
            "objects": result.get("objects", []),
            "scene_min": result.get("scene_min", []),
            "scene_max": result.get("scene_max", []),
            "min_z": result.get("min_z"),
            "stdout": result.get("stdout", ""),
            "error": result.get("error", ""),
        }

    def _download_polyhaven_hdri(self, slug):
        """Download a Poly Haven studio HDRI (CC0 — licence verified at
        polyhaven.com/license on 2026-11-07). Returns (path, reason):
        path is None on failure (caller falls back to world+sun)."""
        hdri_dir = self.config.paths.texture_dir / "hdri"
        hdri_dir.mkdir(parents=True, exist_ok=True)
        try:
            req = urllib.request.Request(
                f"{POLYHAVEN_API}/files/{urllib.parse.quote(slug)}",
                headers={"User-Agent": POLYHAVEN_USER_AGENT},
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                files = json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            return None, f"Poly Haven: no HDRI named '{slug}' (HTTP {e.code})."
        except Exception as e:
            return None, f"Poly Haven API unreachable: {e}."
        # /files/<slug> nests resolutions under a key like "hdri": pick a 1k
        # .hdr first, then 2k .hdr, then any .exr. Defensive walk: any
        # nested {url} ending in .hdr/.exr qualifies.
        candidates = []

        def walk(node, depth, res_key):
            if not isinstance(node, dict) or depth > 4:
                return
            for key, value in node.items():
                if isinstance(value, dict) and isinstance(value.get("url"), str):
                    url = value["url"]
                    low = url.lower()
                    if ".hdr" in low or ".exr" in low:
                        # Prefer 1k, then 2k, then larger; .hdr over .exr.
                        res_score = {"1k": 0, "2k": 1, "4k": 2, "8k": 3}.get(res_key, 4)
                        score = res_score + (0 if ".hdr" in low else 10)
                        candidates.append((score, url))
                else:
                    walk(value, depth + 1, key if re.match(r"^\d+k$", key) else res_key)

        walk(files, 0, "")
        if not candidates:
            return None, f"Poly Haven: no .hdr/.exr file found for HDRI '{slug}'."
        candidates.sort(key=lambda c: c[0])
        url = candidates[0][1]
        ext = "hdr" if ".hdr" in url.lower() else "exr"
        local_path = hdri_dir / f"{slug}.{ext}"
        if local_path.exists():
            return str(local_path), None
        try:
            req = urllib.request.Request(url, headers={"User-Agent": POLYHAVEN_USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as response:
                data = response.read()
            if len(data) > 100 * 1024 * 1024:
                return None, "Poly Haven HDRI exceeds the 100 MB download cap."
            local_path.write_bytes(data)
            return str(local_path), None
        except Exception as e:
            return None, f"Poly Haven HDRI download failed: {e}."

    async def _render_model(self, args: dict) -> dict:
        """Render a saved .blend with the presentation preset (verified PNGs)."""
        blend_path = args.get("blend_path", "")
        output_path = args.get("output_path", "")
        views = args.get("views") or ["front", "side", "perspective"]
        if not blend_path or not output_path:
            return {"success": False, "error": "blend_path and output_path are required."}
        options = {}
        if isinstance(args.get("engine"), str):
            options["engine"] = args["engine"]
        if isinstance(args.get("samples"), (int, float)):
            options["samples"] = args["samples"]
        if isinstance(args.get("view_transform"), str):
            options["view_transform"] = args["view_transform"]
        if isinstance(args.get("lens"), (int, float)):
            options["lens"] = args["lens"]
        if isinstance(args.get("fill_fraction"), (int, float)):
            options["fill_fraction"] = args["fill_fraction"]
        if isinstance(args.get("transparent"), bool):
            options["transparent"] = args["transparent"]
        if isinstance(args.get("turntable_frames"), (int, float)):
            options["turntable_frames"] = args["turntable_frames"]
        if isinstance(args.get("resolution"), list) and len(args["resolution"]) == 2:
            options["resolution"] = [int(args["resolution"][0]), int(args["resolution"][1])]
        hdri_fallback = None
        hdri = args.get("hdri", "") or ""
        if hdri.startswith("polyhaven:"):
            slug = hdri[len("polyhaven:"):].strip()
            if not slug:
                return {"success": False, "error": "HDRI needs a slug: polyhaven:<slug>."}
            path, reason = self._download_polyhaven_hdri(slug)
            if path:
                options["hdri_path"] = path
            else:
                hdri_fallback = reason
        elif hdri:
            if not Path(hdri).exists():
                return {"success": False, "error": f"HDRI file not found: {hdri}"}
            options["hdri_path"] = hdri
        result = self.model_builder.render_model(blend_path, output_path, list(views), options)
        result["engine"] = options.get("engine", "EEVEE")
        if hdri_fallback:
            result["hdri_fallback"] = hdri_fallback
        return result

    async def _generate_3d(self, args: dict) -> dict:
        """AI generation via Meshy / Tripo, then import + normalise."""
        provider = args.get("provider", "meshy") or "meshy"
        if provider not in ("meshy", "tripo"):
            return {"success": False, "error": f"Unknown provider '{provider}'. Available: meshy, tripo. (Hunyuan3D / Rodin are not implemented — see README.)"}
        mode = "image" if (args.get("image_url") or args.get("image_base64")) else "text"
        if mode == "text" and not (args.get("prompt") or "").strip():
            return {"success": False, "error": "generate_3d text mode needs a prompt; image mode needs image_url or image_base64."}
        opts = {
            "provider": provider,
            "mode": mode,
            "prompt": args.get("prompt") or None,
            "image_url": args.get("image_url") or None,
            "image_base64": args.get("image_base64") or None,
            "texture": args.get("texture", True) if isinstance(args.get("texture"), bool) else True,
            "target_size": args.get("target_size", 1.0) if isinstance(args.get("target_size"), (int, float)) else 1.0,
            "target_polycount": args.get("target_polycount") if isinstance(args.get("target_polycount"), (int, float)) else None,
            "timeout_seconds": args.get("timeout_seconds", 600) if isinstance(args.get("timeout_seconds"), (int, float)) else 600,
        }
        glb_name = f"generated_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        result = run_generate_3d(opts, self.config.paths.temp_dir, glb_name)
        if not result.get("success") or not result.get("glb_path"):
            return result  # no-key honest error, or a provider failure — nothing to import
        # Import the downloaded GLB via the existing import path and
        # normalise: longest side -> target_size, origin at bottom, min z = 0.
        name = re.sub(r"[^A-Za-z0-9_-]", "_", glb_name)
        output_path = self.config.paths.output_dir / f"{name}.blend"
        import_ops = {
            "glb": "bpy.ops.import_scene.gltf",
            "gltf": "bpy.ops.import_scene.gltf",
            "obj": "bpy.ops.import_scene.obj",
            "fbx": "bpy.ops.import_scene.fbx",
            "stl": "bpy.ops.import_mesh.stl",
        }
        script = self._build_import_script(result["glb_path"], import_ops["glb"], str(output_path), opts["target_size"])
        imported = self.model_builder.create_mesh(script)
        result["output"] = imported.get("output", str(output_path))
        result["import_success"] = imported.get("success", False)
        result["import_error"] = imported.get("error", "")
        result["note"] = "Orientation/scale were verified in Blender on import (longest side = target_size, min z = 0). No provider states a GLB up-axis, so check the render before trusting the orientation."
        return result

    async def _retrieve_asset(self, args: dict) -> dict:
        """Free real-asset retrieval (Poly Haven CC0, no key)."""
        cache_dir = self.config.paths.texture_dir / "retrieved_assets"
        cache_dir.mkdir(parents=True, exist_ok=True)
        opts = {
            "product": args.get("product") or None,
            "query": args.get("query") or None,
            "source": args.get("source", "polyhaven") or "polyhaven",
            "resolution": args.get("resolution", "1k") or "1k",
        }
        return retrieve_asset(opts, cache_dir)

    async def _build_product(self, args: dict) -> dict:
        """Build a catalogue product — retrieved real asset first, else
        the proper procedural builder (real curves, no stacked boxes)."""
        product = (args.get("product") or "").lower().strip()
        if product not in PRODUCTS:
            return {"success": False,
                    "error": f"Unknown product {product!r}. Known products: {', '.join(sorted(PRODUCTS))}."}
        source = (args.get("source") or "auto").lower().strip()
        if source not in ("auto", "procedural", "retrieved"):
            return {"success": False, "error": f"Unknown source '{source}'. Use auto, procedural or retrieved."}
        target_size = args.get("target_size", 0.22) if isinstance(args.get("target_size"), (int, float)) else 0.22
        info = PRODUCTS[product]

        # Retrieved path: products with a verified-good free asset.
        if source in ("auto", "retrieved") and info.get("source") == "retrieved-preferred":
            retrieved = await self._retrieve_asset({"product": product})
            if retrieved.get("success") and retrieved.get("asset", {}).get("gltf_path"):
                asset = retrieved["asset"]
                script = get_retrieved_product_script(asset["gltf_path"], target_size)
                result = self.model_builder.create_mesh_with_report(script)
                result["product"] = product
                result["source"] = "retrieved"
                result["asset"] = asset
                return result
            if source == "retrieved":
                return {"success": False, "product": product, "source": "retrieved",
                        "error": retrieved.get("error", "Retrieved asset unavailable."),
                        "note": "Call build_product with source 'procedural' for the fallback builder."}
            note = (f"Retrieved asset unavailable ({retrieved.get('error', 'unknown')}); "
                    "fell back to the procedural builder.")
        else:
            note = None

        script, error = get_product_script(product)
        if script is None:
            return {"success": False, "product": product, "error": error}
        result = self.model_builder.create_mesh_with_report(script)
        result["product"] = product
        result["source"] = "procedural"
        if note:
            result["note"] = note
        return result

    async def _add_detail(self, args: dict) -> dict:
        """Apply one manufactured detail to a target object."""
        detail = args.get("detail", "") or ""
        target = args.get("target", "") or ""
        params = args.get("params") or {}
        blend_path = args.get("blend_path", "") or ""
        if not detail or not target:
            return {"success": False, "error": "add_detail needs detail and target."}
        try:
            script = get_detail_script(detail, target, params)
        except ValueError as e:
            return {"success": False, "error": str(e)}
        if blend_path and not Path(blend_path).exists():
            return {"success": False, "error": f"Blend file not found: {blend_path}"}
        open_line = f"import bpy\nbpy.ops.wm.open_mainfile(filepath={json.dumps(blend_path)})\n" if blend_path else ""
        result = self.model_builder.create_mesh(open_line + script)
        result["detail"] = detail
        result["target"] = target
        result["params"] = params
        return result

    async def _critique_model(self, args: dict) -> dict:
        """Render 5 views + programmatic checks + structured critique prompt."""
        blend_path = args.get("blend_path", "") or ""
        if not blend_path:
            return {"success": False, "error": "blend_path is required."}
        if not Path(blend_path).exists():
            return {"success": False, "error": f"Blend file not found: {blend_path}"}
        refine_round = max(1, min(MAX_REFINE_ROUNDS, int(args.get("refine_round") or 1)))
        spec = args.get("spec") or {"objects": []}
        output_prefix = re.sub(
            r"\.(png|blend)$",
            "",
            args.get("output_path") or re.sub(r"\.blend$", "", blend_path, flags=re.IGNORECASE) + "_critique",
            flags=re.IGNORECASE,
        )
        engine = "CYCLES" if args.get("engine") == "CYCLES" else "EEVEE"

        # 1. Render the 5 critique views (front 3/4, side, back, top, close-up).
        views = ["perspective", "side", "back", "top", "front"]
        rendered = self.model_builder.render_model(blend_path, output_prefix, views, {"engine": engine})
        if not rendered.get("success"):
            return {"success": False, "error": f"Critique render failed: {rendered.get('error')}", "stdout": rendered.get("stdout", "")}

        # 2. Programmatic checks inside Blender (bounds, presence, dimensions, connectivity).
        checks = []
        check_error = ""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(build_critique_script(json.dumps(spec)))
            script_path = f.name
        try:
            result = self.model_builder.run_blender_args(
                ["--background", blend_path, "--python", script_path],
                timeout=max(self.config.blender.timeout, 120),
            )
            if not result.get("success"):
                check_error = result.get("error") or "critique checks failed to run"
            else:
                parsed = parse_critique_json(result.get("stdout", ""))
                checks = (parsed or {}).get("checks", [])
                if not checks:
                    check_error = "Blender ran but reported no critique checks."
        finally:
            try:
                os.unlink(script_path)
            except OSError:
                pass

        # 3. PNG decode checks (host-side): a PNG that exists but does not
        #    decode is a failure, not a render.
        for r in rendered.get("renders", []):
            decodes = png_decodes(r["path"])
            checks.append({
                "check": f"png_decodes:{r['view']}",
                "passed": decodes,
                "detail": f"{r['size_bytes']} bytes, valid PNG" if decodes else "PNG exists but does not decode",
            })
        if check_error:
            checks.append({"check": "programmatic_checks_ran", "passed": False, "detail": check_error})

        passed = all(c.get("passed") for c in checks)
        return {
            "success": True,
            "checks": checks,
            "passed": passed,
            "renders": rendered.get("renders", []),
            "critique_prompt": build_critique_prompt(spec, checks),
            "refine_round": refine_round,
            "max_rounds": MAX_REFINE_ROUNDS,
            "note": CRITIQUE_NOTE,
        }

    async def _create_model(self, args: dict) -> dict:
        """Create complex 3D model."""
        desc = args.get("description", "").lower()
        custom = args.get("customization", "")

        # Phase 1: Search
        self.logger.info(f"Phase 1: Searching for {desc}")
        search_results = self.search_service.search_models(desc)

        # Phase 2: Build model
        self.logger.info(f"Phase 2: Building model")
        script = self._generate_model_script(desc, custom)
        if script is None:
            return {
                "success": False,
                "description": args.get("description"),
                "customization": custom,
                "error": (
                    "No built-in template matches this description. The built-in "
                    "templates are: temple/mandir, auto-rickshaw/vehicle, thali/food, "
                    "haveli/palace/building, person/human/character. For anything else, "
                    "use the execute_blender_code tool with your own bpy code (Z-up, "
                    "dimensions in metres, ground at z = 0), or use search_models and "
                    "import_from_url to bring in an existing model."
                ),
            }
        result = self.model_builder.create_mesh(script)

        return {
            "success": result.get("success", False),
            "description": args.get("description"),
            "customization": custom,
            "phases": {
                "search": f"Found {len(search_results.get('all_results', []))} sources",
                "creation": "completed" if result.get("success") else "failed",
            },
            "output": result.get("output", ""),
        }

    def _generate_model_script(self, desc: str, custom: str) -> str | None:
        """Generate model creation script based on description.

        Returns None when no built-in template matches: callers must not
        fall back to a temple. Guide the LLM to execute_blender_code instead.
        """
        if any(w in desc for w in ["temple", "mandir"]):
            return self._generate_temple_script(custom)
        elif any(w in desc for w in ["auto", "rickshaw", "vehicle"]):
            return self._generate_rickshaw_script(custom)
        elif any(w in desc for w in ["thali", "food"]):
            return self._generate_thali_script(custom)
        elif any(w in desc for w in ["haveli", "palace", "building"]):
            return self._generate_building_script(custom)
        elif any(w in desc for w in ["person", "human", "character"]):
            return self._generate_character_script(custom)
        else:
            return None

    def _generate_temple_script(self, custom: str) -> str:
        """Generate Indian temple script. Z-up, metres, ground at z = 0."""
        color = "(0.95, 0.93, 0.9, 1)"
        if "red" in custom.lower():
            color = "(0.75, 0.25, 0.2, 1)"
        elif "sandstone" in custom.lower():
            color = "(0.85, 0.75, 0.6, 1)"

        return f'''
import bpy, math
from math import pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Adhishthana (Base) - 4 steps ascending in Z, top step at z = 0.6
for i in range(4):
    bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.075 + i * 0.15))
    base = bpy.context.active_object
    base.name = f"Adhisthana_{{i}}"
    base.scale = ((4.5 - i * 0.3) / 2, (3.5 - i * 0.2) / 2, 0.075)

# Garbhagriha (Main Sanctum) - 3.0 wide x 2.5 deep x 2.2 tall, standing on the steps
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1.7))
garbha = bpy.context.active_object
garbha.name = "Garbhagriha"
garbha.scale = (1.5, 1.25, 1.1)

# Shikhara (Tower) - 5 tiers stacked in +Z above the sanctum (top z = 2.8), up to z = 6.8
for tier in range(5):
    radius = 1.8 - tier * 0.25
    bpy.ops.mesh.primitive_cone_add(location=(0, 0, 3.2 + tier * 0.8), vertices=16+tier*2)
    shikhara = bpy.context.active_object
    shikhara.name = f"ShikharaTier_{{tier}}"
    shikhara.scale = (radius, radius, 0.4)

# Stupi and Kalasha - finials on top of the tower
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 6.95), radius=0.15)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 7.2), radius=0.2)

# Mandapa (Pillared Hall) - platform in front of the sanctum (towards -Y)
bpy.ops.mesh.primitive_cube_add(location=(0, -3.5, 0.15))
bpy.context.active_object.name = "Mandapa"
bpy.context.active_object.scale = (1.5, 1.0, 0.15)

# Pillars - standing on the mandapa platform (z = 0.3) up to the roof (z = 2.8)
for x, y in [(-1.2, -3.0), (1.2, -3.0), (-1.2, -4.0), (1.2, -4.0)]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, y, 1.55), depth=2.5, radius=0.15)

# Mandapa roof
bpy.ops.mesh.primitive_cube_add(location=(0, -3.5, 2.95))
bpy.context.active_object.name = "MandapaRoof"
bpy.context.active_object.scale = (1.5, 1.0, 0.15)

# Material
mat = bpy.data.materials.new(name="TempleMaterial")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = {color}
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.3
mat.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.0

for obj in bpy.data.objects:
    if obj.type == "MESH":
        obj.data.materials.append(mat)

# Lighting
bpy.ops.object.light_add(type="SUN", location=(5, -8, 8))
bpy.context.active_object.data.energy = 3
bpy.ops.object.light_add(type="POINT", location=(-3, 3, 5))
bpy.context.active_object.data.energy = 200

print("Created Indian temple")
'''

    def _generate_rickshaw_script(self, custom: str) -> str:
        """Generate auto-rickshaw script. Bajaj RE spec, Z-up, metres, ground at z = 0."""
        color = "(0.95, 0.7, 0.1, 1)"  # Yellow default
        if "red" in custom.lower():
            color = "(0.8, 0.15, 0.1, 1)"
        elif "blue" in custom.lower():
            color = "(0.1, 0.3, 0.8, 1)"

        return '''
import bpy, math
from math import pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Bajaj RE (research spec): 2.66 long (X) x 1.30 wide (Y) x 1.70 high (Z),
# wheelbase 2.00, ground clearance 0.20, 3 wheels (1 front, 2 rear), tyre Ø 0.42.
# Front is +X. All parts stand on the ground (z = 0).

# Floor / chassis pan - 2.30 x 1.15 x 0.06, bottom at z = 0.20 (ground clearance)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.23))
bpy.context.active_object.name = "FloorPan"
bpy.context.active_object.scale = (1.15, 0.575, 0.03)

# Wheels - 3 only, tyre Ø 0.42 (torus major 0.15 + minor 0.06), centres at z = 0.21.
# Torus ring lies in the XY plane by default; rotating 90 deg about X puts the
# ring in the XZ plane so the axle runs along Y and the wheel rolls along X.
for x, y in [(1.05, 0), (-0.95, 0.575), (-0.95, -0.575)]:
    bpy.ops.mesh.primitive_torus_add(location=(x, y, 0.21), major_radius=0.15, minor_radius=0.06)
    wheel = bpy.context.active_object
    wheel.name = "Wheel"
    wheel.rotation_euler = (pi / 2, 0, 0)
    bpy.ops.mesh.primitive_cylinder_add(location=(x, y, 0.21), radius=0.09, depth=0.13)
    hub = bpy.context.active_object
    hub.name = "WheelHub"
    hub.rotation_euler = (pi / 2, 0, 0)

# Mudguards - shallow angled panels arcing over each wheel (a full torus ring
# would dip below the ground); body colour
for x, y in [(1.05, 0), (-0.95, 0.575), (-0.95, -0.575)]:
    for dx, rot in [(-0.125, -0.38), (0.125, 0.38)]:
        bpy.ops.mesh.primitive_cube_add(location=(x + dx, y, 0.475))
        guard = bpy.context.active_object
        guard.name = "Mudguard"
        guard.scale = (0.15, 0.08, 0.015)
        guard.rotation_euler = (0, rot, 0)

# Front fork / steering column - Ø 0.08 x 0.75, raked back ~15 deg, z 0.35-1.10
bpy.ops.mesh.primitive_cylinder_add(location=(1.05, 0, 0.725), radius=0.04, depth=0.75)
bpy.context.active_object.name = "FrontFork"
bpy.context.active_object.rotation_euler = (0, -0.2618, 0)

# Handlebar - 0.55 wide, at z = 1.05
bpy.ops.mesh.primitive_cylinder_add(location=(0.95, 0, 1.05), radius=0.0175, depth=0.55)
bpy.context.active_object.name = "Handlebar"
bpy.context.active_object.rotation_euler = (pi / 2, 0, 0)

# Headlight - single round centre light, Ø 0.15 at the nose (x = 1.28, z = 0.85)
bpy.ops.mesh.primitive_cylinder_add(location=(1.28, 0, 0.85), radius=0.075, depth=0.10)
bpy.context.active_object.name = "Headlight"
bpy.context.active_object.rotation_euler = (0, pi / 2, 0)
bpy.ops.mesh.primitive_cylinder_add(location=(1.33, 0, 0.85), radius=0.06, depth=0.02)
bpy.context.active_object.name = "HeadlightLens"
bpy.context.active_object.rotation_euler = (0, pi / 2, 0)

# Front apron / nose panel - 0.35 x 0.55 x 0.55, z 0.35-0.90
bpy.ops.mesh.primitive_cube_add(location=(1.125, 0, 0.625))
bpy.context.active_object.name = "FrontApron"
bpy.context.active_object.scale = (0.175, 0.275, 0.275)

# Windshield - 0.95 wide x 0.45 high, tilted back ~20 deg, z 0.95-1.40
bpy.ops.mesh.primitive_cube_add(location=(0.80, 0, 1.175))
bpy.context.active_object.name = "Windshield"
bpy.context.active_object.scale = (0.01, 0.475, 0.225)
bpy.context.active_object.rotation_euler = (0, -0.349, 0)

# Driver seat - 0.45 x 0.45 x 0.10, seat top at z = 0.62
bpy.ops.mesh.primitive_cube_add(location=(0.45, 0, 0.57))
bpy.context.active_object.name = "DriverSeat"
bpy.context.active_object.scale = (0.225, 0.225, 0.05)

# Passenger bench - 0.55 deep x 1.05 wide x 0.12, seat top at z = 0.60
bpy.ops.mesh.primitive_cube_add(location=(-0.55, 0, 0.54))
bpy.context.active_object.name = "PassengerBench"
bpy.context.active_object.scale = (0.275, 0.525, 0.06)

# Body side panels - 1.30 long x 0.55 high, on both sides
for y in [0.60, -0.60]:
    bpy.ops.mesh.primitive_cube_add(location=(-0.35, y, 0.575))
    bpy.context.active_object.name = "BodySidePanel"
    bpy.context.active_object.scale = (0.65, 0.02, 0.275)

# Canopy / roof - LOW thin curved black sheet, 2.20 x 1.25, peaking at z = 1.70.
# It must NOT swallow the body: a thin sheet (< 0.2 m thick), not a dome.
# It runs the full length so it covers the windshield, and 4 pillars hold
# it up - so it reads as a roof, not a floating saucer.
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.64), radius=1.0)
bpy.context.active_object.name = "Canopy"
bpy.context.active_object.scale = (1.1, 0.625, 0.06)

# Canopy support pillars - 4 thin black posts from the body (z = 0.85)
# up to the canopy underside, so the roof is visibly held up, not floating.
for x, y in [(0.55, 0.48), (0.55, -0.48), (-0.7, 0.48), (-0.7, -0.48)]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, y, 1.22), radius=0.02, depth=0.75)
    bpy.context.active_object.name = "CanopyPillar"

# Rear panel - 0.05 x 1.10 x 0.40, z 0.45-0.85
bpy.ops.mesh.primitive_cube_add(location=(-1.30, 0, 0.65))
bpy.context.active_object.name = "RearPanel"
bpy.context.active_object.scale = (0.025, 0.55, 0.20)

# Tail lights - small red lamps on the rear panel
for y in [0.45, -0.45]:
    bpy.ops.mesh.primitive_cube_add(location=(-1.33, y, 0.55))
    bpy.context.active_object.name = "TailLight"
    bpy.context.active_object.scale = (0.02, 0.06, 0.04)

# Materials - two-tone: yellow body + black lower, black vinyl seats, chrome, glass
mat_body = bpy.data.materials.new(name="AutoBody")
mat_body.use_nodes = True
mat_body.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = __COLOR__
mat_body.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4
mat_body.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.3

mat_black = bpy.data.materials.new(name="BlackVinyl")
mat_black.use_nodes = True
mat_black.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.05, 0.05, 1)
mat_black.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8

mat_chrome = bpy.data.materials.new(name="Chrome")
mat_chrome.use_nodes = True
mat_chrome.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.9, 0.9, 1)
mat_chrome.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
mat_chrome.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.15

mat_glass = bpy.data.materials.new(name="Glass")
mat_glass.use_nodes = True
mat_glass.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.9, 0.95, 1)
mat_glass.node_tree.nodes["Principled BSDF"].inputs["Transmission Weight"].default_value = 0.9
mat_glass.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.05

mat_lens = bpy.data.materials.new(name="HeadlightLensMat")
mat_lens.use_nodes = True
mat_lens.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (1.0, 0.95, 0.7, 1)
mat_lens.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (1.0, 0.9, 0.6, 1)
mat_lens.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.5

mat_red = bpy.data.materials.new(name="TailLightMat")
mat_red.use_nodes = True
mat_red.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.05, 0.05, 1)
mat_red.node_tree.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (0.8, 0.05, 0.05, 1)
mat_red.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.4

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    # Blender renames duplicates (Wheel.001, Mudguard.002, ...), so match on
    # the base name - otherwise only the first copy gets a material.
    base = obj.name.split(".")[0]
    if base in ("FrontApron", "BodySidePanel", "RearPanel", "Mudguard"):
        obj.data.materials.append(mat_body)
    elif base in ("FloorPan", "DriverSeat", "PassengerBench", "Canopy", "CanopyPillar", "FrontFork", "Wheel"):
        obj.data.materials.append(mat_black)
    elif obj.name in ("Handlebar", "Headlight", "WheelHub"):
        obj.data.materials.append(mat_chrome)
    elif obj.name == "Windshield":
        obj.data.materials.append(mat_glass)
    elif obj.name == "HeadlightLens":
        obj.data.materials.append(mat_lens)
    elif obj.name == "TailLight":
        obj.data.materials.append(mat_red)

bpy.ops.object.light_add(type="SUN", location=(3, -5, 4))
bpy.context.active_object.data.energy = 2

print("Created auto-rickshaw")
'''.replace("__COLOR__", color)

    def _generate_thali_script(self, custom: str) -> str:
        """Generate thali script. Steel plate Ø 0.32, Z-up, metres, ground at z = 0."""
        return '''
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Steel plate - Ø 0.32, depth 0.022, sitting on the ground (research: GeM spec)
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.011), radius=0.16, depth=0.022)
plate = bpy.context.active_object
plate.name = "ThaliPlate"

# Rice mound - Ø 0.13 dome, H 0.05, centre of the plate
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 0.047), radius=0.065)
rice = bpy.context.active_object
rice.name = "RiceMound"
rice.scale = (1, 1, 0.3846)

# Katoris x4 - Ø 0.10 top, Ø 0.06 base, H 0.04, in a ring around the rice.
# Each has its own contents with a distinct colour.
katori_contents = [
    ((0.10, 0), "Dal", (0.85, 0.35, 0.05, 1)),
    ((0, 0.10), "Sabzi", (0.15, 0.45, 0.10, 1)),
    ((-0.10, 0), "Curd", (0.97, 0.97, 0.97, 1)),
    ((0, -0.10), "Kheer", (0.9, 0.8, 0.5, 1)),
]
for (x, y), food, food_color in katori_contents:
    bpy.ops.mesh.primitive_cone_add(location=(x, y, 0.042), radius1=0.03, radius2=0.05, depth=0.04, vertices=24)
    bpy.context.active_object.name = f"Katori_{food}"
    bpy.ops.mesh.primitive_cylinder_add(location=(x, y, 0.060), radius=0.046, depth=0.008)
    content = bpy.context.active_object
    content.name = food
    cmat = bpy.data.materials.new(name=f"{food}Mat")
    cmat.use_nodes = True
    cmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = food_color
    cmat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4
    content.data.materials.append(cmat)

# Roti - Ø 0.16, folded in half, flat on the plate edge (diagonal gap)
bpy.ops.mesh.primitive_cylinder_add(location=(0.0707, -0.0707, 0.0235), radius=0.08, depth=0.003)
roti = bpy.context.active_object
roti.name = "Roti"
roti.scale = (1, 0.55, 1)

# Materials - bright polished steel, NOT flat grey; each food its own material
mat_steel = bpy.data.materials.new(name="PolishedSteel")
mat_steel.use_nodes = True
mat_steel.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.92, 0.92, 0.92, 1)
mat_steel.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
mat_steel.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.1

mat_rice = bpy.data.materials.new(name="Rice")
mat_rice.use_nodes = True
mat_rice.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.96, 0.96, 0.93, 1)
mat_rice.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4

mat_roti = bpy.data.materials.new(name="RotiMat")
mat_roti.use_nodes = True
mat_roti.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.78, 0.58, 0.32, 1)
mat_roti.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    if obj.name in ("ThaliPlate",) or obj.name.startswith("Katori_"):
        obj.data.materials.append(mat_steel)
    elif obj.name == "RiceMound":
        obj.data.materials.append(mat_rice)
    elif obj.name == "Roti":
        obj.data.materials.append(mat_roti)

print("Created Indian thali")
'''

    def _generate_building_script(self, custom: str) -> str:
        """Generate haveli/building script. 12x10 footprint, courtyard void, Z-up, metres."""
        return '''
import bpy
from math import pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Haveli (research spec): 12 x 10 m footprint, plinth 0.5, two floors 3.2 each,
# flat roof + parapet (NO temple spire), rooms on all 4 sides of a central
# 4x4 open courtyard (chowk), visible from above. Two storeys only.

def _box(name, loc, scale):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    return obj

def _cyl(name, loc, radius, depth):
    bpy.ops.mesh.primitive_cylinder_add(location=loc, radius=radius, depth=depth)
    obj = bpy.context.active_object
    obj.name = name
    return obj

# Plinth / base - 12 x 10 x 0.5, z 0-0.5 (darker sandstone)
_box("Plinth", (0, 0, 0.25), (6, 5, 0.25))

# Courtyard paving - 4 x 4 stone slab on the plinth, z 0.5-0.55
_box("CourtyardPaving", (0, 0, 0.525), (2, 2, 0.025))

# Floor wings - four blocks around the 4x4 courtyard void (x -2..2, y -2..2).
# Front/back wings: 12 x 3; left/right wings: 4 x 4.
for floor, z0 in [("GroundFloor", 0.5), ("FirstFloor", 3.7)]:
    zc = z0 + 1.6
    _box(f"{floor}_Front", (0, -3.5, zc), (6, 1.5, 1.6))
    _box(f"{floor}_Back", (0, 3.5, zc), (6, 1.5, 1.6))
    _box(f"{floor}_Left", (-4, 0, zc), (2, 2, 1.6))
    _box(f"{floor}_Right", (4, 0, zc), (2, 2, 1.6))

# Roof terrace slabs - one per wing (courtyard stays open to the sky), z 6.9-7.05
for name, loc, scale in [
    ("RoofSlab_Front", (0, -3.5, 6.975), (6, 1.5, 0.075)),
    ("RoofSlab_Back", (0, 3.5, 6.975), (6, 1.5, 0.075)),
    ("RoofSlab_Left", (-4, 0, 6.975), (2, 2, 0.075)),
    ("RoofSlab_Right", (4, 0, 6.975), (2, 2, 0.075)),
]:
    _box(name, loc, scale)

# Parapet - H 1.0 around the roof edge, z 6.9-7.9
_box("Parapet_Front", (0, -4.85, 7.4), (6, 0.15, 0.5))
_box("Parapet_Back", (0, 4.85, 7.4), (6, 0.15, 0.5))
_box("Parapet_Left", (-5.85, 0, 7.4), (0.15, 4.7, 0.5))
_box("Parapet_Right", (5.85, 0, 7.4), (0.15, 4.7, 0.5))

# Main entrance portal - arched, 2.4 wide x 4.5 high, front centre (y = -5)
_box("PortalJamb_Left", (-1.05, -5.0, 2.15), (0.25, 0.25, 1.65))
_box("PortalJamb_Right", (1.05, -5.0, 2.15), (0.25, 0.25, 1.65))
_box("Door_Left", (-0.575, -4.97, 2.15), (0.55, 0.05, 1.65))
_box("Door_Right", (0.575, -4.97, 2.15), (0.55, 0.05, 1.65))
# Pointed (cusped) arch: two segments meeting at the apex (0, -5.0, 5.0)
_box("PortalArch_Left", (-0.6, -5.0, 4.4), (0.85, 0.25, 0.2))
bpy.context.active_object.rotation_euler = (0, -pi / 4, 0)
_box("PortalArch_Right", (0.6, -5.0, 4.4), (0.85, 0.25, 0.2))
bpy.context.active_object.rotation_euler = (0, pi / 4, 0)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, -5.0, 5.05), radius=0.12)
bpy.context.active_object.name = "PortalFinial"

# Arched windows - 0.9 wide x 1.8 high with cusped arch caps, front face.
# Ground floor sill z = 1.0, first floor sill z = 4.7.
for floor, zc in [("GF", 1.9), ("FF", 5.6)]:
    for i, x in enumerate([-4.5, -2.0, 2.0, 4.5]):
        _box(f"Window_{floor}_{i}", (x, -5.02, zc), (0.45, 0.05, 0.9))
        bpy.ops.mesh.primitive_uv_sphere_add(location=(x, -5.02, zc + 0.9), radius=1.0)
        cap = bpy.context.active_object
        cap.name = f"WindowArch_{floor}_{i}"
        cap.scale = (0.45, 0.06, 0.35)

# Fresco band - coloured painted band across the front between the floors
_box("FrescoBand", (0, -5.02, 4.35), (6, 0.05, 0.25))

# Jharokha balconies x2 - projecting ~1 m from the front face, first floor.
for sx in [3.0, -3.0]:
    _box(f"JharokhaSlab_{sx}", (sx, -5.5, 4.775), (0.6, 0.5, 0.075))
    for dx in [-0.4, 0.4]:
        _box(f"JharokhaCorbel_{sx}_{dx}", (sx + dx, -5.5, 4.45), (0.05, 0.05, 0.25))
    for dx in [-0.5, 0.5]:
        for dy in [-5.9, -5.1]:
            _cyl(f"JharokhaPillar_{sx}_{dx}_{dy}", (sx + dx, dy, 5.75), 0.04, 1.8)
    _box(f"JharokhaJali_{sx}", (sx, -5.95, 5.75), (0.6, 0.025, 0.6))
    bpy.ops.mesh.primitive_uv_sphere_add(location=(sx, -5.5, 6.65), radius=1.0)
    dome = bpy.context.active_object
    dome.name = f"JharokhaDome_{sx}"
    dome.scale = (0.6, 0.5, 0.35)

# Veranda columns - Ø 0.30, H 2.7, around the courtyard, both floors
for zc in [1.85, 5.05]:
    for x in [-2.2, 2.2]:
        for y in [-2.2, 2.2]:
            _cyl(f"VerandaColumn_{zc}_{x}_{y}", (x, y, zc), 0.15, 2.7)

# Chhatris x4 - domed pavilions on the roof corners, dome top ~9.0
for cx in [5, -5]:
    for cy in [4, -4]:
        _box(f"ChhatriBase_{cx}_{cy}", (cx, cy, 7.125), (0.75, 0.75, 0.075))
        for dx in [-0.6, 0.6]:
            for dy in [-0.6, 0.6]:
                _cyl(f"ChhatriPillar_{cx}_{cy}_{dx}_{dy}", (cx + dx, cy + dy, 7.8), 0.06, 1.2)
        bpy.ops.mesh.primitive_uv_sphere_add(location=(cx, cy, 8.4), radius=1.0)
        dome = bpy.context.active_object
        dome.name = f"ChhatriDome_{cx}_{cy}"
        dome.scale = (0.7, 0.7, 0.5)
        bpy.ops.mesh.primitive_uv_sphere_add(location=(cx, cy, 8.95), radius=0.08)
        bpy.context.active_object.name = f"ChhatriFinial_{cx}_{cy}"

# Materials - golden-yellow sandstone + darker plinth + dark teak doors + fresco band
mat_sand = bpy.data.materials.new(name="Sandstone")
mat_sand.use_nodes = True
mat_sand.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.72, 0.5, 1)
mat_sand.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_plinth = bpy.data.materials.new(name="PlinthStone")
mat_plinth.use_nodes = True
mat_plinth.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.6, 0.5, 0.35, 1)
mat_plinth.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_teak = bpy.data.materials.new(name="DarkTeak")
mat_teak.use_nodes = True
mat_teak.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.25, 0.15, 0.08, 1)
mat_teak.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.7

mat_dark = bpy.data.materials.new(name="WindowRecess")
mat_dark.use_nodes = True
mat_dark.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.12, 0.12, 0.14, 1)
mat_dark.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_fresco = bpy.data.materials.new(name="Fresco")
mat_fresco.use_nodes = True
mat_fresco.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.7, 0.25, 0.15, 1)
mat_fresco.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8

mat_brass = bpy.data.materials.new(name="Brass")
mat_brass.use_nodes = True
mat_brass.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.7, 0.3, 1)
mat_brass.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
mat_brass.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    if obj.name in ("Plinth",):
        obj.data.materials.append(mat_plinth)
    elif obj.name.startswith("Door_"):
        obj.data.materials.append(mat_teak)
    elif obj.name.startswith("Window_"):
        obj.data.materials.append(mat_dark)
    elif obj.name == "FrescoBand":
        obj.data.materials.append(mat_fresco)
    elif "Finial" in obj.name:
        obj.data.materials.append(mat_brass)
    else:
        obj.data.materials.append(mat_sand)

print("Created haveli")
'''

    def _generate_character_script(self, custom: str) -> str:
        """Generate human character script. H = 1.75 m, 7.5 heads, feet at z = 0."""
        return '''
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Adult male in dhoti/kurta (research spec): H = 1.75 m, 7.5 heads.
# Landmarks: crown 1.75, chin 1.52, shoulder 1.45, elbow 1.09, hip 0.90,
# fingertips 0.65 (mid-thigh), knee 0.53, ankle 0.08. Faces -Y.
# Torso is NARROWER than the shoulders - no big white box.

# Head - H 0.23, W 0.16, D 0.19, z 1.52-1.75 (clearly visible on top)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.635), radius=1.0)
head = bpy.context.active_object
head.name = "Head"
head.scale = (0.08, 0.095, 0.115)

# Hair cap - black, on top/back of the head
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, -0.005, 1.70), radius=1.0)
hair = bpy.context.active_object
hair.name = "Hair"
hair.scale = (0.082, 0.097, 0.055)

# Eyes - dark, on the face (-Y side), big enough to see and sitting
# proud of the head surface (head half-depth 0.095 at z = 1.66)
for x in [-0.035, 0.035]:
    bpy.ops.mesh.primitive_uv_sphere_add(location=(x, -0.093, 1.66), radius=0.016)
    bpy.context.active_object.name = "Eye"

# Neck - Ø 0.11, H 0.10, z 1.42-1.52
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 1.47), radius=0.055, depth=0.10)
bpy.context.active_object.name = "Neck"

# Torso with kurta - shoulders 0.46 wide, chest 0.42, z 0.85-1.45 (cream)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1.15))
bpy.context.active_object.name = "Torso"
bpy.context.active_object.scale = (0.21, 0.11, 0.30)

# Shoulders - 0.46 wide, wider than the torso
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.43), radius=1.0)
bpy.context.active_object.name = "Shoulders"
bpy.context.active_object.scale = (0.23, 0.11, 0.06)

# Kurta skirt - flares slightly, hem at the knee (z = 0.70)
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.85), radius=0.22, depth=0.30)
bpy.context.active_object.name = "KurtaSkirt"

# Arms - upper arm shoulder 1.45 -> elbow 1.09, forearm -> wrist 0.79,
# hands skin, fingertips reaching mid-thigh (z = 0.65)
for x in [-0.26, 0.26]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 1.27), radius=0.045, depth=0.36)
    bpy.context.active_object.name = "UpperArm"
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.94), radius=0.035, depth=0.30)
    bpy.context.active_object.name = "Forearm"
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.72), radius=0.035, depth=0.14)
    bpy.context.active_object.name = "Hand"

# Dhoti - white with gold border, waist z 0.95 to ankle hem z 0.02
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.485), radius=0.19, depth=0.93)
bpy.context.active_object.name = "Dhoti"
bpy.ops.mesh.primitive_torus_add(location=(0, 0, 0.05), major_radius=0.19, minor_radius=0.012)
bpy.context.active_object.name = "DhotiBorder"

# Legs underneath the dhoti - hip 0.90 -> ankle 0.08
for x in [-0.09, 0.09]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.49), radius=0.06, depth=0.82)
    bpy.context.active_object.name = "Leg"

# Feet / sandals on the ground, pointing forward (-Y)
for x in [-0.09, 0.09]:
    bpy.ops.mesh.primitive_cube_add(location=(x, -0.06, 0.015))
    bpy.context.active_object.name = "Foot"
    bpy.context.active_object.scale = (0.045, 0.135, 0.015)

# Materials - skin, kurta and dhoti in DISTINCT tones
mat_skin = bpy.data.materials.new(name="Skin")
mat_skin.use_nodes = True
mat_skin.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.45, 0.28, 0.18, 1)
mat_skin.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6

mat_kurta = bpy.data.materials.new(name="Kurta")
mat_kurta.use_nodes = True
# Torso with kurta - saffron, clearly distinct from the white dhoti
mat_kurta.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.45, 0.10, 1)
mat_kurta.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_dhoti = bpy.data.materials.new(name="DhotiMat")
mat_dhoti.use_nodes = True
mat_dhoti.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.97, 0.96, 0.92, 1)
mat_dhoti.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9

mat_gold = bpy.data.materials.new(name="GoldBorder")
mat_gold.use_nodes = True
mat_gold.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.65, 0.2, 1)
mat_gold.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.8
mat_gold.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.35

mat_hair = bpy.data.materials.new(name="HairMat")
mat_hair.use_nodes = True
mat_hair.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.04, 0.03, 1)
mat_hair.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6

mat_leather = bpy.data.materials.new(name="Leather")
mat_leather.use_nodes = True
mat_leather.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.4, 0.25, 0.12, 1)
mat_leather.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    # Blender renames duplicates (Eye.001, Hand.001, ...), so match on the
    # base name - otherwise only the first copy gets a material.
    base = obj.name.split(".")[0]
    if base in ("Head", "Neck", "Hand", "Leg"):
        obj.data.materials.append(mat_skin)
    elif base in ("Torso", "Shoulders", "KurtaSkirt", "UpperArm", "Forearm"):
        obj.data.materials.append(mat_kurta)
    elif base == "Dhoti":
        obj.data.materials.append(mat_dhoti)
    elif base == "DhotiBorder":
        obj.data.materials.append(mat_gold)
    elif base in ("Hair", "Eye"):
        obj.data.materials.append(mat_hair)
    elif base == "Foot":
        obj.data.materials.append(mat_leather)

print("Created Indian character")
'''

    async def _execute_blender_code(self, args: dict) -> dict:
        """Run arbitrary Blender Python code supplied by the LLM."""
        code = args.get("code", "")
        if not code.strip():
            return {"success": False, "error": "No code supplied."}
        return self.model_builder.create_mesh(code)

    async def _modify_model(self, args: dict) -> dict:
        """Modify existing model."""
        # Simplified modification script
        existing = args.get("existing_model", "")
        mods = args.get("modifications", "").lower()

        script = f'''
import bpy

existing = "{existing}"
if existing:
    try:
        bpy.ops.wm.open(filepath=existing)
    except:
        pass

modifications = "{mods}"

obj = bpy.context.active_object
if obj:
    if "red" in modifications:
        mat = bpy.data.materials.new(name="ModifiedMat")
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.8, 0.1, 0.1, 1)
        obj.data.materials.append(mat)
    elif "blue" in modifications:
        mat = bpy.data.materials.new(name="ModifiedMat")
        mat.use_nodes = True
        mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.1, 0.3, 0.8, 1)
        obj.data.materials.append(mat)

    if "bigger" in modifications or "larger" in modifications:
        obj.scale = (obj.scale.x * 1.5, obj.scale.y * 1.5, obj.scale.z * 1.5)

    if "metallic" in modifications:
        for slot in obj.data.materials:
            if slot:
                slot.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 1.0
                slot.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.2

output = "{self.config.paths.output_dir}/modified_{datetime.now().strftime('%Y%m%d_%H%M%S')}.blend"
bpy.ops.wm.save_mainfile(filepath=output)
'''

        return self.model_builder.create_mesh(script)

    async def _apply_texture(self, args: dict) -> dict:
        """Apply texture to model.

        Procedural names (wood, marble, ...) get a Principled BSDF node
        tree. ``polyhaven:<slug>`` downloads the real 1k texture maps from
        Poly Haven, runs Smart UV on the targets, and builds a
        colour-space-correct node tree (images packed, provenance on the
        material). If the Poly Haven API is unreachable the call fails
        with a clear error — never a silent fallback.
        """
        texture = args.get("texture_type", "")
        obj_name = args.get("object_name", "")
        blend_path = args.get("blend_path", "") or ""
        if blend_path and not Path(blend_path).exists():
            return {"success": False, "error": f"Blend file not found: {blend_path}"}
        # Without a .blend to open, Blender starts empty and the material
        # would be created but applied to nothing — so load the model
        # first when one is given.
        open_line = f"bpy.ops.wm.open_mainfile(filepath={json.dumps(blend_path)})\n" if blend_path else ""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = self.config.paths.output_dir / f"textured_{timestamp}.blend"

        # Poly Haven image texture: polyhaven:<slug>
        if texture.startswith("polyhaven:"):
            slug = texture[len("polyhaven:"):].strip()
            if not slug:
                return {"success": False, "error": "Poly Haven texture needs a slug: polyhaven:<slug>."}
            try:
                req = urllib.request.Request(
                    f"{POLYHAVEN_API}/files/{urllib.parse.quote(slug)}",
                    headers={"User-Agent": POLYHAVEN_USER_AGENT},
                )
                with urllib.request.urlopen(req, timeout=30) as response:
                    files = json.loads(response.read().decode())
            except urllib.error.HTTPError as e:
                return {"success": False, "error": f"Poly Haven: no texture named '{slug}' (HTTP {e.code}). Check the slug on polyhaven.com/textures."}
            except Exception as e:
                return {"success": False, "error": f"Poly Haven API unreachable: {e}. No fallback material was applied — check the network and try again."}
            try:
                maps = pick_polyhaven_maps(files)
            except ValueError as e:
                return {"success": False, "error": str(e)}
            # Download the 1k maps (50 MB total cap).
            tex_dir = self.config.paths.texture_dir / slug
            tex_dir.mkdir(parents=True, exist_ok=True)
            local_maps = {}
            downloaded = 0
            max_bytes = 50 * 1024 * 1024
            try:
                for role, url in maps.items():
                    req = urllib.request.Request(url, headers={"User-Agent": POLYHAVEN_USER_AGENT})
                    with urllib.request.urlopen(req, timeout=120) as response:
                        data = response.read()
                    downloaded += len(data)
                    if downloaded > max_bytes:
                        return {"success": False, "error": "Poly Haven download exceeds the 50 MB limit."}
                    ext = url.split(".")[-1].split("?")[0] or "jpg"
                    local_path = tex_dir / f"{slug}_{role}.{ext}"
                    local_path.write_bytes(data)
                    local_maps[role] = str(local_path)
            except Exception as e:
                return {"success": False, "error": f"Poly Haven download failed: {e}. No fallback material was applied."}

            mat_script = build_polyhaven_material_script(slug, local_maps, f"PolyHaven_{slug}")
            script = f'''
import bpy, math
{open_line}{mat_script}
target = {json.dumps(obj_name)}
targets = [obj for obj in bpy.data.objects if obj.type == "MESH" and (not target or target in obj.name)]
{get_smart_uv_script()}
for obj in targets:
    obj.data.materials.append(mat)
output = {json.dumps(str(output_path))}
bpy.ops.wm.save_mainfile(filepath=output)
'''
            result = self.model_builder.create_mesh(script)
            result["texture"] = texture
            result["polyhaven"] = {
                "slug": slug,
                "url": f"https://polyhaven.com/textures/{slug}",
                "licence": POLYHAVEN_LICENCE,
            }
            return result

        # Procedural material (node tree, Generated coordinates — no UVs needed).
        mat_script = MaterialLibrary.get_material_script(texture)
        script = f'''
import bpy
{open_line}{mat_script}

target = {json.dumps(obj_name)}
for obj in bpy.data.objects:
    if obj.type == "MESH":
        if not target or target in obj.name:
            obj.data.materials.append(mat)

output = {json.dumps(str(output_path))}
bpy.ops.wm.save_mainfile(filepath=output)
'''

        result = self.model_builder.create_mesh(script)
        result["texture"] = texture
        return result

    async def _import_from_url(self, args: dict) -> dict:
        """Import model from URL, normalised to 1 m longest side, standing on z = 0."""
        url = args.get("url", "")
        name = args.get("name", "imported")
        target_size = float(args.get("target_size", 1.0) or 1.0)

        ext = url.split(".")[-1].lower().split("?")[0]
        if ext not in ["glb", "gltf", "obj", "fbx", "stl"]:
            ext = "glb"

        # Blender import operator per format (STL lives under import_mesh, not import_scene)
        import_ops = {
            "glb": "bpy.ops.import_scene.gltf",
            "gltf": "bpy.ops.import_scene.gltf",
            "obj": "bpy.ops.import_scene.obj",
            "fbx": "bpy.ops.import_scene.fbx",
            "stl": "bpy.ops.import_mesh.stl",
        }
        import_op = import_ops[ext]

        local_path = self.config.paths.temp_dir / f"{name}.{ext}"
        output_path = self.config.paths.output_dir / f"{name}.blend"
        max_bytes = 100 * 1024 * 1024  # 100 MB download cap

        try:
            # Download file (chunked, with a size cap)
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=120) as response:
                with open(local_path, "wb") as f:
                    downloaded = 0
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        downloaded += len(chunk)
                        if downloaded > max_bytes:
                            raise ValueError(f"Download exceeds {max_bytes // (1024 * 1024)} MB limit")
                        f.write(chunk)

            # Import to Blender, then normalise: longest side -> target_size,
            # origin at bottom centre, lowest point on the ground (z = 0).
            script = self._build_import_script(str(local_path), import_op, str(output_path), target_size)
            result = self.model_builder.create_mesh(script)
            return {"success": result.get("success", False), "output": result.get("output", str(output_path)), "error": result.get("error", "")}

        except Exception as e:
            self.logger.error(f"Import failed: {e}")
            return {"success": False, "error": str(e)}

    @staticmethod
    def _build_import_script(local_path: str, import_op: str, output_path: str, target_size: float) -> str:
        """Blender script: import a downloaded model file and normalise it.

        Normalisation: longest side becomes target_size (metres) and the
        lowest point is moved onto the ground (z = 0). Kept as a separate
        method so tests can verify it without downloading anything.
        """
        return f'''
import bpy
from mathutils import Vector

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

{import_op}(filepath="{local_path}")

meshes = [o for o in bpy.context.selected_objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError("Import produced no mesh objects")

def bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    return lo, hi

lo, hi = bounds(meshes)
size = hi - lo
longest = max(size.x, size.y, size.z)
if longest > 0:
    s = {target_size} / longest
    for o in meshes:
        o.scale = (o.scale.x * s, o.scale.y * s, o.scale.z * s)

bpy.context.view_layer.update()
lo, hi = bounds(meshes)
for o in meshes:
    o.location.z -= lo.z

bpy.ops.wm.save_mainfile(filepath="{output_path}")
'''

    async def _get_scene_info(self) -> dict:
        """Get scene information."""
        script = "import bpy, json; objs = [{'name': o.name, 'type': o.type} for o in bpy.data.objects]; print(json.dumps({'objects': objs}))"
        result = self.model_builder.create_mesh(script)
        return result

    async def run(self):
        """Run the MCP server."""
        async with stdio_server() as streams:
            await self.app.run(streams[0], streams[1], self.app.create_initialization_options())


# ==============================================================================
# Main Entry Point
# ==============================================================================

def main():
    """Main entry point."""
    server = BlenderMCPServer()
    asyncio.run(server.run())


if __name__ == "__main__":
    main()