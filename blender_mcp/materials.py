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
- coffee:     very dark brown (0.09, 0.045, 0.02), Roughness 0.7 — the
  coffee surface (v1.4.0 fix: without this it fell back to stone grey)
- steel:     Metallic 0.9, Roughness 0.35
- glass:     Transmission 1, IOR 1.45, Roughness 0.05
- skin:      Subsurface 0.4, warm brown
- sandstone: Noise -> warm golden colour + Bump

Cinematic materials (v1.4.0, research report §3):
- weathered_stone: patchy Noise colour + Voronoi cracks + Pointiness edge
  wear (x Noise) + AO cavity grime + Bump — the reference head
- brushed_aluminium: Metallic 1.0, Anisotropic 0.9, Radial-Z tangent,
  stretched Noise -> Roughness 0.3-0.4 + Bump — can lids/rims/bases
- printed_can: THE printed-can rule — Metallic 0.0 + Coat 1.0/0.08 (lacquer
  over the print); metallic only on unprinted metal, never the printed body
- wet_floor: Noise puddle mask -> Roughness (puddle 0.02, dry 0.6) + wet
  darkening + Bump — the reference's wet reflective floor
- emissive_teal / emissive_amber: Emission Strength 3.0 glow (rings/strips;
  needs a Compositor Glare node to bloom in Cycles)

Unknown material names still fall back to a flat Principled colour (stone).

Also in this module: the Smart UV helper (run before any image-texture
application) and the Poly Haven texture builders (API -> 1k maps ->
colour-space-correct node tree, images packed into the .blend, provenance
written as custom properties on the material).
"""

import json

POLYHAVEN_API = "https://api.polyhaven.com"
USER_AGENT = "blender-mcp/1.4.0 (https://github.com/IamNishant51/Blender-MCP)"
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


def _coffee_script(name: str) -> str:
    """Black coffee surface — very dark brown, soft sheen (Roughness 0.7).

    v1.4.0 fix: the coffee_mug dimension-library part uses material
    "coffee", but no builder existed, so it silently fell back to the
    flat stone-grey fallback (0.6, 0.58, 0.55) — the v1.3.1 demo mug
    rendered with a pale grey/white surface that read as a lid. A real
    coffee surface is near-black brown, not grey. Roughness is 0.7, not
    0.35: the disc faces up and the camera looks down at ~67 deg from
    its normal, where the Fresnel specular is strong — at 0.35 the disc
    mirror-washed to pale grey-blue (cinematic) and near-white (studio)
    by reflecting the cool fill light and fog, even though the diffuse
    brown was correct; 0.7 spreads the specular lobe so the diffuse
    brown reads with only a soft sheen. Specular IOR Level is 0.0
    (default 0.5): 0.7 alone only dimmed the wash to grey-blue, so the
    mirror is removed entirely — a dark liquid in this rig has no
    visible sheen once the mirror is gone, and a mirror-washed disc
    reads as a lid.
    """
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.09, 0.045, 0.02, 1)
bsdf.inputs["Roughness"].default_value = 0.7
bsdf.inputs["Metallic"].default_value = 0.0
bsdf.inputs["Specular IOR Level"].default_value = 0.0
'''
    )


def _ceramic_script(name: str) -> str:
    """White glazed ceramic — the mug body. Same silent-fallback class as
    coffee: "ceramic" had no builder and fell back to stone grey, which
    only passed as white ceramic under bright studio light."""
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.95, 0.95, 0.95, 1)
bsdf.inputs["Roughness"].default_value = 0.3
bsdf.inputs["Metallic"].default_value = 0.0
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


# ---------------------------------------------------------------------------
# Cinematic materials (v1.4.0) — see research report §3.
#
# Scale note (research §3.9, the v1.3.0 strap lesson): every Noise/Voronoi
# scale below is tuned for its intended subject size in Generated
# coordinates (weathered_stone ~3 m head, wet_floor a large floor,
# brushed_aluminium a can lid). They are NOT size-derived: get_material_script
# receives no object size. If a builder is used on a wildly different
# scale, the grain will read wrong — that is a known gap, not a silent
# default (see report §9). The render preset's fog/hall/floor ARE
# size-derived from the hero bounding box.
# ---------------------------------------------------------------------------

def _weathered_stone_script(name: str) -> str:
    """Weathered stone (the reference head): patchy colour, Voronoi cracks,
    Pointiness edge wear, AO cavity grime, top dust — research §3.8.

    Chain: Noise -> Base Color variation; Voronoi F1 thin dark veins mixed
    in as cracks; Geometry Pointiness -> ColorRamp -> Mix with a lighter
    worn colour on convex edges (x high-frequency Noise so the edge is
    patchy, not a perfect outline); AO node (Distance 0.1 m) darkens
    cavities. Bevel *modifier* on the mesh is preferred for edge rounding;
    the Bevel shader node is Cycles-only at ~+20% render time.
    """
    return _node_header(name) + '''
# Patchy stone colour: large Noise -> warm grey-brown band.
stone_noise = nodes.new("ShaderNodeTexNoise")
stone_noise.location = (-600, 300)
stone_noise.inputs["Scale"].default_value = 4.0
stone_noise.inputs["Detail"].default_value = 3.0
links.new(texcoord.outputs["Generated"], stone_noise.inputs["Vector"])
stone_ramp = nodes.new("ShaderNodeValToRGB")
stone_ramp.location = (-400, 300)
stone_ramp.color_ramp.elements[0].position = 0.0
stone_ramp.color_ramp.elements[0].color = (0.55, 0.45, 0.32, 1)
stone_ramp.color_ramp.elements[1].position = 1.0
stone_ramp.color_ramp.elements[1].color = (0.78, 0.66, 0.48, 1)
links.new(stone_noise.outputs["Fac"], stone_ramp.inputs["Fac"])
# Thin dark cracks: Voronoi F1 distance -> ramp (dark at 0, white by 0.12).
vein = nodes.new("ShaderNodeTexVoronoi")
vein.location = (-600, 100)
vein.inputs["Scale"].default_value = 10.0
vein.feature = 'F1'
vein.distance = 'EUCLIDEAN'
links.new(texcoord.outputs["Generated"], vein.inputs["Vector"])
vein_ramp = nodes.new("ShaderNodeValToRGB")
vein_ramp.location = (-400, 100)
vein_ramp.color_ramp.elements[0].position = 0.0
vein_ramp.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1)
vein_ramp.color_ramp.elements[1].position = 1.0
vein_ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
vein_stop = vein_ramp.color_ramp.elements.new(0.12)
vein_stop.color = (1.0, 1.0, 1.0, 1)
links.new(vein.outputs["Distance"], vein_ramp.inputs["Fac"])
crack_mix = nodes.new("ShaderNodeMixRGB")
crack_mix.location = (-200, 200)
crack_mix.blend_type = 'MIX'
crack_mix.inputs[1].default_value = (0.12, 0.1, 0.08, 1)
links.new(vein_ramp.outputs["Color"], crack_mix.inputs[0])
links.new(stone_ramp.outputs["Color"], crack_mix.inputs[2])
# Edge wear: Pointiness (convex > 0.5, flat = 0.5) -> ramp (white > 0.65)
# x high-frequency Noise so the worn edge is patchy, not a perfect outline.
geom = nodes.new("ShaderNodeNewGeometry")
geom.location = (-600, -100)
wear_noise = nodes.new("ShaderNodeTexNoise")
wear_noise.location = (-600, -300)
wear_noise.inputs["Scale"].default_value = 25.0
wear_noise.inputs["Detail"].default_value = 2.0
links.new(texcoord.outputs["Generated"], wear_noise.inputs["Vector"])
wear_ramp = nodes.new("ShaderNodeValToRGB")
wear_ramp.location = (-400, -100)
wear_ramp.color_ramp.interpolation = 'EASE'
wear_ramp.color_ramp.elements[0].position = 0.5
wear_ramp.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1)
wear_ramp.color_ramp.elements[1].position = 0.65
wear_ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
links.new(geom.outputs["Pointiness"], wear_ramp.inputs["Fac"])
wear_mult = nodes.new("ShaderNodeMath")
wear_mult.location = (-200, -100)
wear_mult.operation = 'MULTIPLY'
links.new(wear_ramp.outputs["Color"], wear_mult.inputs[0])
links.new(wear_noise.outputs["Fac"], wear_mult.inputs[1])
wear_mix = nodes.new("ShaderNodeMixRGB")
wear_mix.location = (0, 200)
wear_mix.blend_type = 'MIX'
wear_mix.inputs[2].default_value = (0.92, 0.86, 0.74, 1)
links.new(wear_mult.outputs["Value"], wear_mix.inputs[0])
links.new(crack_mix.outputs["Color"], wear_mix.inputs[1])
# Cavity grime: AO (Distance = feature size) darkens crevices. The AO
# shader node is expensive in Cycles — it is used here, on the ONE hero
# stone material, never on every material in a scene.
ao = nodes.new("ShaderNodeAmbientOcclusion")
ao.location = (-400, -300)
ao.inputs["Distance"].default_value = 0.1
ao.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1)
grime_ramp = nodes.new("ShaderNodeValToRGB")
grime_ramp.location = (-200, -300)
grime_ramp.color_ramp.elements[0].position = 0.0
grime_ramp.color_ramp.elements[0].color = (0.6, 0.6, 0.6, 1)
grime_ramp.color_ramp.elements[1].position = 0.3
grime_ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
links.new(ao.outputs["Color"], grime_ramp.inputs["Fac"])
grime_mix = nodes.new("ShaderNodeMixRGB")
grime_mix.location = (200, 200)
grime_mix.blend_type = 'MULTIPLY'
grime_mix.inputs[1].default_value = (1.0, 1.0, 1.0, 1)
links.new(grime_ramp.outputs["Color"], grime_mix.inputs[2])
links.new(wear_mix.outputs["Color"], grime_mix.inputs[1])
links.new(grime_mix.outputs["Color"], bsdf.inputs["Base Color"])
# Bump from the same large noise (Distance 0.02 m — the 1.0 default is 1 m,
# far too big for products).
stone_bump = nodes.new("ShaderNodeBump")
stone_bump.location = (-200, -500)
stone_bump.inputs["Strength"].default_value = 0.3
stone_bump.inputs["Distance"].default_value = 0.02
links.new(stone_noise.outputs["Fac"], stone_bump.inputs["Height"])
links.new(stone_bump.outputs["Normal"], bsdf.inputs["Normal"])
bsdf.inputs["Roughness"].default_value = 0.85
'''


def _brushed_aluminium_script(name: str) -> str:
    """Brushed aluminium (can lids, rims, bases — NOT the printed body):
    Metallic 1.0, Anisotropic 0.9, Radial-Z tangent (circular brushing on
    a disc), stretched Noise -> Roughness (0.3-0.4) + Bump. Anisotropic is
    Cycles-only — EEVEE silently ignores it; the stretched-roughness grain
    is kept anyway so the brushed cue survives in EEVEE too.
    """
    return _node_header(name) + '''
# Stretched noise: Mapping scale (1, 200, 1) elongates the cells into
# brush streaks along one axis.
brush_map = nodes.new("ShaderNodeMapping")
brush_map.location = (-700, 200)
brush_map.inputs["Scale"].default_value = (1.0, 200.0, 1.0)
links.new(texcoord.outputs["Generated"], brush_map.inputs["Vector"])
brush_noise = nodes.new("ShaderNodeTexNoise")
brush_noise.location = (-600, 200)
brush_noise.inputs["Scale"].default_value = 8.0
brush_noise.inputs["Detail"].default_value = 2.0
links.new(brush_map.outputs["Vector"], brush_noise.inputs["Vector"])
brush_ramp = nodes.new("ShaderNodeValToRGB")
brush_ramp.location = (-400, 200)
brush_ramp.color_ramp.elements[0].position = 0.0
brush_ramp.color_ramp.elements[0].color = (0.3, 0.3, 0.3, 1)
brush_ramp.color_ramp.elements[1].position = 1.0
brush_ramp.color_ramp.elements[1].color = (0.4, 0.4, 0.4, 1)
links.new(brush_noise.outputs["Fac"], brush_ramp.inputs["Fac"])
links.new(brush_ramp.outputs["Color"], bsdf.inputs["Roughness"])
brush_bump = nodes.new("ShaderNodeBump")
brush_bump.location = (-400, -200)
brush_bump.inputs["Strength"].default_value = 0.3
brush_bump.inputs["Distance"].default_value = 0.01
links.new(brush_noise.outputs["Fac"], brush_bump.inputs["Height"])
links.new(brush_bump.outputs["Normal"], bsdf.inputs["Normal"])
# Circular brushing on a disc: Tangent node, Radial, axis Z.
tangent = nodes.new("ShaderNodeTangent")
tangent.location = (-400, 0)
tangent.direction_type = 'RADIAL'
tangent.axis = 'Z'
links.new(tangent.outputs["Tangent"], bsdf.inputs["Tangent"])
bsdf.inputs["Base Color"].default_value = (0.85, 0.85, 0.86, 1)
bsdf.inputs["Metallic"].default_value = 1.0
bsdf.inputs["Anisotropic"].default_value = 0.9
bsdf.inputs["Anisotropic Rotation"].default_value = 0.25
'''


def _printed_can_script(name: str) -> str:
    """Printed drink-can body — THE printed-can rule, encoded, not a
    suggestion: a printed can is paint/lacquer over aluminium, NOT
    anodised colour. Metallic 1.0 + a coloured Base Color renders dark
    and desaturated (metallic tints only the specular; there is no
    diffuse). Correct: Metallic 0.0 + label artwork in Base Color + a
    clear Coat (Weight 1.0, Roughness 0.08, IOR 1.5) as the lacquer over
    the print. Default colour is matte black; the label texture is applied
    by the caller (apply_label / image texture in Base Color). Metallic
    1.0 belongs only on unprinted metal: lid/rim/tab/base — see
    brushed_aluminium / polished_steel.
    """
    return (
        _node_header(name)
        + '''
bsdf.inputs["Base Color"].default_value = (0.03, 0.03, 0.04, 1)
bsdf.inputs["Roughness"].default_value = 0.3
bsdf.inputs["Metallic"].default_value = 0.0
bsdf.inputs["Coat Weight"].default_value = 1.0
bsdf.inputs["Coat Roughness"].default_value = 0.08
bsdf.inputs["Coat IOR"].default_value = 1.5
'''
    )


def _wet_floor_script(name: str) -> str:
    """Wet reflective floor as a named material (the render preset builds
    the same node tree inline for the ground plane): Noise puddle mask ->
    Roughness (puddle 0.02, dry 0.6) + wet darkening in Base Color + a
    little bump so reflections ripple instead of mirroring perfectly.
    Never pure-white dry roughness; never exactly 0.0 puddle roughness
    over a large area. Scale is tuned for Generated coordinates on a
    large floor (see the scale note at the top of this section).
    """
    return _node_header(name) + '''
floor_noise = nodes.new("ShaderNodeTexNoise")
floor_noise.location = (-600, 200)
floor_noise.inputs["Scale"].default_value = 8.0
floor_noise.inputs["Detail"].default_value = 3.0
links.new(texcoord.outputs["Generated"], floor_noise.inputs["Vector"])
floor_ramp = nodes.new("ShaderNodeValToRGB")
floor_ramp.location = (-400, 200)
floor_ramp.color_ramp.elements[0].position = 0.45
floor_ramp.color_ramp.elements[0].color = (0.02, 0.02, 0.02, 1)
floor_ramp.color_ramp.elements[1].position = 0.62
floor_ramp.color_ramp.elements[1].color = (0.6, 0.6, 0.6, 1)
links.new(floor_noise.outputs["Fac"], floor_ramp.inputs["Fac"])
links.new(floor_ramp.outputs["Color"], bsdf.inputs["Roughness"])
floor_cramp = nodes.new("ShaderNodeValToRGB")
floor_cramp.location = (-400, 0)
floor_cramp.color_ramp.elements[0].position = 0.45
floor_cramp.color_ramp.elements[0].color = (0.008, 0.008, 0.01, 1)
floor_cramp.color_ramp.elements[1].position = 0.62
floor_cramp.color_ramp.elements[1].color = (0.02, 0.02, 0.022, 1)
links.new(floor_noise.outputs["Fac"], floor_cramp.inputs["Fac"])
links.new(floor_cramp.outputs["Color"], bsdf.inputs["Base Color"])
floor_bump = nodes.new("ShaderNodeBump")
floor_bump.location = (-400, -200)
floor_bump.inputs["Strength"].default_value = 0.05
floor_bump.inputs["Distance"].default_value = 0.01
links.new(floor_noise.outputs["Fac"], floor_bump.inputs["Height"])
links.new(floor_bump.outputs["Normal"], bsdf.inputs["Normal"])
bsdf.inputs["Metallic"].default_value = 0.0
'''


def _emissive_script(name: str, color=(0.0, 0.85, 1.0), strength: float = 3.0) -> str:
    """Emissive glow material (rings, strips, logos). Emission Strength
    2-5 for a can ring, 5-10 for hero strips; 1.0 is flat colour, not
    glow; never exceed 10 on a large area in Cycles (fireflies). The
    glow itself needs a Compositor Glare node to bloom — emission alone
    does not bloom in Cycles (see the cinematic render preset).
    """
    return (
        _node_header(name)
        + f'''
bsdf.inputs["Base Color"].default_value = (0.01, 0.01, 0.01, 1)
bsdf.inputs["Emission Color"].default_value = ({color[0]}, {color[1]}, {color[2]}, 1)
bsdf.inputs["Emission Strength"].default_value = {strength}
'''
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
    "coffee": _coffee_script,
    "ceramic": _ceramic_script,
    "polished_steel": _polished_steel_script,
    "white": _white_script,
    "accent_red": _accent_red_script,
    "glass": _glass_script,
    "skin": _skin_script,
    "sandstone": _sandstone_script,
    "stone": lambda n: _sandstone_script(n, dark=(0.55, 0.53, 0.5, 1), light=(0.68, 0.66, 0.63, 1)),
    "terracotta": lambda n: _sandstone_script(n, dark=(0.72, 0.4, 0.26, 1), light=(0.85, 0.52, 0.34, 1)),
    "black": _black_script,
    # Cinematic (v1.4.0).
    "weathered_stone": _weathered_stone_script,
    "brushed_aluminium": _brushed_aluminium_script,
    "printed_can": _printed_can_script,
    "wet_floor": _wet_floor_script,
    "emissive_teal": lambda n: _emissive_script(n, color=(0.0, 0.85, 1.0), strength=3.0),
    "emissive_amber": lambda n: _emissive_script(n, color=(1.0, 0.55, 0.2), strength=3.0),
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
        "coffee": {"base_color": (0.09, 0.045, 0.02, 1), "roughness": 0.7, "metallic": 0.0},
        "ceramic": {"base_color": (0.95, 0.95, 0.95, 1), "roughness": 0.3, "metallic": 0.0},
        "polished_steel": {"base_color": (0.85, 0.85, 0.86, 1), "roughness": 0.25, "metallic": 0.9},
        "white": {"base_color": (0.95, 0.95, 0.95, 1), "roughness": 0.4, "metallic": 0.0},
        "accent_red": {"base_color": (0.65, 0.08, 0.08, 1), "roughness": 0.5, "metallic": 0.0},
        # Cinematic (v1.4.0) — flat-table entries for backwards compatibility.
        "weathered_stone": {"base_color": (0.8, 0.7, 0.55, 1), "roughness": 0.85, "metallic": 0.0},
        "brushed_aluminium": {"base_color": (0.85, 0.85, 0.86, 1), "roughness": 0.3, "metallic": 1.0},
        "printed_can": {"base_color": (0.03, 0.03, 0.04, 1), "roughness": 0.3, "metallic": 0.0},
        "wet_floor": {"base_color": (0.02, 0.02, 0.022, 1), "roughness": 0.6, "metallic": 0.0},
        "emissive_teal": {"base_color": (0.01, 0.01, 0.01, 1), "roughness": 0.4, "metallic": 0.0},
        "emissive_amber": {"base_color": (0.01, 0.01, 0.01, 1), "roughness": 0.4, "metallic": 0.0},
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
