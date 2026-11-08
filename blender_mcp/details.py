"""Detail helpers library (Blender-MCP 1.3.0) — small manufactured details
the calling model can apply to a target object: bevels, subdivision
surfaces, panel lines, screws/bolts, seams, grilles/vents, labels.

Python mirror of src/commands/details.ts. Every helper is a real ``bpy``
snippet that runs in Blender 4.2.0 (smoke-tested, see tests).
``get_detail_script(detail, target, params)`` returns a Blender snippet
that operates on the object named ``target`` (substring match). Params are
validated; unknown detail names and out-of-range params fail with a clear
error instead of building silently wrong geometry.
"""

import json

DETAIL_TYPES = [
    {
        "kind": "bevel",
        "description": "Rounded edge (Bevel modifier) on the target — softens hard CG edges so highlights read as manufactured. Params: width_m (default 0.002), segments (default 3).",
        "params": "width_m, segments",
        "example": '{"detail": "bevel", "target": "WatchCase", "params": {"width_m": 0.0015, "segments": 3}}',
    },
    {
        "kind": "subdivision",
        "description": "Subdivision Surface modifier — smooths faceted curves (bottle shoulders, earcup shells, shoe uppers). Params: levels (default 2). Apply AFTER bevel for a clean edge.",
        "params": "levels",
        "example": '{"detail": "subdivision", "target": "BottleBody", "params": {"levels": 2}}',
    },
    {
        "kind": "panel_line",
        "description": 'Thin dark recessed strip on one face of the target — the seam between two manufactured panels. Params: face ("top"|"front"|"back"|"left"|"right", default "front"), offset_m (default 0.001), length_m, width_m (default 0.002), depth_m (default 0.001).',
        "params": "face, offset_m, length_m, width_m, depth_m",
        "example": '{"detail": "panel_line", "target": "Earcup_L", "params": {"face": "front", "length_m": 0.06}}',
    },
    {
        "kind": "screw",
        "description": 'Small screw head (cylinder + dark slot) on one face of the target. Params: face (default "back"), x_m, y_m (default 0, 0 = face centre), radius_m (default 0.003), head_depth_m (default 0.001).',
        "params": "face, x_m, y_m, radius_m, head_depth_m",
        "example": '{"detail": "screw", "target": "WatchCaseBack", "params": {"face": "back", "x_m": 0.01, "y_m": 0.008}}',
    },
    {
        "kind": "bolt",
        "description": 'Hex bolt (6-sided head + shaft) on one face of the target. Params: face (default "top"), x_m, y_m, radius_m (default 0.004), head_depth_m (default 0.002).',
        "params": "face, x_m, y_m, radius_m, head_depth_m",
        "example": '{"detail": "bolt", "target": "SolePlate", "params": {"face": "top", "x_m": 0.02}}',
    },
    {
        "kind": "seam",
        "description": 'Thin dark ring around the target (torus hugging its bounding box) — the stitch/seam line where two parts meet. Params: axis ("x"|"y"|"z", default "z"), radius_scale (default 1.0), tube_m (default 0.001).',
        "params": "axis, radius_scale, tube_m",
        "example": '{"detail": "seam", "target": "EarCushion_L", "params": {"axis": "z"}}',
    },
    {
        "kind": "grille",
        "description": "Speaker/vent grille: a dark recessed panel with a grid of small slats on one face of the target. Params: face (default \"front\"), rows (default 5), cols (default 8), size_m (default 0.04).",
        "params": "face, rows, cols, size_m",
        "example": '{"detail": "grille", "target": "Earcup_L", "params": {"face": "front", "rows": 6, "cols": 10}}',
    },
    {
        "kind": "label",
        "description": 'Thin label plate on one face of the target, with optional raised text (a real Text object). Params: face (default "front"), width_m (default 0.03), height_m (default 0.012), text (optional string), text_size_m (default 0.006).',
        "params": "face, width_m, height_m, text, text_size_m",
        "example": '{"detail": "label", "target": "BottleBody", "params": {"face": "front", "text": "NOIR"}}',
    },
    {
        "kind": "condensation",
        "description": 'Condensation droplets on a cold can/bottle (v1.4.0): bimodal flattened water droplets (Transmission 1.0, IOR 1.33) merged into one mesh on the target surface, plus a wet-film roughness drop (0.1-0.25) on the target material. Counts derive from the target lateral area (a 330 ml can gets ~1200 small + ~80 large); explicit drops_small/drops_large override. Params: density ("hero"|"wide", default "hero" — wide halves the small drops and drops the sub-mm class), drops_small, drops_large, runnels (vertical drip streaks on the lower third, default 8).',
        "params": "density, drops_small, drops_large, runnels",
        "example": '{"detail": "condensation", "target": "CanBody", "params": {"density": "hero"}}',
    },
    {
        "kind": "emissive_ring",
        "description": 'Glowing ring (torus hugging the target bounding box) — the energy-drink glow ring, a neon halo, a light-bar ring. Principled Emission (strength 2-5 for a can ring, 5-10 for hero strips; never > 10 on a large area in Cycles). Needs a Compositor Glare node to bloom — emission alone does not bloom in Cycles (see the cinematic render preset). Params: axis ("x"|"y"|"z", default "z"), radius_scale (default 1.0), tube_m (default 0.002), color ("#RRGGBB" or [r, g, b], default teal #00D8FF), strength (default 3.0).',
        "params": "axis, radius_scale, tube_m, color, strength",
        "example": '{"detail": "emissive_ring", "target": "CanBody", "params": {"color": "#00D8FF", "strength": 3}}',
    },
    {
        "kind": "glow_strip",
        "description": 'Thin vertical emissive strip on one face of the target — a glow logo bar, a light strip, a neon edge. Principled Emission (strength 2-5 for a label accent, 5-10 for a hero strip; never > 10). Needs a Compositor Glare node to bloom in Cycles. Params: face (default "front"), width_m (default 0.005), length_m (default 0.8x the face height), color ("#RRGGBB" or [r, g, b], default teal #00D8FF), strength (default 5.0).',
        "params": "face, width_m, length_m, color, strength",
        "example": '{"detail": "glow_strip", "target": "CanBody", "params": {"face": "front", "color": "#00D8FF", "strength": 5}}',
    },
]

DETAIL_KINDS = [d["kind"] for d in DETAIL_TYPES]


def _num(v, fallback):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return fallback
    return n if n == n and abs(n) != float("inf") else fallback


def _parse_color(v, default):
    """Accept '#RRGGBB' or [r, g, b] (0-1 floats); return an (r, g, b) tuple.

    The values are used as-is (linear RGB, as in the research: teal
    (0.3, 0.8, 1.0), amber (1.0, 0.55, 0.25)). A hex string is decoded to
    0-1 and used the same way — a documented approximation, not a colour
    -space conversion.
    """
    if v is None:
        return default
    if isinstance(v, str):
        s = v.strip().lstrip("#")
        if len(s) == 6:
            try:
                return (int(s[0:2], 16) / 255, int(s[2:4], 16) / 255, int(s[4:6], 16) / 255)
            except ValueError:
                pass
        raise ValueError(f"color must be '#RRGGBB' or [r, g, b], got '{v}'.")
    if isinstance(v, (list, tuple)) and len(v) == 3:
        try:
            c = (float(v[0]), float(v[1]), float(v[2]))
        except (TypeError, ValueError):
            raise ValueError(f"color must be [r, g, b] numbers in 0-1, got {v!r}.")
        if all(0.0 <= x <= 1.0 for x in c):
            return c
    raise ValueError(f"color must be '#RRGGBB' or [r, g, b] in 0-1, got {v!r}.")


def _rgba_str(c):
    """'(r, g, b, 1)' with Python float repr — matches the TS mirror byte-wise."""
    return f"({c[0]!r}, {c[1]!r}, {c[2]!r}, 1)"


def _face_info(face):
    """Face of a bounding box: (axis, sign)."""
    f = (face or "front").lower()
    mapping = {
        "top": (2, 1), "bottom": (2, -1),
        "front": (1, -1), "back": (1, 1),
        "left": (0, -1), "right": (0, 1),
    }
    if f not in mapping:
        raise ValueError(f"Unknown face '{face}'. Allowed: top, bottom, front, back, left, right.")
    return mapping[f]


def _prelude(target):
    return f"""
import bpy
from mathutils import Vector
_target_name = {json.dumps(target)}
_targets = [o for o in bpy.data.objects if o.type == 'MESH' and _target_name in o.name]
if not _targets:
    raise RuntimeError(f"add_detail: no mesh object matching '{{_target_name}}'")
_target = _targets[0]
bpy.context.view_layer.update()
_corners = [_target.matrix_world @ Vector(c) for c in _target.bound_box]
_lo = Vector((min(c.x for c in _corners), min(c.y for c in _corners), min(c.z for c in _corners)))
_hi = Vector((max(c.x for c in _corners), max(c.y for c in _corners), max(c.z for c in _corners)))
_centre = (_lo + _hi) / 2
_size = _hi - _lo
# Small dark "manufactured detail" material, shared by panel lines / screws / seams / grilles.
_detail_mat = bpy.data.materials.get("DetailDark") or bpy.data.materials.new(name="DetailDark")
_detail_mat.use_nodes = True
_detail_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.03, 0.03, 0.03, 1)
_detail_mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6
"""


def _face_point(face, u, v, offset):
    """Blender expression for a point on a bbox face. u/v are offsets along
    the two non-normal axes — literal numbers or Blender expressions."""
    axis, sign = _face_info(face)
    coords = []
    others = [a for a in (0, 1, 2) if a != axis]
    for a in (0, 1, 2):
        if a == axis:
            coords.append(f"_centre[{a}] + {sign} * (_size[{a}] / 2 + {offset})")
        elif a == others[0]:
            coords.append(f"_centre[{a}] + ({u})")
        else:
            coords.append(f"_centre[{a}] + ({v})")
    return f"({coords[0]}, {coords[1]}, {coords[2]})"


def _face_rotation(face):
    axis, _sign = _face_info(face)
    if axis == 2:
        return "(0, 0, 0)"
    if axis == 1:
        return "(1.57079632679, 0, 0)"
    return "(0, 1.57079632679, 0)"


def get_detail_script(detail, target, params=None):
    if not target or not str(target).strip():
        raise ValueError("add_detail needs a target object name.")
    params = params or {}
    kind = (detail or "").lower()
    if kind not in DETAIL_KINDS:
        raise ValueError(f"Unknown detail '{detail}'. Available: {', '.join(DETAIL_KINDS)}.")

    if kind == "bevel":
        width = _num(params.get("width_m"), 0.002)
        segments = max(1, min(6, round(_num(params.get("segments"), 3))))
        if width <= 0 or width > 0.05:
            raise ValueError("bevel width_m must be > 0 and <= 0.05 m.")
        return _prelude(target) + f"""
_mod = _target.modifiers.new(name="DetailBevel", type='BEVEL')
_mod.width = {width}
_mod.segments = {segments}
_mod.limit_method = 'ANGLE'
print(f"DETAIL_OK bevel width={width} segments={segments} on {{_target.name}}")
"""

    if kind == "subdivision":
        levels = max(1, min(4, round(_num(params.get("levels"), 2))))
        return _prelude(target) + f"""
_mod = _target.modifiers.new(name="DetailSubdiv", type='SUBSURF')
_mod.subdivision_type = 'CATMULL_CLARK'
_mod.levels = {levels}
_mod.render_levels = {levels}
print(f"DETAIL_OK subdivision levels={levels} on {{_target.name}}")
"""

    if kind == "panel_line":
        face = str(params.get("face", "front"))
        offset = _num(params.get("offset_m"), 0.001)
        width = _num(params.get("width_m"), 0.002)
        depth = _num(params.get("depth_m"), 0.001)
        length = _num(params.get("length_m"), 0)
        axis, _sign = _face_info(face)
        other_axes = [a for a in (0, 1, 2) if a != axis]
        if length > 0:
            strip_len = str(length)
        else:
            strip_len = f"min(_size[{other_axes[0]}] * 0.8, _size[{other_axes[0]}]) if _size[{other_axes[0]}] > 0 else 0.05"
        return _prelude(target) + f"""
_face_axis = {axis}
_len = {strip_len}
_other = [{other_axes[0]}, {other_axes[1]}]
# Strip dims: long along the first non-normal axis, thin along the normal.
_dims = [0.001, 0.001, 0.001]
_dims[_other[0]] = _len
_dims[_other[1]] = {width}
_dims[_face_axis] = {depth}
_loc = {_face_point(face, 0, 0, offset)}
bpy.ops.mesh.primitive_cube_add(location=_loc)
_strip = bpy.context.active_object
_strip.name = _target.name + "_PanelLine"
_strip.dimensions = _dims
_strip.data.materials.append(_detail_mat)
print(f"DETAIL_OK panel_line face={face} on {{_target.name}}")
"""

    if kind == "screw":
        face = str(params.get("face", "back"))
        x = _num(params.get("x_m"), 0)
        y = _num(params.get("y_m"), 0)
        radius = _num(params.get("radius_m"), 0.003)
        depth = _num(params.get("head_depth_m"), 0.001)
        if radius <= 0 or radius > 0.05:
            raise ValueError("screw radius_m must be > 0 and <= 0.05 m.")
        return _prelude(target) + f"""
_loc = {_face_point(face, x, y, depth / 2)}
bpy.ops.mesh.primitive_cylinder_add(location=_loc, radius={radius}, depth={depth}, vertices=24)
_screw = bpy.context.active_object
_screw.name = _target.name + "_Screw"
_screw.rotation_euler = {_face_rotation(face)}
_screw.data.materials.append(_detail_mat)
# Slot: thin dark box across the head.
_slot_loc = {_face_point(face, x, y, depth + 0.0002)}
bpy.ops.mesh.primitive_cube_add(location=_slot_loc)
_slot = bpy.context.active_object
_slot.name = _target.name + "_ScrewSlot"
_slot.dimensions = ({radius * 1.6}, {radius * 0.3}, {depth * 0.6})
_slot.rotation_euler = {_face_rotation(face)}
_slot.data.materials.append(_detail_mat)
print(f"DETAIL_OK screw face={face} on {{_target.name}}")
"""

    if kind == "bolt":
        face = str(params.get("face", "top"))
        x = _num(params.get("x_m"), 0)
        y = _num(params.get("y_m"), 0)
        radius = _num(params.get("radius_m"), 0.004)
        depth = _num(params.get("head_depth_m"), 0.002)
        if radius <= 0 or radius > 0.05:
            raise ValueError("bolt radius_m must be > 0 and <= 0.05 m.")
        return _prelude(target) + f"""
_loc = {_face_point(face, x, y, depth / 2)}
bpy.ops.mesh.primitive_cylinder_add(location=_loc, radius={radius}, depth={depth}, vertices=6)
_bolt = bpy.context.active_object
_bolt.name = _target.name + "_Bolt"
_bolt.rotation_euler = {_face_rotation(face)}
_bolt.data.materials.append(_detail_mat)
# Shaft below the head, into the target.
_shaft_loc = {_face_point(face, x, y, -depth)}
bpy.ops.mesh.primitive_cylinder_add(location=_shaft_loc, radius={radius * 0.55}, depth={depth * 2}, vertices=12)
_shaft = bpy.context.active_object
_shaft.name = _target.name + "_BoltShaft"
_shaft.rotation_euler = {_face_rotation(face)}
_shaft.data.materials.append(_detail_mat)
print(f"DETAIL_OK bolt face={face} on {{_target.name}}")
"""

    if kind == "seam":
        axis_name = str(params.get("axis", "z")).lower()
        if axis_name not in ("x", "y", "z"):
            raise ValueError(f"seam axis must be x, y or z, got '{axis_name}'.")
        axis = {"x": 0, "y": 1, "z": 2}[axis_name]
        scale = _num(params.get("radius_scale"), 1.0)
        tube = _num(params.get("tube_m"), 0.001)
        if tube <= 0 or tube > 0.02:
            raise ValueError("seam tube_m must be > 0 and <= 0.02 m.")
        rot = "(0, 0, 0)" if axis == 2 else ("(1.57079632679, 0, 0)" if axis == 1 else "(0, 1.57079632679, 0)")
        # Unit ring scaled into an ellipse hugging the object's actual
        # cross-section. A circular ring sized by max() floats far off
        # any flat or long object (the v1.3.0 demo's headband got a giant
        # floating ring). Scale is in the torus's local axes (local x/y
        # are the ring plane): per axis the tuple is (half-dim along
        # local x, half-dim along local y, 1).
        scale_tuple = (
            "_size[0] / 2, _size[1] / 2, 1" if axis == 2
            else "_size[0] / 2, _size[2] / 2, 1" if axis == 1
            else "_size[2] / 2, _size[1] / 2, 1"
        )
        return _prelude(target) + f"""
bpy.ops.mesh.primitive_torus_add(location=_centre, major_radius=1.0, minor_radius={tube})
_seam = bpy.context.active_object
_seam.name = _target.name + "_Seam"
_seam.rotation_euler = {rot}
_sx, _sy, _sz = {scale_tuple}
_seam.scale = (_sx * {scale}, _sy * {scale}, _sz * {scale})
_seam.data.materials.append(_detail_mat)
print(f"DETAIL_OK seam axis={axis_name} on {{_target.name}}")
"""

    if kind == "grille":
        face = str(params.get("face", "front"))
        rows = max(1, min(20, round(_num(params.get("rows"), 5))))
        cols = max(1, min(20, round(_num(params.get("cols"), 8))))
        size = _num(params.get("size_m"), 0.04)
        if size <= 0 or size > 0.5:
            raise ValueError("grille size_m must be > 0 and <= 0.5 m.")
        return _prelude(target) + f"""
_panel_loc = {_face_point(face, 0, 0, 0.0005)}
bpy.ops.mesh.primitive_cube_add(location=_panel_loc)
_panel = bpy.context.active_object
_panel.name = _target.name + "_GrillePanel"
_panel.dimensions = ({size}, {size}, 0.001)
_panel.rotation_euler = {_face_rotation(face)}
_panel.data.materials.append(_detail_mat)
# Slats: thin raised bars across the panel, spaced along the panel.
for _i in range({rows}):
    _t = (_i / max(1, {rows} - 1) - 0.5) * {size} * 0.8 if {rows} > 1 else 0.0
    # Slats span the panel's U axis and are spaced along its V axis.
    _slat_loc = {_face_point(face, 0, "_t", 0.001)}
    bpy.ops.mesh.primitive_cube_add(location=_slat_loc)
    _slat = bpy.context.active_object
    _slat.name = _target.name + "_GrilleSlat"
    _slat.dimensions = ({size} * 0.8, 0.0015, 0.0008)
    _slat.rotation_euler = {_face_rotation(face)}
print(f"DETAIL_OK grille rows={rows} on {{_target.name}}")
"""

    if kind == "label":
        face = str(params.get("face", "front"))
        width = _num(params.get("width_m"), 0.03)
        height = _num(params.get("height_m"), 0.012)
        text = params.get("text", "") if isinstance(params.get("text", ""), str) else ""
        text_size = _num(params.get("text_size_m"), 0.006)
        if width <= 0 or height <= 0:
            raise ValueError("label width_m and height_m must be > 0.")
        text_block = ""
        if text:
            text_block = f"""
# Raised text on the label plate.
_curve = bpy.data.curves.new(name=_target.name + "_LabelText", type='FONT')
_curve.body = {json.dumps(text)}
_curve.size = {text_size}
_curve.align_x = 'CENTER'
_curve.align_y = 'CENTER'
_text_obj = bpy.data.objects.new(name=_target.name + "_LabelText", object_data=_curve)
bpy.context.scene.collection.objects.link(_text_obj)
_text_obj.location = {_face_point(face, 0, 0, 0.002)}
_text_obj.rotation_euler = {_face_rotation(face)}
_text_mat = bpy.data.materials.get("DetailDark") or _detail_mat
_text_obj.data.materials.append(_text_mat)
"""
        return _prelude(target) + f"""
_plate_loc = {_face_point(face, 0, 0, 0.0008)}
bpy.ops.mesh.primitive_cube_add(location=_plate_loc)
_plate = bpy.context.active_object
_plate.name = _target.name + "_Label"
_plate.dimensions = ({width}, {height}, 0.0008)
_plate.rotation_euler = {_face_rotation(face)}
_label_mat = bpy.data.materials.new(name="DetailLabel")
_label_mat.use_nodes = True
_label_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.92, 0.9, 0.85, 1)
_label_mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.5
_plate.data.materials.append(_label_mat)
{text_block}
print(f"DETAIL_OK label face={face} on {{_target.name}}")
"""

    if kind == "condensation":
        # Condensation (v1.4.0, research §3.5): bimodal flattened water
        # droplets merged into ONE mesh on the target surface (instancing is
        # the memory-cheap option for huge counts, but a merged mesh is
        # simpler to verify and fast enough at hero counts), plus vertical
        # runnels on the lower third and a wet-film roughness drop on the
        # target's material.
        # Counts: hero ~1200 small + ~80 large per 330 ml can (0.024 m²
        # lateral area); derived from the target's lateral bbox area so the
        # density is scale-correct for ANY can/bottle size. These counts
        # are [RECOMMENDATION] (research §9) — they look right on the
        # hero render, not measured from a photo.
        density = str(params.get("density", "hero")).lower()
        if density not in ("hero", "wide"):
            raise ValueError(f"condensation density must be 'hero' or 'wide', got '{density}'.")
        drops_small = params.get("drops_small")
        drops_large = params.get("drops_large")
        if drops_small is not None:
            drops_small = max(0, min(5000, round(_num(drops_small, 0))))
        if drops_large is not None:
            drops_large = max(0, min(500, round(_num(drops_large, 0))))
        runnels = max(0, min(50, round(_num(params.get("runnels"), 8))))
        _small = "None" if drops_small is None else str(drops_small)
        _large = "None" if drops_large is None else str(drops_large)
        return _prelude(target) + f"""
import bmesh, random
from mathutils import Vector, Matrix
random.seed(42)
# Lateral bbox area of the target; a 330 ml can is ~0.024 m2.
_area = 2 * (_size[0] + _size[1]) * _size[2]
_factor = max(0.2, min(3.0, _area / 0.024))
_n_small = {_small} if {_small} is not None else max(100, min(2500, round(1200 * _factor)))
_n_large = {_large} if {_large} is not None else max(10, min(150, round(80 * _factor)))
# 'wide' density: halve the small drops and drop the sub-mm size class.
_r_small = (0.001, 0.0015) if '{density}' == 'wide' else (0.00025, 0.00075)
if '{density}' == 'wide':
    _n_small = _n_small // 2
_r_large = (0.001, 0.002)
# Area-weighted face sampling: pick a face by area, then a point on it
# (barycentric in one of its triangles; quads split 50/50 so both halves
# are covered — sampling only the first triangle would stripe a can).
_verts = [_target.matrix_world @ v.co for v in _target.data.vertices]
_nmat = _target.matrix_world.to_3x3().inverted().transposed()
_faces = list(_target.data.polygons)
_weights = [p.area for p in _faces]
_total = sum(_weights)
def _pick_point():
    _r = random.random() * _total
    for _p, _w in zip(_faces, _weights):
        _r -= _w
        if _r <= 0:
            break
    _idx = list(_p.vertices)
    if len(_idx) == 4 and random.random() < 0.5:
        _tri = (_idx[0], _idx[2], _idx[3])
    else:
        _tri = (_idx[0], _idx[1], _idx[2])
    _a, _b, _c = _verts[_tri[0]], _verts[_tri[1]], _verts[_tri[2]]
    _u, _v = random.random(), random.random()
    if _u + _v > 1:
        _u, _v = 1 - _u, 1 - _v
    _pt = _a + _u * (_b - _a) + _v * (_c - _a)
    _n = (_nmat @ _p.normal).normalized()
    return _pt, _n
# One unit-sphere template, stamped once per droplet: calling
# create_uvsphere per droplet is O(n^2)-slow (each op scans the growing
# mesh) — at hero counts (~1500 drops) it takes minutes. Stamping
# transformed copies of one template is linear and takes seconds.
_tpl = bmesh.new()
bmesh.ops.create_uvsphere(_tpl, u_segments=8, v_segments=6, radius=1.0)
_tpl.verts.ensure_lookup_table()
_tpl.faces.ensure_lookup_table()
_tpl_verts = [v.co.copy() for v in _tpl.verts]
_tpl_faces = [[v.index for v in f.verts] for f in _tpl.faces]
_tpl.free()
_bm = bmesh.new()
def _stamp(_mat):
    _vs = [_bm.verts.new(_mat @ _co) for _co in _tpl_verts]
    for _f in _tpl_faces:
        _bm.faces.new([_vs[_j] for _j in _f])
_mesh = bpy.data.meshes.new(_target.name + "_Condensation")
for _i in range(_n_small + _n_large):
    _r = random.uniform(*_r_small) if _i < _n_small else random.uniform(*_r_large)
    _pt, _n = _pick_point()
    # Sessile cap: a UV sphere flattened (Z 0.45) and lifted so its flat
    # side sits ON the surface, aligned to the surface normal.
    _quat = Vector((0, 0, 1)).rotation_difference(_n)
    _m = (Matrix.Translation(_pt) @ _quat.to_matrix().to_4x4()
          @ Matrix.Translation((0, 0, 0.45 * _r))
          @ Matrix.Diagonal(Vector((_r, _r, 0.45 * _r, 1.0))))
    _stamp(_m)
# Runnels: vertical drip streaks (elongated drops) on the lower third.
for _i in range({runnels}):
    for _attempt in range(10):
        _pt, _n = _pick_point()
        if _pt.z <= _lo[2] + _size[2] * 0.35:
            break
    else:
        continue
    _len = random.uniform(0.005, 0.02)
    _r = 0.0008
    _m = Matrix.Translation(_pt + _n * _r) @ Matrix.Diagonal(Vector((_r, _r, _len / 2, 1.0)))
    _stamp(_m)
_bm.to_mesh(_mesh)
_bm.free()
_drops = bpy.data.objects.new(_target.name + "_Condensation", _mesh)
bpy.context.scene.collection.objects.link(_drops)
# Water material: Transmission 1.0, Roughness 0.02, IOR 1.33.
_wmat = bpy.data.materials.new(name="CondensationWater")
_wmat.use_nodes = True
_wbsdf = _wmat.node_tree.nodes["Principled BSDF"]
_wbsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1)
_wbsdf.inputs["Roughness"].default_value = 0.02
_wbsdf.inputs["Transmission Weight"].default_value = 1.0
_wbsdf.inputs["IOR"].default_value = 1.33
_mesh.materials.append(_wmat)
# Droplets must not cast dotted shadows on the can (research §3.5).
# NOTE: the research named 'cycles_visibility.shadow' — that is the
# pre-2.8 API and does not exist in Blender 4.2 (verified). In 4.2 ray
# visibility is core Object RNA: 'visible_shadow' (Cycles and EEVEE).
_drops.visible_shadow = False
# Wet film under the drops: the can is wet between droplets, not dry.
# Only if the target's first Principled material has an unlinked
# Roughness — never override a roughness already driven by nodes.
for _m in _target.data.materials:
    if _m and _m.use_nodes:
        _b = _m.node_tree.nodes.get("Principled BSDF")
        if _b is not None and not _b.inputs["Roughness"].is_linked:
            _nt2 = _m.node_tree
            _tex2 = _nt2.nodes.new("ShaderNodeTexCoord")
            _nz2 = _nt2.nodes.new("ShaderNodeTexNoise")
            _nz2.inputs["Scale"].default_value = 12.0
            _nt2.links.new(_tex2.outputs["Generated"], _nz2.inputs["Vector"])
            _rp2 = _nt2.nodes.new("ShaderNodeValToRGB")
            _rp2.color_ramp.elements[0].position = 0.0
            _rp2.color_ramp.elements[0].color = (0.1, 0.1, 0.1, 1)
            _rp2.color_ramp.elements[1].position = 1.0
            _rp2.color_ramp.elements[1].color = (0.25, 0.25, 0.25, 1)
            _nt2.links.new(_nz2.outputs["Fac"], _rp2.inputs["Fac"])
            _nt2.links.new(_rp2.outputs["Color"], _b.inputs["Roughness"])
            break
print(f"DETAIL_OK condensation small={{_n_small}} large={{_n_large}} on {{_target.name}}")
"""

    if kind == "emissive_ring":
        axis_name = str(params.get("axis", "z")).lower()
        if axis_name not in ("x", "y", "z"):
            raise ValueError(f"emissive_ring axis must be 'x', 'y' or 'z', got '{axis_name}'.")
        axis = {"x": 0, "y": 1, "z": 2}[axis_name]
        scale = _num(params.get("radius_scale"), 1.0)
        tube = _num(params.get("tube_m"), 0.002)
        color = _parse_color(params.get("color"), (0.0, 0.85, 1.0))
        strength = _num(params.get("strength"), 3.0)
        if tube <= 0 or tube > 0.02:
            raise ValueError("emissive_ring tube_m must be > 0 and <= 0.02 m.")
        if not (0 < strength <= 10):
            raise ValueError("emissive_ring strength must be > 0 and <= 10 (research: never > 10 on a large area).")
        rot = (
            "(0, 0, 0)" if axis == 2
            else "(0, 0, math.pi / 2)" if axis == 1
            else "(0, math.pi / 2, 0)"
        )
        scale_tuple = (
            "_size[0] / 2, _size[1] / 2, 1" if axis == 2
            else "_size[0] / 2, _size[2] / 2, 1" if axis == 1
            else "_size[2] / 2, _size[1] / 2, 1"
        )
        return _prelude(target) + f"""
import math
bpy.ops.mesh.primitive_torus_add(location=_centre, major_radius=1.0, minor_radius={tube})
_ring = bpy.context.active_object
_ring.name = _target.name + "_EmissiveRing"
_ring.rotation_euler = {rot}
_sx, _sy, _sz = {scale_tuple}
_ring.scale = (_sx * {scale}, _sy * {scale}, _sz * {scale})
_ring_mat = bpy.data.materials.new(name="EmissiveRing")
_ring_mat.use_nodes = True
_rb = _ring_mat.node_tree.nodes["Principled BSDF"]
_rb.inputs["Base Color"].default_value = (0.01, 0.01, 0.01, 1)
_rb.inputs["Emission Color"].default_value = {_rgba_str(color)}
_rb.inputs["Emission Strength"].default_value = {strength}
_ring.data.materials.append(_ring_mat)
print(f"DETAIL_OK emissive_ring axis={axis_name} strength={strength} on {{_target.name}}")
"""

    if kind == "glow_strip":
        face = str(params.get("face", "front"))
        width = _num(params.get("width_m"), 0.005)
        length = _num(params.get("length_m"), 0)
        color = _parse_color(params.get("color"), (0.0, 0.85, 1.0))
        strength = _num(params.get("strength"), 5.0)
        if width <= 0 or width > 0.05:
            raise ValueError("glow_strip width_m must be > 0 and <= 0.05 m.")
        if not (0 < strength <= 10):
            raise ValueError("glow_strip strength must be > 0 and <= 10 (research: never > 10 on a large area).")
        axis, _sign = _face_info(face)
        # Vertical strip: long along Z on side faces, along X on top/bottom.
        dims = (
            f"({length or '_size[2] * 0.8'}, {width}, 0.002)" if axis == 0 else
            f"({width}, {length or '_size[2] * 0.8'}, 0.002)" if axis == 1 else
            f"({length or '_size[0] * 0.8'}, {width}, 0.002)"
        )
        return _prelude(target) + f"""
_strip_loc = {_face_point(face, 0, 0, 0.001)}
bpy.ops.mesh.primitive_cube_add(location=_strip_loc)
_strip = bpy.context.active_object
_strip.name = _target.name + "_GlowStrip"
_strip.dimensions = {dims}
_strip.rotation_euler = {_face_rotation(face)}
_strip_mat = bpy.data.materials.new(name="GlowStrip")
_strip_mat.use_nodes = True
_sb = _strip_mat.node_tree.nodes["Principled BSDF"]
_sb.inputs["Base Color"].default_value = (0.01, 0.01, 0.01, 1)
_sb.inputs["Emission Color"].default_value = {_rgba_str(color)}
_sb.inputs["Emission Strength"].default_value = {strength}
_strip.data.materials.append(_strip_mat)
print(f"DETAIL_OK glow_strip face={face} strength={strength} on {{_target.name}}")
"""

    raise ValueError(f"Unknown detail '{detail}'.")
