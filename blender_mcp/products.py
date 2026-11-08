"""Proper product builders (Blender-MCP 1.3.0 fix round) — ``build_product``.

The v1.3.0 demo products were built from stacked primitives (a straight
bar for a headband, rods floating above a shoe, a blank slab for a watch
face) and the user rejected the renders outright ("not good at all").
These builders rebuild each product PROPERLY, with real curves:

- headphones: arched band + inner cushion as swept rectangular strips
  along a real arc (no straight bar), yokes, cups with a padded torus
  cushion ring, recessed driver and a metal outer ring.
- sneaker: lofted sole with a real footprint taper and toe spring,
  lofted upper, toe cap, heel counter, tongue, bezier-curve laces
  through metal eyelets — no floating rods, no detached boxes.
- perfume: bevelled glass body (no 90-degree edges), amber liquid,
  gold neck ring, bevelled cap SEATED on the neck (bottom overlaps the
  ring — no floating gap), NOIR label.
- smartwatch: bevelled case, real dial (12 markers, hands at 10:10,
  crown + button), curved bezier strap in smooth leather. The PRIMARY
  smartwatch path is the retrieved Poly Haven model
  (``retrieve_asset`` / ``KNOWN_GOOD_ASSETS``) — this procedural
  builder is the fallback when no asset is available.

Shared rules (the v1.3.0 lessons, now code, not comments elsewhere):

- Every builder emits one bpy script string (host-side, like spec.py):
  it clears the scene, builds with real dimensions in metres, Z-up,
  ground z = 0, and returns the script for ``create_mesh_with_report``.
- No procedural Noise/Voronoi texture on any small part: straps and
  cushions use ``smooth_leather`` (plain Principled — the v1.3.0 watch
  strap's fabric Noise->Bump read as a scribbled artifact).
- No floating parts: every part touches the part it belongs to (laces
  sit ON the tongue, the cap overlaps the neck ring, cushions touch
  the band). A part that cannot touch is not emitted.
"""

import json
import math

from blender_mcp.materials import MaterialLibrary

PRODUCTS = {
    "headphones": {
        "description": "Over-ear headphones: arched band, padded cups, metal yokes.",
        "real_size_m": [0.21, 0.10, 0.23],
        "source": "procedural",
    },
    "sneaker": {
        "description": "Running sneaker: lofted sole with toe spring, laced upper.",
        "real_size_m": [0.28, 0.10, 0.11],
        "source": "procedural",
    },
    "perfume": {
        "description": "Perfume bottle: bevelled glass, amber liquid, gold cap, NOIR label.",
        "real_size_m": [0.08, 0.045, 0.15],
        "source": "procedural",
    },
    "smartwatch": {
        "description": "Smartwatch: bevelled case, real dial, curved leather strap.",
        "real_size_m": [0.24, 0.046, 0.02],
        "source": "retrieved-preferred",
        "retrieved_asset": "digital_wrist_watch",
    },
}


# ---------------------------------------------------------------------------
# Script prelude: helpers shared by every builder
# ---------------------------------------------------------------------------

_PRELUDE = '''
import bpy, math
from mathutils import Vector

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

def _smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True

def _bevel(obj, width, segments=3):
    mod = obj.modifiers.new(name="SoftEdge", type='BEVEL')
    mod.width = width
    mod.segments = segments
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)

def _catmull_rom(points, samples_per_seg=8):
    """Smooth spine through control points (Catmull-Rom, Z-up safe)."""
    pts = [Vector(p) for p in points]
    out = []
    n = len(pts)
    for i in range(n - 1):
        p0 = pts[i - 1] if i > 0 else pts[i]
        p1 = pts[i]
        p2 = pts[i + 1]
        p3 = pts[i + 2] if i + 2 < n else pts[i + 1]
        for j in range(samples_per_seg):
            t = j / samples_per_seg
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t
                              + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(pts[-1])
    return out

def _sweep_strip(name, spine, width, thickness, width_axis, mat):
    """Rectangular-cross-section strip swept along a spine.

    ``spine`` is a list of Vector points, ``width_axis`` is the fixed
    direction the strip is wide in (e.g. (0,1,0) for a headphone band,
    whose width runs front-to-back). The thickness axis is the in-plane
    normal: cross(tangent, width_axis). This is what makes a headphone
    band a real arch and a watch strap a real curve instead of a box.
    """
    spine = [Vector(p) for p in spine]  # callers may pass plain tuples
    w_axis = Vector(width_axis).normalized()
    verts = []
    for i, p in enumerate(spine):
        t = (spine[min(i + 1, len(spine) - 1)] - spine[max(i - 1, 0)]).normalized()
        th_axis = t.cross(w_axis).normalized()
        hw, ht = width / 2, thickness / 2
        for sw, st in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            verts.append(p + w_axis * (sw * hw) + th_axis * (st * ht))
    faces = []
    n = len(spine)
    for i in range(n - 1):
        a, b = i * 4, (i + 1) * 4
        faces.append((a, a + 1, b + 1, b))
        faces.append((a + 1, a + 2, b + 2, b + 1))
        faces.append((a + 2, a + 3, b + 3, b + 2))
        faces.append((a + 3, a, b, b + 3))
    faces.append((0, 3, 2, 1))
    faces.append(((n - 1) * 4, (n - 1) * 4 + 1, (n - 1) * 4 + 2, (n - 1) * 4 + 3))
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    _smooth(obj)
    if mat is not None:
        obj.data.materials.append(mat)
    return obj

def _loft(name, stations, radial_segments, mat, power=1.0):
    """Loft elliptical cross-sections along X.

    ``stations``: list of (x, half_width, z_bottom, z_top). The sole and
    the upper are both lofts — the footprint taper and the toe spring
    come from the station table, not from guessed boxes. ``power`` > 1
    flattens the bottom of the section (a sole must sit flat, not
    balance on the keel line of a pure ellipse); 1.0 is a full ellipse.
    """
    verts, faces = [], []
    for (x, hw, zb, zt) in stations:
        for j in range(radial_segments):
            a = 2 * math.pi * j / radial_segments
            verts.append((x, hw * math.cos(a), zb + (zt - zb) * ((math.sin(a) + 1) / 2) ** power))
    n = len(stations)
    for i in range(n - 1):
        for j in range(radial_segments):
            a = i * radial_segments + j
            b = i * radial_segments + (j + 1) % radial_segments
            c = (i + 1) * radial_segments + (j + 1) % radial_segments
            d = (i + 1) * radial_segments + j
            faces.append((a, b, c, d))
    faces.append(tuple(reversed(range(radial_segments))))
    faces.append(tuple((n - 1) * radial_segments + j for j in range(radial_segments)))
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    _smooth(obj)
    if mat is not None:
        obj.data.materials.append(mat)
    return obj

def _box(name, size, centre, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=centre)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    if bevel:
        _bevel(obj, bevel)
    if mat is not None:
        obj.data.materials.append(mat)
    return obj

def _cyl(name, radius, depth, centre, rotation, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(location=centre, radius=radius, depth=depth, vertices=48)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation
    _smooth(obj)
    if bevel:
        _bevel(obj, bevel)
    if mat is not None:
        obj.data.materials.append(mat)
    return obj

def _arc_spine(centre, radius, a0_deg, a1_deg, steps=40):
    """Arc in the XZ plane (headphone band): angles from +X axis, degrees."""
    pts = []
    for i in range(steps + 1):
        a = math.radians(a0_deg + (a1_deg - a0_deg) * i / steps)
        pts.append((centre[0] + radius * math.cos(a), centre[1],
                    centre[2] + radius * math.sin(a)))
    return pts
'''


def _materials_block(names):
    """Emit material creation once per material name; leaves MAT_<name> vars."""
    lines = []
    for name in names:
        snippet = MaterialLibrary.get_material_script(name)
        # The snippet creates `mat`; capture it under a stable name.
        lines.append(snippet)
        lines.append(f"MAT_{name} = mat\n")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Headphones — arched band, padded cups (v1.3.0 flaw: straight bar, no
# cushions, oversized cups)
# ---------------------------------------------------------------------------

def _headphones_script():
    lines = [_PRELUDE, _materials_block(["black", "smooth_leather", "polished_steel"])]
    lines.append('''
# --- dimensions (real over-ears, metres) ---
# Band arc centre (0, 0, 0.125), radius 0.085: top of the arch z = 0.21.
# Cups hang at x = +/-0.088, centre z = 0.047 (radius 0.046 -> bottom z = 0.001).
_band_spine = _arc_spine((0, 0, 0.125), 0.085, 18, 162)
_band = _sweep_strip("Headband", _catmull_rom(_band_spine, 2), 0.026, 0.007, (0, 1, 0), MAT_black)
# Inner cushion: smaller radius, shorter arc, soft leather, touches the band.
_cush_spine = _arc_spine((0, 0, 0.125), 0.078, 32, 148)
_cush = _sweep_strip("HeadbandCushion", _catmull_rom(_cush_spine, 2), 0.020, 0.006, (0, 1, 0), MAT_smooth_leather)

for _side in (-1, 1):
    # Yoke: steel slider from the band end down to the cup top.
    _top = Vector((_side * 0.081, 0, 0.151))
    _bot = Vector((_side * 0.088, 0, 0.095))
    _mid = (_top + _bot) / 2
    _d = _bot - _top
    _yoke = _cyl("Yoke", 0.005, _d.length, _mid, (0, 0, 0), MAT_polished_steel)
    _yoke.rotation_euler = _d.to_track_quat('Z', 'Y').to_euler()
    # Cup: cylinder with its axis along X (flat faces point outward).
    _cup = _cyl("EarCup", 0.046, 0.030, (_side * 0.088, 0, 0.047), (0, math.radians(90), 0), MAT_black, bevel=0.003)
    # Outer cap disc + thin metal ring on the outer face.
    _cap = _cyl("CupCap", 0.047, 0.006, (_side * 0.104, 0, 0.047), (0, math.radians(90), 0), MAT_black, bevel=0.002)
    bpy.ops.mesh.primitive_torus_add(location=(_side * 0.107, 0, 0.047), major_radius=0.040, minor_radius=0.002, major_segments=48, minor_segments=8)
    _ring = bpy.context.active_object
    _ring.name = "CupRing"
    _ring.rotation_euler = (0, math.radians(90), 0)
    _smooth(_ring)
    _ring.data.materials.append(MAT_polished_steel)
    # Cushion ring on the inner face: torus flattened along X so it reads
    # as a padded ring, not a doughnut.
    bpy.ops.mesh.primitive_torus_add(location=(_side * 0.071, 0, 0.047), major_radius=0.036, minor_radius=0.011, major_segments=48, minor_segments=12)
    _pad = bpy.context.active_object
    _pad.name = "EarCushion"
    _pad.rotation_euler = (0, math.radians(90), 0)
    _pad.scale = (1.0, 1.0, 0.7)
    _smooth(_pad)
    _pad.data.materials.append(MAT_smooth_leather)
    # Recessed driver disc inside the cushion ring.
    _drv = _cyl("Driver", 0.032, 0.004, (_side * 0.072, 0, 0.047), (0, math.radians(90), 0), MAT_black)
''')
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Sneaker — lofted sole + upper, bezier laces (v1.3.0 flaw: white board on
# a box, floating lace rods, detached grey heel box)
# ---------------------------------------------------------------------------

def _sneaker_script():
    lines = [_PRELUDE, _materials_block(["white_leather", "rubber", "accent_red", "polished_steel", "smooth_leather", "black"])]
    lines.append('''
# --- sole loft: footprint taper + toe spring, stations heel -> toe ---
# (x, half_width, z_bottom, z_top). Toe spring: the sole tip rises.
_sole_stations = [
    (-0.140, 0.030, 0.000, 0.016), (-0.120, 0.033, 0.000, 0.017),
    (-0.090, 0.031, 0.000, 0.017), (-0.050, 0.030, 0.000, 0.017),
    (-0.010, 0.034, 0.000, 0.018), (0.030, 0.042, 0.000, 0.018),
    (0.070, 0.045, 0.001, 0.018), (0.100, 0.043, 0.003, 0.017),
    (0.125, 0.036, 0.008, 0.016), (0.140, 0.020, 0.014, 0.018),
    (0.146, 0.008, 0.018, 0.020),
]
_sole = _loft("Midsole", _sole_stations, 16, MAT_white_leather, power=1.6)
# Dark rubber outsole: same footprint, thin, follows the toe spring.
_out_stations = [(x, hw, max(0.0, zb - 0.006), zb + 0.001) for (x, hw, zb, zt) in _sole_stations]
_out = _loft("Outsole", _out_stations, 16, MAT_rubber, power=1.6)

# --- upper loft: same footprint x 0.94, rising from toe to ankle ---
_up_stations = [
    (-0.138, 0.028, 0.016, 0.070), (-0.120, 0.031, 0.017, 0.082),
    (-0.090, 0.029, 0.017, 0.088), (-0.050, 0.028, 0.017, 0.080),
    (-0.010, 0.032, 0.018, 0.062), (0.030, 0.040, 0.018, 0.048),
    (0.070, 0.043, 0.018, 0.038), (0.100, 0.041, 0.017, 0.030),
    (0.125, 0.034, 0.016, 0.024), (0.140, 0.018, 0.018, 0.020),
]
_up = _loft("Upper", _up_stations, 16, MAT_white_leather)
# Ankle opening: a REAL hole, not a black sticker. Boolean-cut the
# opening through the upper dome, then a dark disc 16 mm below the rim
# (the inside of the shoe). The first version was a flat black disc on
# the dome — it read as a black patch, because a flat plate cannot sit
# on a curved dome without floating at the edges.
bpy.ops.mesh.primitive_cylinder_add(location=(-0.105, 0, 0.080), radius=0.024, depth=0.06, vertices=32)
_cutter = bpy.context.active_object
_cutter.name = "AnkleCutter"
_cutter.scale = (1.3, 1.0, 1.0)
_up.select_set(True)
bpy.context.view_layer.objects.active = _up
_mod = _up.modifiers.new(name="AnkleCut", type='BOOLEAN')
_mod.operation = 'DIFFERENCE'
_mod.object = _cutter
bpy.ops.object.modifier_apply(modifier="AnkleCut")
bpy.data.objects.remove(_cutter, do_unlink=True)
bpy.ops.mesh.primitive_cylinder_add(location=(-0.105, 0, 0.070), radius=0.024, depth=0.002, vertices=32)
_open = bpy.context.active_object
_open.name = "AnkleOpening"
_open.scale = (1.3, 1.0, 1.0)
_smooth(_open)
_open.data.materials.append(MAT_black)
# Tongue: padded, following the upper's slope (17 deg) so it stays
# ~4 mm above the upper from ankle to toe, long enough to emerge from
# the ankle opening. The first version was tilted the wrong way (-28
# deg) and half-buried; the second was 40 mm wide and read as a grey
# plank bolted on top — now 30 mm wide, so it reads as a tongue strap.
_tongue = _box("Tongue", (0.13, 0.030, 0.010), (-0.030, 0, 0.063), MAT_smooth_leather, bevel=0.004)
_tongue.rotation_euler = (0, math.radians(17), 0)
# Toe cap: smaller flattened ellipsoid on the toe only (the first
# version wrapped the whole toe and read as a grey blob).
bpy.ops.mesh.primitive_uv_sphere_add(location=(0.115, 0, 0.022), radius=0.5, segments=32, ring_count=16)
_cap = bpy.context.active_object
_cap.name = "ToeCap"
_cap.scale = (0.05, 0.06, 0.02)
_smooth(_cap)
_cap.data.materials.append(MAT_smooth_leather)
# Heel counter: curved strip wrapping the heel (sweep, width = vertical),
# radius hugging the upper (0.029) so it reads as attached, not stuck on.
_heel_spine = []
for _i in range(17):
    _a = math.radians(200 + 140 * _i / 16)
    _heel_spine.append((-0.122 + 0.029 * math.cos(_a), 0.029 * math.sin(_a), 0.045))
_counter = _sweep_strip("HeelCounter", _heel_spine, 0.050, 0.004, (0, 0, 1), MAT_smooth_leather)
# Side accent panels: flattened ellipsoids embedded in the upper, both
# sides, placed over the ball of the foot where the upper is widest and
# flattest (first version floated 11 mm proud and read as stickers;
# the second sat across a width change, so its edge dipped in and out
# of the surface and read as a damaged sticker).
for _side in (-1, 1):
    bpy.ops.mesh.primitive_uv_sphere_add(location=(0.06, _side * 0.044, 0.030), radius=0.5, segments=32, ring_count=16)
    _panel = bpy.context.active_object
    _panel.name = "SidePanel"
    _panel.scale = (0.06, 0.012, 0.016)
    _smooth(_panel)
    _panel.data.materials.append(MAT_accent_red)
# Laces: ONE bezier tube zig-zagging across the tongue, sitting ON it —
# never floating rods. The first version's path ran ~9 mm BELOW the
# upper surface, so the laces were buried and invisible; the eyelets
# were also rotated vertical (edge-on). Now the path rides the tongue
# top (slope -0.31) + 4.5 mm, tube radius 0.0045, eyelets FLAT.
def _tongue_top_z(x):
    return 0.068 - 0.31 * (x + 0.030)
_lace_pts = []
for _i in range(5):
    _x = -0.035 + _i * 0.014
    _z = _tongue_top_z(_x) + 0.0045
    _lace_pts.append(Vector((_x, -0.016, _z)))
    _lace_pts.append(Vector((_x + 0.008, 0.016, _tongue_top_z(_x + 0.008) + 0.0045)))
_lace_curve = bpy.data.curves.new("LacesCurve", 'CURVE')
_lace_curve.dimensions = '3D'
_lace_curve.bevel_depth = 0.0045
_lace_curve.bevel_resolution = 3
_spline = _lace_curve.splines.new('POLY')
_spline.points.add(len(_lace_pts) - 1)
for _i, _p in enumerate(_lace_pts):
    _spline.points[_i].co = (_p.x, _p.y, _p.z, 1)
_lace_obj = bpy.data.objects.new("Laces", _lace_curve)
bpy.context.collection.objects.link(_lace_obj)
# Convert the tube to a real mesh: the bounds report (and the render
# framing) only see MESH objects, so a curve "Laces" was invisible to
# both — the v1.3.0 rods were meshes, the bezier tube is not until
# converted. Deselect-all first so the convert touches only the lace.
# Material goes on AFTER the convert, on the mesh.
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = _lace_obj
_lace_obj.select_set(True)
bpy.ops.object.convert(target='MESH')
_lace_obj.data.materials.append(MAT_white_leather)
for _i in range(5):
    _x = -0.035 + _i * 0.014
    for _side in (-1, 1):
        bpy.ops.mesh.primitive_torus_add(location=(_x, _side * 0.017, _tongue_top_z(_x) + 0.0035), major_radius=0.004, minor_radius=0.0012, major_segments=16, minor_segments=8)
        _eye = bpy.context.active_object
        _eye.name = "Eyelet"
        _smooth(_eye)
        _eye.data.materials.append(MAT_polished_steel)
''')
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Perfume — bevelled glass, seated cap (v1.3.0 flaw: sharp 90-degree box,
# plain cylinder cap, floating cap gap, rough neck)
# ---------------------------------------------------------------------------

def _perfume_script():
    lines = [_PRELUDE, _materials_block(["glass", "amber_liquid", "gold", "white", "black"])]
    lines.append('''
# --- bottle: bevelled box, NO sharp 90-degree edges ---
_body = _box("BottleBody", (0.075, 0.040, 0.105), (0, 0, 0.0525), MAT_glass, bevel=0.008)
# Amber liquid inside, slightly smaller, also bevelled.
_liq = _box("Liquid", (0.068, 0.033, 0.088), (0, 0, 0.048), MAT_amber_liquid, bevel=0.006)
# Neck: smooth glass cylinder + gold ring.
_neck = _cyl("Neck", 0.011, 0.012, (0, 0, 0.111), (0, 0, 0), MAT_glass)
bpy.ops.mesh.primitive_torus_add(location=(0, 0, 0.112), major_radius=0.0115, minor_radius=0.0025, major_segments=32, minor_segments=12)
_ring = bpy.context.active_object
_ring.name = "NeckRing"
_smooth(_ring)
_ring.data.materials.append(MAT_gold)
# Cap: bevelled gold cylinder + domed top. Bottom z = 0.110 OVERLAPS the
# neck ring (top 0.1145) by 4.5 mm — seated, no floating gap.
_cap = _cyl("Cap", 0.0145, 0.030, (0, 0, 0.125), (0, 0, 0), MAT_gold, bevel=0.003)
bpy.ops.mesh.primitive_uv_sphere_add(location=(0, 0, 0.140), radius=0.5, segments=32, ring_count=16)
_dome = bpy.context.active_object
_dome.name = "CapDome"
_dome.scale = (0.029, 0.029, 0.010)
_smooth(_dome)
_dome.data.materials.append(MAT_gold)
# Label: thin white plate on the front face + NOIR text on it.
_label = _box("Label", (0.040, 0.0015, 0.022), (0, -0.0205, 0.055), MAT_white, bevel=0.0005)
bpy.ops.object.text_add(location=(0, -0.0218, 0.055))
_txt = bpy.context.active_object
_txt.name = "LabelText"
_txt.data.body = "NOIR"
_txt.data.align_x = 'CENTER'
_txt.data.align_y = 'CENTER'
_txt.data.size = 0.011
_txt.rotation_euler = (math.radians(90), 0, 0)
# Convert the font to a real mesh: the bounds report only sees MESH
# objects, so a FONT "LabelText" was invisible to it (same fix as the
# sneaker laces). Material goes on AFTER the convert, on the mesh.
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = _txt
_txt.select_set(True)
bpy.ops.object.convert(target='MESH')
_txt.data.materials.append(MAT_black)
''')
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Smartwatch — procedural fallback (primary path is the retrieved Poly
# Haven model). v1.3.0 flaw: blank slab face, flat strap slabs, noisy
# strap texture, tiny in frame (framing is fixed in render.py).
# ---------------------------------------------------------------------------

def _smartwatch_script():
    lines = [_PRELUDE, _materials_block(["steel", "smooth_leather", "black", "white", "gold", "glass", "polished_steel"])]
    lines.append('''
# --- case: bevelled, face up, strap along X ---
_case = _box("WatchCase", (0.046, 0.038, 0.012), (0, 0, 0.009), MAT_steel, bevel=0.004)
# Dial: black rounded plate on the top face.
_dial = _box("Dial", (0.040, 0.032, 0.002), (0, 0, 0.016), MAT_black, bevel=0.001)
# 12 hour markers around the dial.
for _i in range(12):
    _a = math.radians(_i * 30)
    _mx, _my = 0.016 * math.sin(_a), 0.0125 * math.cos(_a)
    _m = _box("Marker", (0.0012, 0.004 if _i % 3 else 0.006, 0.001), (_mx, _my, 0.0175), MAT_white)
    _m.rotation_euler = (0, 0, -_a)
# Hands at 10:10 (classic watch-ad position), white, on the dial.
_hour = _box("HourHand", (0.0022, 0.011, 0.0008), (0, 0, 0.0178), MAT_white)
_hour.rotation_euler = (0, 0, math.radians(60))
_hour.location = (0.016 * math.sin(math.radians(300)) * 0.35, 0.0125 * math.cos(math.radians(300)) * 0.35, 0.0178)
_min = _box("MinuteHand", (0.0016, 0.015, 0.0008), (0, 0, 0.0178), MAT_white)
_min.rotation_euler = (0, 0, math.radians(-60))
_min.location = (0.016 * math.sin(math.radians(60)) * 0.45, 0.0125 * math.cos(math.radians(60)) * 0.45, 0.0178)
_pin = _cyl("CentrePin", 0.002, 0.002, (0, 0, 0.018), (0, 0, 0), MAT_gold)
# Dial glass: thin bevelled plate over the dial.
_glass = _box("DialGlass", (0.042, 0.034, 0.0015), (0, 0, 0.0188), MAT_glass, bevel=0.0008)
# Crown + side button on the +X side of the case.
_crown = _cyl("Crown", 0.0035, 0.005, (0.025, 0, 0.009), (0, math.radians(90), 0), MAT_polished_steel)
_btn = _box("SideButton", (0.004, 0.008, 0.003), (0.024, 0, 0.004), MAT_polished_steel, bevel=0.001)
# Strap: curved bezier strips (Catmull-Rom) from the lugs, dipping to the
# ground and curling up at the tips. Smooth leather — NO noise texture.
for _side in (1, -1):
    _ctrl = [
        (_side * 0.023, 0, 0.006), (_side * 0.055, 0, 0.002),
        (_side * 0.085, 0, 0.0015), (_side * 0.108, 0, 0.006),
        (_side * 0.118, 0, 0.014),
    ]
    _spine = _catmull_rom(_ctrl, 8)
    _strap = _sweep_strip("Strap", _spine, 0.022, 0.003, (0, 1, 0), MAT_smooth_leather)
# Buckle frame at the +X strap tip.
_buckle = _box("Buckle", (0.008, 0.026, 0.004), (0.116, 0, 0.014), MAT_polished_steel, bevel=0.001)
''')
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Retrieved asset: import a downloaded glTF, normalise, centre, ground
# ---------------------------------------------------------------------------

def get_retrieved_product_script(gltf_path, target_size=0.22):
    """Blender script: import a retrieved glTF asset as the product.

    Normalises it (longest side = ``target_size`` metres, strap along X,
    centred on the origin, min z = 0) and verifies the import in Blender
    instead of assuming the file's up-axis. Used for the smartwatch
    (Poly Haven ``digital_wrist_watch``, CC0).
    """
    return f'''
import bpy, math, json
from mathutils import Vector, Matrix

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

bpy.ops.import_scene.gltf(filepath={json.dumps(str(gltf_path))})
bpy.context.view_layer.update()
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
if not meshes:
    raise RuntimeError("retrieve_asset import: no mesh objects in the glTF file")

def _bounds(objs):
    bpy.context.view_layer.update()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    return lo, hi

_lo, _hi = _bounds(meshes)
_size = _hi - _lo
_longest = max(_size.x, _size.y, _size.z)
_scale = {target_size} / _longest if _longest > 0 else 1.0
# Rotate the whole model 90 deg about the WORLD Z axis so the long axis
# (strap) runs along X, face stays up (+Z). Done as a matrix multiply on
# each mesh's matrix_world (not by adding to rotation_euler: the glTF
# importer already leaves an X rotation on the meshes, and Euler
# composition would rotate about the wrong axis). And NOT by parenting
# under an empty: the meshes' locations would then live in the parent's
# rotated frame, so a world-space centring shift lands in the wrong axes
# (the first version of this code centred the watch ~2 cm off in Y).
# Locations stay in world space throughout, so the shift below is exact.
for _o in meshes:
    _o.scale = (_o.scale.x * _scale, _o.scale.y * _scale, _o.scale.z * _scale)
bpy.context.view_layer.update()
_rot = Matrix.Rotation(math.radians(90), 4, 'Z')
for _o in meshes:
    _o.matrix_world = _rot @ _o.matrix_world
bpy.context.view_layer.update()
_lo, _hi = _bounds(meshes)
_c = (_lo + _hi) / 2
for _o in meshes:
    _o.location.x -= _c.x
    _o.location.y -= _c.y
    _o.location.z -= _lo.z
bpy.context.view_layer.update()
_lo, _hi = _bounds(meshes)
print("RETRIEVED_PRODUCT_JSON:" + json.dumps({{"meshes": len(meshes), "size": [round(v, 4) for v in (_hi - _lo)], "min_z": round(_lo.z, 5)}}))
'''


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def get_product_script(product, options=None):
    """Return the bpy build script for a product, or (None, error)."""
    product = (product or "").lower().strip()
    builders = {
        "headphones": _headphones_script,
        "sneaker": _sneaker_script,
        "perfume": _perfume_script,
        "smartwatch": _smartwatch_script,
    }
    builder = builders.get(product)
    if builder is None:
        return None, (
            f"Unknown product {product!r}. Known products: "
            f"{', '.join(sorted(builders))}. For a retrieved real asset use "
            "retrieve_asset first, then get_retrieved_product_script."
        )
    return builder(), None
