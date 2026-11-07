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
# Material Library
# ==============================================================================

class MaterialLibrary:
    """Built-in procedural material generation."""

    MATERIALS = {
        "marble": {
            "base_color": (0.95, 0.95, 0.95, 1),
            "roughness": 0.1,
            "metallic": 0.0,
        },
        "red_marble": {
            "base_color": (0.8, 0.3, 0.25, 1),
            "roughness": 0.15,
            "metallic": 0.1,
        },
        "green_marble": {
            "base_color": (0.2, 0.5, 0.3, 1),
            "roughness": 0.15,
            "metallic": 0.1,
        },
        "wood": {
            "base_color": (0.35, 0.2, 0.1, 1),
            "roughness": 0.7,
            "metallic": 0.0,
        },
        "gold": {
            "base_color": (1.0, 0.76, 0.33, 1),
            "roughness": 0.2,
            "metallic": 1.0,
        },
        "copper": {
            "base_color": (0.95, 0.64, 0.54, 1),
            "roughness": 0.3,
            "metallic": 1.0,
        },
        "brass": {
            "base_color": (0.85, 0.7, 0.3, 1),
            "roughness": 0.4,
            "metallic": 1.0,
        },
        "stone": {
            "base_color": (0.6, 0.58, 0.55, 1),
            "roughness": 0.85,
            "metallic": 0.0,
        },
        "sandstone": {
            "base_color": (0.85, 0.75, 0.6, 1),
            "roughness": 0.9,
            "metallic": 0.0,
        },
        "terracotta": {
            "base_color": (0.8, 0.45, 0.3, 1),
            "roughness": 0.85,
            "metallic": 0.0,
        },
    }

    @classmethod
    def get_material_script(cls, material_type: str) -> str:
        """Generate procedural material script."""
        mat = cls.MATERIALS.get(material_type.lower(), cls.MATERIALS["stone"])

        return f'''
mat = bpy.data.materials.new(name="{material_type.title()}")
mat.use_nodes = True
nodes = mat.node_tree.nodes
nodes["Principled BSDF"].inputs["Base Color"].default_value = {mat["base_color"]}
nodes["Principled BSDF"].inputs["Roughness"].default_value = {mat["roughness"]}
nodes["Principled BSDF"].inputs["Metallic"].default_value = {mat["metallic"]}
'''


# ==============================================================================
# Model Builders
# ==============================================================================

class ModelBuilder:
    """Handles 3D model generation."""

    def __init__(self, config: ServerConfig):
        self.config = config
        self.logger = get_logger("model")

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
            result = subprocess.run(
                [self.config.blender.executable, "--background", "--python", script_path],
                capture_output=True,
                text=True,
                timeout=self.config.blender.timeout
            )

            success = result.returncode == 0

            if success:
                self.logger.info(f"Model saved to: {output_path}")
                # Open in Blender
                subprocess.Popen(
                    [self.config.blender.executable, str(output_path)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
                return {"success": True, "output": str(output_path), "stdout": result.stdout[-2000:]}
            else:
                self.logger.error(f"Blender script failed: {result.stderr}")
                return {"success": False, "error": result.stderr, "stdout": result.stdout[-2000:]}

        except subprocess.TimeoutExpired:
            self.logger.error("Blender execution timed out")
            return {"success": False, "error": "Execution timed out"}
        except FileNotFoundError:
            self.logger.error("Blender executable not found")
            return {"success": False, "error": "Blender not found"}
        except Exception as e:
            self.logger.error(f"Model creation failed: {e}")
            return {"success": False, "error": str(e)}
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
                        "texture_type": {"type": "string", "description": "Texture type: wood, marble, stone, metal, gold, brass, tile"},
                        "object_name": {"type": "string", "description": "Object to apply texture to"},
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
        if name == "search_models":
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
        """Generate auto-rickshaw script. Z-up, metres, ground at z = 0."""
        color = "(0.95, 0.7, 0.1, 1)"  # Yellow default
        if "red" in custom.lower():
            color = "(0.8, 0.15, 0.1, 1)"
        elif "blue" in custom.lower():
            color = "(0.1, 0.3, 0.8, 1)"

        return f'''
import bpy, math
from math import pi

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Body - 1.3 wide (X) x 2.2 long (Y) x 0.7 tall, bottom at z = 0.15
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.5))
body = bpy.context.active_object
body.name = "BodyMain"
body.scale = (0.65, 1.1, 0.35)

# Cabin - canopy above the body
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, -0.2, 1.05), radius=0.7)
cabin = bpy.context.active_object
cabin.name = "Cabin"
cabin.scale = (1.15, 1.6, 0.75)

# Wheels - 3 wheels, outer radius 0.5, centres at z = 0.5 so they touch the ground.
# Torus ring lies in the XY plane by default; rotating 90 deg about Y puts the
# ring in the ZY plane so the axle runs along X and the wheel rolls along Y.
for x, y in [(-0.75, 0.9), (0.75, 0.9), (0, -1.0)]:
    bpy.ops.mesh.primitive_torus_add(location=(x, y, 0.5), major_radius=0.38, minor_radius=0.12)
    wheel = bpy.context.active_object
    wheel.name = "Wheel"
    wheel.rotation_euler = (0, pi / 2, 0)

# Material
mat = bpy.data.materials.new(name="AutoBody")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = {color}
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.4
mat.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.3

for obj in bpy.data.objects:
    if obj.type == "MESH" and "Body" in obj.name:
        obj.data.materials.append(mat)

bpy.ops.object.light_add(type="SUN", location=(3, -5, 4))
bpy.context.active_object.data.energy = 2

print("Created auto-rickshaw")
'''

    def _generate_thali_script(self, custom: str) -> str:
        """Generate thali script. Z-up, metres, ground at z = 0."""
        return '''
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Plate - 0.7 m across, 0.03 m thick, sitting on the ground
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.015), radius=0.35, depth=0.03)
plate = bpy.context.active_object
plate.name = "ThaliPlate"

# Rice mound - flattened in Z, sitting on the plate (top z = 0.03)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 0.09), radius=0.12)
rice = bpy.context.active_object
rice.name = "RiceMound"
rice.scale = (1, 1, 0.5)

# Bowls - flattened in Z, sitting on the plate
for x, y in [(0.18, 0.1), (-0.18, 0.1), (0, -0.18)]:
    bpy.ops.mesh.primitive_uv_sphere_add(location=(x, y, 0.08), radius=0.08)
    bpy.context.active_object.scale = (1, 1, 0.6)

# Material
mat = bpy.data.materials.new(name="Steel")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.85, 0.85, 1)
mat.node_tree.nodes["Principled BSDF"].inputs["Metallic"].default_value = 0.9
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.25

for obj in bpy.data.objects:
    if obj.type == "MESH":
        obj.data.materials.append(mat)

print("Created Indian thali")
'''

    def _generate_building_script(self, custom: str) -> str:
        """Generate haveli/building script. Z-up, metres, ground at z = 0."""
        return '''
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Ground floor - 8 wide (X) x 6 deep (Y) x 3 tall, standing on the ground
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1.5))
bpy.context.active_object.name = "GroundFloor"
bpy.context.active_object.scale = (4, 3, 1.5)

# Second floor - 7.6 x 5.6 x 2.5, stacked on the ground floor (z = 3 to 5.5)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 4.25))
bpy.context.active_object.name = "FirstFloor"
bpy.context.active_object.scale = (3.8, 2.8, 1.25)

# Roof - slab on top of the second floor (z = 5.5 to 5.9)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 5.7))
bpy.context.active_object.name = "MainRoof"
bpy.context.active_object.scale = (4.2, 3.2, 0.2)

# Chattris - domed pavilions on the roof, cones rising in +Z with spheres on top
for x in [-3, 3]:
    for y in [-2.2, 2.2]:
        bpy.ops.mesh.primitive_cone_add(location=(x, y, 6.5), vertices=12)
        bpy.context.active_object.scale = (0.8, 0.8, 0.6)
        bpy.ops.mesh.primitive_uv_sphere_add(location=(x, y, 7.35), radius=0.5)

# Material
mat = bpy.data.materials.new(name="HaveliWall")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.75, 0.5, 1)
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.85

for obj in bpy.data.objects:
    if obj.type == "MESH":
        obj.data.materials.append(mat)

print("Created haveli")
'''

    def _generate_character_script(self, custom: str) -> str:
        """Generate human character script. Z-up, metres, feet at z = 0."""
        return '''
import bpy

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Head - top of the figure at z = 1.87
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.65), radius=0.22)
bpy.context.active_object.name = "Head"

# Torso - 0.9 wide x 0.44 deep x 1.1 tall (z = 0.55 to 1.65)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1.1))
bpy.context.active_object.name = "Torso"
bpy.context.active_object.scale = (0.45, 0.22, 0.55)

# Shoulders
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 1.25), radius=0.25)
bpy.context.active_object.name = "Shoulders"
bpy.context.active_object.scale = (1, 0.8, 0.4)

# Arms - cylinders along Z (upper at z = 0.95, lower at z = 0.55)
for x in [-0.45, 0.45]:
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.95), radius=0.08, depth=0.35)
    bpy.ops.mesh.primitive_cylinder_add(location=(x, 0, 0.55), radius=0.07, depth=0.35)

# Dhoti - from the ground (z = 0) to z = 1.1
bpy.ops.mesh.primitive_cylinder_add(location=(0, 0, 0.55), radius=0.25, depth=1.1)
bpy.context.active_object.name = "Dhoti"

# Skin material
mat_skin = bpy.data.materials.new(name="Skin")
mat_skin.use_nodes = True
mat_skin.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.85, 0.72, 0.62, 1)
mat_skin.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.7

# Dhoti material
mat_dhoti = bpy.data.materials.new(name="Dhoti")
mat_dhoti.use_nodes = True
mat_dhoti.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.6, 0.2, 1)
mat_dhoti.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.8

for obj in bpy.data.objects:
    if obj.type == "MESH":
        if "Dhoti" in obj.name:
            obj.data.materials.append(mat_dhoti)
        else:
            obj.data.materials.append(mat_skin)

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
        """Apply texture to model."""
        texture = args.get("texture_type", "")
        obj_name = args.get("object_name", "")

        mat_script = MaterialLibrary.get_material_script(texture)
        script = f'''
import bpy
{mat_script}

target = "{obj_name}" if "{obj_name}" else None
for obj in bpy.data.objects:
    if obj.type == "MESH":
        if target is None or target in obj.name:
            obj.data.materials.append(mat)

output = "{self.config.paths.output_dir}/textured.blend"
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