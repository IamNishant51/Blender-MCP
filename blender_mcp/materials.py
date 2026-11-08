"""Material library v2 — Principled BSDF node trees, Smart UV, Poly Haven.

Materials v2 (Blender-MCP 1.2.0) replaces the old flat-colour materials with
real node trees built on Generated coordinates, so no UV map is needed for
procedural materials:

- wood:      Noise Texture -> ColorRamp -> Base Color + Bump
- marble:    Voronoi -> ColorRamp thin veins + Subsurface 0.1 + Roughness 0.2
- metal:     Metallic 1.0, Noise into Roughness 0.2-0.4, Bump
- fabric:    Sheen 1.0, Roughness 0.9, Noise -> Bump
- smooth_leather: plain Principled, Roughness 0.7, Sheen 0.3 — NO noise
  nodes at all (v1.3.0 fix: the fabric Noise->Bump at scale 25 on a small
  strap reads as a scribbled artifact under studio light; straps and
  cushions must use smooth_leather, never fabric)
- matte_plastic: plain Principled, Roughness 0.55 — no noise
- rubber:     plain Principled, near-black, Roughness 0.95 — no noise
- white_leather: plain Principled, off-white, Roughness 0.5, Sheen 0.5
- amber_liquid: Transmission 0.85, amber Base Color, Roughness 0.05
- steel:     Metallic 0.9, Roughness 0.35
- glass:     Transmission 1, IOR 1.45, Roughness 0.05
- skin:      Subsurface 0.4, warm brown
- sandstone: Noise -> warm golden colour + Bump

Unknown material names still fall back to a flat Principled colour (stone).

Also in this module: the Smart UV helper (run before any image-texture
application) and the Poly Haven texture builders (API -> 1k maps ->
colour-space-correct node tree, images packed into the .blend, provenance
written as custom properties on the material).
"""

import json

POLYHAVEN_API = "https://api.polyhaven.com"
USER_AGENT = "blender-mcp/1.3.0 (https://github.com/IamNishant51/Blender-MCP)"
POLYHAVEN_LICENCE = "CC0"


# ---------------------------------------------------------------------------
# Flat-colour fallback (unknown names)
# ---------------------------------------------------------------------------

FLAT_MATERIALS = {
    "stone": {"base_color": (0.6, 0.58, 0.55, 1), "roughness": 0.85, "metallic": 0.0},
}


def _flat_script(name: str, base_color, roughness: float, metallic: float) -> str:
    return f'''
mat = bpy.data.materials.new(name={json.dumps(name)})
mat.use_nodes = True
nodes = mat.node_tree.nodes
nodes["Principled BSDF"].inputs["Base Color"].default_value = {tuple(base_color)}
nodes["Principled BSDF"].inputs["Roughness"].default_value = {roughness}
nodes["Principled BSDF"].inputs["Metallic"].default_value = {metallic}
'''


def _node_header(name: str) -> str:
    """Common header: create the material, keep the Principled BSDF handy."""
    return f'''
mat = bpy.data.materials.new(name={json.dumps(name)})
mat.use_nodes = True
nt = mat.node_tree
nodes = nt.nodes
links = nt.links
bsdf = nodes["Principled BSDF"]
texcoord = nodes.new("ShaderNodeTexCoord")
texcoord.location = (-800, 0)
'''


def _noise_block(scale: float, detail: float = 2.0, roughness: float = 0.7) -> str:
    return f'''
noise = nodes.new("ShaderNodeTexNoise")
noise.location = (-600, 200)
noise.inputs["Scale"].default_value = {scale}
noise.inputs["Detail"].default_value = {detail}
noise.inputs["Roughness"].default_value = {roughness}
links.new(texcoord.outputs["Generated"], noise.inputs["Vector"])
'''


def _ramp_block(c0, c1, pos1: float = 1.0) -> str:
    """Two-stop ColorRamp (Fac in, Color out)."""
    return f'''
ramp = nodes.new("ShaderNodeValToRGB")
ramp.location = (-400, 200)
ramp.color_ramp.elements[0].position = 0.0
ramp.color_ramp.elements[0].color = {tuple(c0)}
ramp.color_ramp.elements[1].position = {pos1}
ramp.color_ramp.elements[1].color = {tuple(c1)}
links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
'''


def _bump_block(strength: float, distance: float = 0.1) -> str:
    return f'''
bump = nodes.new("ShaderNodeBump")
bump.location = (-400, -200)
bump.inputs["Strength"].default_value = {strength}
bump.inputs["Distance"].default_value = {distance}
links.new(noise.outputs["Fac"], bump.inputs["Height"])
links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
'''


def _wood_script(name: str) -> str:
    return (
        _node_header(name)
        + _noise_block(5.0)
        + _ramp_block((0.23, 0.12, 0.05, 1), (0.55, 0.36, 0.19, 1))
        + _bump_block(0.3)
        + '''
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.7
'''
    )


def _marble_script(name: str, base=(0.93, 0.93, 0.92, 1), vein=(0.15, 0.15, 0.16, 1)) -> str:
    return (
        _node_header(name)
        + '''
voronoi = nodes.new("ShaderNodeTexVoronoi")
voronoi.location = (-600, 200)
voronoi.inputs["Scale"].default_value = 6.0
voronoi.feature = 'F1'
voronoi.distance = 'EUCLIDEAN'
links.new(texcoord.outputs["Generated"], voronoi.inputs["Vector"])
ramp = nodes.new("ShaderNodeValToRGB")
ramp.location = (-400, 200)
# Thin dark veins: dark at distance 0, base colour everywhere else.
ramp.color_ramp.elements[0].position = 0.0
ramp.color_ramp.elements[0].color = '''
        + f"""{tuple(vein)}
ramp.color_ramp.elements[1].position = 1.0
ramp.color_ramp.elements[1].color = {tuple(base)}
vein_stop = ramp.color_ramp.elements.new(0.12)
vein_stop.color = {tuple(base)}
links.new(voronoi.outputs["Distance"], ramp.inputs["Fac"])
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.2
bsdf.inputs["Subsurface Weight"].default_value = 0.1
# NOTE: Blender 4.2's Principled BSDF has no "Subsurface Color" input —
# subsurface takes its colour from Base Color (the Voronoi ramp above).
# Setting it raises KeyError and kills the whole build.
"""
    )


def _metal_script(name: str, tint=(0.8, 0.8, 0.82, 1), metallic: float = 1.0,
                  rough_lo: float = 0.2, rough_hi: float = 0.4) -> str:
    return (
        _node_header(name)
        + _noise_block(8.0)
        + f'''
# Noise varies the roughness between {rough_lo} and {rough_hi}.
rough_ramp = nodes.new("ShaderNodeValToRGB")
rough_ramp.location = (-400, 0)
rough_ramp.color_ramp.elements[0].position = 0.0
rough_ramp.color_ramp.elements[0].color = ({rough_lo}, {rough_lo}, {rough_lo}, 1)
rough_ramp.color_ramp.elements[1].position = 1.0
rough_ramp.color_ramp.elements[1].color = ({rough_hi}, {rough_hi}, {rough_hi}, 1)
links.new(noise.outputs["Fac"], rough_ramp.inputs["Fac"])
links.new(rough_ramp.outputs["Color"], bsdf.inputs["Roughness"])
'''
        + _bump_block(0.2)
        + f'''
bsdf.inputs["Base Color"].default_value = {tuple(tint)}
bsdf.inputs["Metallic"].default_value = {metallic}
'''
    )


def _fabric_script(name: str, base=(0.85, 0.8, 0.72, 1)) -> str:
    return (
        _node_header(name)
        + _noise_block(25.0)
        + _bump_block(0.15)
        + f'''
bsdf.inputs["Base Color"].default_value = {tuple(base)}
bsdf.inputs["Roughness"].default_value = 0.9
bsdf.inputs["Sheen Weight"].default_value = 1.0
bsdf.inputs["Sheen Roughness"].default_value = 0.5
'''
    )


def _glass_script(name: str) -> str:
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1)
bsdf.inputs["Roughness"].default_value = 0.05
bsdf.inputs["Transmission Weight"].default_value = 1.0
bsdf.inputs["IOR"].default_value = 1.45
'''
    )


def _skin_script(name: str) -> str:
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.55, 0.35, 0.25, 1)
bsdf.inputs["Roughness"].default_value = 0.6
bsdf.inputs["Subsurface Weight"].default_value = 0.4
# NOTE: Blender 4.2's Principled BSDF has no "Subsurface Color" input —
# subsurface takes its colour from Base Color. Setting it raises KeyError.
bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.2, 0.1)
'''
    )


def _sandstone_script(name: str, dark=(0.75, 0.6, 0.35, 1), light=(0.9, 0.78, 0.55, 1)) -> str:
    return (
        _node_header(name)
        + _noise_block(8.0)
        + _ramp_block(dark, light)
        + _bump_block(0.4)
        + '''
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.9
'''
    )


def _smooth_leather_script(name: str, base=(0.16, 0.12, 0.10, 1)) -> str:
    """Smooth leather for straps / cushions — deliberately NO noise nodes.

    v1.3.0 fix: the v1.3.0 smartwatch strap used ``fabric`` (Noise -> Bump
    at scale 25, Generated coordinates). On a 22 mm strap that noise reads
    as a scribbled artifact under studio light. A real strap is smooth at
    this scale: plain Principled + a little sheen, nothing else.
    """
    return (
        _node_header(name)
        + f'''
bsdf.inputs["Base Color"].default_value = {tuple(base)}
bsdf.inputs["Roughness"].default_value = 0.7
bsdf.inputs["Sheen Weight"].default_value = 0.3
bsdf.inputs["Sheen Roughness"].default_value = 0.6
'''
    )


def _matte_plastic_script(name: str, base=(0.05, 0.05, 0.05, 1)) -> str:
    """Matte plastic — plain Principled, no noise (headphone cups/bands)."""
    return (
        _node_header(name)
        + f'''
bsdf.inputs["Base Color"].default_value = {tuple(base)}
bsdf.inputs["Roughness"].default_value = 0.55
bsdf.inputs["Metallic"].default_value = 0.0
'''
    )


def _rubber_script(name: str) -> str:
    """Rubber (soles, cushions) — near-black, very rough, no noise."""
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.03, 0.03, 0.03, 1)
bsdf.inputs["Roughness"].default_value = 0.95
bsdf.inputs["Metallic"].default_value = 0.0
'''
    )


def _white_leather_script(name: str) -> str:
    """Off-white sneaker leather — plain Principled, slight sheen, no noise."""
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.93, 0.92, 0.90, 1)
bsdf.inputs["Roughness"].default_value = 0.5
bsdf.inputs["Sheen Weight"].default_value = 0.5
bsdf.inputs["Sheen Roughness"].default_value = 0.5
'''
    )


def _amber_liquid_script(name: str) -> str:
    """Amber perfume liquid — mostly transmissive, warm amber colour."""
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.85, 0.45, 0.12, 1)
bsdf.inputs["Roughness"].default_value = 0.05
bsdf.inputs["Transmission Weight"].default_value = 0.85
bsdf.inputs["IOR"].default_value = 1.33
'''
    )


def _polished_steel_script(name: str) -> str:
    """Polished steel for small metal parts (yokes, rings, crowns) — NO
    noise nodes. The ``metal``/``steel`` builders put Noise into roughness
    + bump, which reads as a streaky/scratchy strip on a 5 mm yoke."""
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.85, 0.85, 0.86, 1)
bsdf.inputs["Roughness"].default_value = 0.25
bsdf.inputs["Metallic"].default_value = 0.9
'''
    )


def _white_script(name: str) -> str:
    """Plain white (labels, watch markers/hands) — no noise."""
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.95, 0.95, 0.95, 1)
bsdf.inputs["Roughness"].default_value = 0.4
bsdf.inputs["Metallic"].default_value = 0.0
'''
    )


def _accent_red_script(name: str) -> str:
    """Sneaker accent red — plain Principled, no noise."""
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.65, 0.08, 0.08, 1)
bsdf.inputs["Roughness"].default_value = 0.5
bsdf.inputs["Metallic"].default_value = 0.0
'''
    )


def _black_script(name: str) -> str:
    """Glossy black (eyes, lenses, trim): near-black, low roughness."""
    return _node_header(name) + (
        '\nbsdf.inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1)'
        '\nbsdf.inputs["Roughness"].default_value = 0.15'
        '\nbsdf.inputs["Metallic"].default_value = 0.0\n'
    )


# material name -> builder (name is passed through so the material keeps it)
_NODE_BUILDERS = {
    "wood": _wood_script,
    "marble": lambda n: _marble_script(n),
    "red_marble": lambda n: _marble_script(n, base=(0.8, 0.3, 0.25, 1), vein=(0.35, 0.08, 0.06, 1)),
    "green_marble": lambda n: _marble_script(n, base=(0.2, 0.5, 0.3, 1), vein=(0.05, 0.2, 0.1, 1)),
    "metal": _metal_script,
    "gold": lambda n: _metal_script(n, tint=(1.0, 0.76, 0.33, 1)),
    "copper": lambda n: _metal_script(n, tint=(0.95, 0.64, 0.54, 1)),
    "brass": lambda n: _metal_script(n, tint=(0.85, 0.7, 0.3, 1)),
    "steel": lambda n: _metal_script(n, tint=(0.85, 0.85, 0.86, 1), metallic=0.9,
                                     rough_lo=0.3, rough_hi=0.4),
    "fabric": _fabric_script,
    "smooth_leather": _smooth_leather_script,
    "brown_leather": lambda n: _smooth_leather_script(n, base=(0.32, 0.20, 0.12, 1)),
    "black_leather": lambda n: _smooth_leather_script(n, base=(0.05, 0.05, 0.05, 1)),
    "matte_plastic": _matte_plastic_script,
    "rubber": _rubber_script,
    "white_leather": _white_leather_script,
    "amber_liquid": _amber_liquid_script,
    "polished_steel": _polished_steel_script,
    "white": _white_script,
    "accent_red": _accent_red_script,
    "glass": _glass_script,
    "skin": _skin_script,
    "sandstone": _sandstone_script,
    "stone": lambda n: _sandstone_script(n, dark=(0.55, 0.53, 0.5, 1), light=(0.68, 0.66, 0.63, 1)),
    "terracotta": lambda n: _sandstone_script(n, dark=(0.72, 0.4, 0.26, 1), light=(0.85, 0.52, 0.34, 1)),
    "black": _black_script,
}


class MaterialLibrary:
    """Built-in procedural material generation (materials v2)."""

    MATERIALS = {
        # Kept for backwards compatibility: the flat-colour table used by
        # the fallback path and by older callers.
        "marble": {"base_color": (0.95, 0.95, 0.95, 1), "roughness": 0.1, "metallic": 0.0},
        "red_marble": {"base_color": (0.8, 0.3, 0.25, 1), "roughness": 0.15, "metallic": 0.1},
        "green_marble": {"base_color": (0.2, 0.5, 0.3, 1), "roughness": 0.15, "metallic": 0.1},
        "wood": {"base_color": (0.35, 0.2, 0.1, 1), "roughness": 0.7, "metallic": 0.0},
        "gold": {"base_color": (1.0, 0.76, 0.33, 1), "roughness": 0.2, "metallic": 1.0},
        "copper": {"base_color": (0.95, 0.64, 0.54, 1), "roughness": 0.3, "metallic": 1.0},
        "brass": {"base_color": (0.85, 0.7, 0.3, 1), "roughness": 0.4, "metallic": 1.0},
        "stone": {"base_color": (0.6, 0.58, 0.55, 1), "roughness": 0.85, "metallic": 0.0},
        "sandstone": {"base_color": (0.85, 0.75, 0.6, 1), "roughness": 0.9, "metallic": 0.0},
        "terracotta": {"base_color": (0.8, 0.45, 0.3, 1), "roughness": 0.85, "metallic": 0.0},
        "black": {"base_color": (0.02, 0.02, 0.02, 1), "roughness": 0.15, "metallic": 0.0},
        "smooth_leather": {"base_color": (0.16, 0.12, 0.10, 1), "roughness": 0.7, "metallic": 0.0},
        "brown_leather": {"base_color": (0.32, 0.20, 0.12, 1), "roughness": 0.7, "metallic": 0.0},
        "black_leather": {"base_color": (0.05, 0.05, 0.05, 1), "roughness": 0.7, "metallic": 0.0},
        "matte_plastic": {"base_color": (0.05, 0.05, 0.05, 1), "roughness": 0.55, "metallic": 0.0},
        "rubber": {"base_color": (0.03, 0.03, 0.03, 1), "roughness": 0.95, "metallic": 0.0},
        "white_leather": {"base_color": (0.93, 0.92, 0.90, 1), "roughness": 0.5, "metallic": 0.0},
        "amber_liquid": {"base_color": (0.85, 0.45, 0.12, 1), "roughness": 0.05, "metallic": 0.0},
        "polished_steel": {"base_color": (0.85, 0.85, 0.86, 1), "roughness": 0.25, "metallic": 0.9},
        "white": {"base_color": (0.95, 0.95, 0.95, 1), "roughness": 0.4, "metallic": 0.0},
        "accent_red": {"base_color": (0.65, 0.08, 0.08, 1), "roughness": 0.5, "metallic": 0.0},
    }

    # Backwards-compatible alias: the old flat table.
    FLAT_MATERIALS = FLAT_MATERIALS

    @classmethod
    def get_material_script(cls, material_type: str) -> str:
        """Generate a procedural material script.

        Returns a bpy snippet that creates a material named after
        ``material_type`` and leaves it in the ``mat`` variable. Known
        names get a Principled BSDF node tree; unknown names fall back to
        a flat Principled colour (stone grey).
        """
        key = (material_type or "").lower().strip()
        builder = _NODE_BUILDERS.get(key)
        if builder is not None:
            return builder(material_type)
        mat = FLAT_MATERIALS["stone"]
        return _flat_script(material_type, mat["base_color"], mat["roughness"], mat["metallic"])


# ---------------------------------------------------------------------------
# Smart UV
# ---------------------------------------------------------------------------

def get_smart_uv_script() -> str:
    """Blender snippet: Smart UV Project every object in ``targets``.

    Run before any image-texture application. ``targets`` must be a list of
    mesh objects defined earlier in the same script. Angle limit 66 degrees
    (converted to radians — the operator takes radians), island margin 0.02.
    """
    return '''
for obj in targets:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)
'''


# ---------------------------------------------------------------------------
# Poly Haven textures
# ---------------------------------------------------------------------------

def pick_polyhaven_maps(files: dict, resolution: str = "1k") -> dict:
    """Pick the 1k map URLs out of a GET /files/<slug> response.

    Returns {role: url} for the roles we wire: color, roughness,
    roughness_from_arm, normal, displacement, ao. Raises ValueError if
    no usable maps exist at the requested resolution.
    """
    def url_for(map_key: str, fmt: str = "jpg"):
        entry = files.get(map_key)
        if not isinstance(entry, dict):
            return None
        res = entry.get(resolution)
        if not isinstance(res, dict):
            return None
        fmt_entry = res.get(fmt) or res.get("png") or res.get("exr")
        if isinstance(fmt_entry, dict):
            return fmt_entry.get("url")
        return None

    maps = {}
    color = url_for("Diffuse")
    if color:
        maps["color"] = color
    rough = url_for("Rough")
    if rough:
        maps["roughness"] = rough
    elif url_for("arm"):
        # ARM texture: R=AO, G=Roughness, B=Metallic (split in the shader).
        maps["roughness_from_arm"] = url_for("arm")
    normal = url_for("nor_gl")
    if normal:
        maps["normal"] = normal
    disp = url_for("Displacement")
    if disp:
        maps["displacement"] = disp
    ao = url_for("AO")
    if ao:
        maps["ao"] = ao
    if not maps:
        raise ValueError(f"No usable {resolution} maps found for this asset")
    if "color" not in maps:
        raise ValueError(f"No {resolution} Diffuse (colour) map found for this asset")
    return maps


def build_polyhaven_material_script(slug: str, maps: dict, material_name: str) -> str:
    """Blender snippet: build a Principled material from downloaded maps.

    ``maps`` is {role: local_file_path}. Colour space is set correctly
    (sRGB for colour, Non-Color for data maps), normals go through a
    Normal Map node, ARM textures are split with SeparateRGB, images are
    packed into the .blend, and provenance is written as custom
    properties on the material. Leaves the material in ``mat``.
    """
    lines = [f'''
mat = bpy.data.materials.new(name={json.dumps(material_name)})
mat.use_nodes = True
nt = mat.node_tree
nodes = nt.nodes
links = nt.links
bsdf = nodes["Principled BSDF"]
texcoord = nodes.new("ShaderNodeTexCoord")
texcoord.location = (-800, 0)
mapping = nodes.new("ShaderNodeMapping")
mapping.location = (-600, 0)
links.new(texcoord.outputs["Generated"], mapping.inputs["Vector"])
''']

    y = 300

    def image_node(role: str, path: str, colorspace: str) -> str:
        nonlocal y
        node = f'''
img_{role} = nodes.new("ShaderNodeTexImage")
img_{role}.location = (-400, {y})
img_{role}.image = bpy.data.images.load({json.dumps(path)})
img_{role}.image.colorspace_settings.name = {json.dumps(colorspace)}
img_{role}.image.pack()
links.new(mapping.outputs["Vector"], img_{role}.inputs["Vector"])
'''
        y -= 250
        return node

    if "color" in maps:
        lines.append(image_node("color", maps["color"], "sRGB"))
        if "ao" in maps:
            lines.append(image_node("ao", maps["ao"], "Non-Color"))
            lines.append('''
mix_ao = nodes.new("ShaderNodeMixRGB")
mix_ao.blend_type = 'MULTIPLY'
mix_ao.inputs[0].default_value = 1.0
links.new(img_color.outputs["Color"], mix_ao.inputs[1])
links.new(img_ao.outputs["Color"], mix_ao.inputs[2])
links.new(mix_ao.outputs["Color"], bsdf.inputs["Base Color"])
''')
        else:
            lines.append('links.new(img_color.outputs["Color"], bsdf.inputs["Base Color"])')
    if "roughness" in maps:
        lines.append(image_node("roughness", maps["roughness"], "Non-Color"))
        lines.append('links.new(img_roughness.outputs["Color"], bsdf.inputs["Roughness"])')
    if "roughness_from_arm" in maps:
        lines.append(image_node("arm", maps["roughness_from_arm"], "Non-Color"))
        lines.append('''
arm_split = nodes.new("ShaderNodeSeparateRGB")
arm_split.location = (-150, 0)
links.new(img_arm.outputs["Color"], arm_split.inputs["Image"])
links.new(arm_split.outputs["G"], bsdf.inputs["Roughness"])
links.new(arm_split.outputs["B"], bsdf.inputs["Metallic"])
''')
    if "normal" in maps:
        lines.append(image_node("normal", maps["normal"], "Non-Color"))
        lines.append('''
normal_map = nodes.new("ShaderNodeNormalMap")
normal_map.location = (-150, -250)
links.new(img_normal.outputs["Color"], normal_map.inputs["Color"])
links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
''')
    if "displacement" in maps:
        lines.append(image_node("displacement", maps["displacement"], "Non-Color"))
        lines.append('''
disp = nodes.new("ShaderNodeDisplacement")
disp.location = (-150, -500)
disp.inputs["Scale"].default_value = 0.1
links.new(img_displacement.outputs["Color"], disp.inputs["Height"])
links.new(disp.outputs["Displacement"], nt.nodes["Material Output"].inputs["Displacement"])
''')

    lines.append(f'''
# Provenance (Poly Haven, CC0) — written onto the material.
mat["polyhaven_id"] = {json.dumps(slug)}
mat["polyhaven_url"] = {json.dumps("https://polyhaven.com/textures/" + slug)}
mat["polyhaven_licence"] = {json.dumps(POLYHAVEN_LICENCE)}
''')
    return "\n".join(lines)
