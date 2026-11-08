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
]

DETAIL_KINDS = [d["kind"] for d in DETAIL_TYPES]


def _num(v, fallback):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return fallback
    return n if n == n and abs(n) != float("inf") else fallback


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

    raise ValueError(f"Unknown detail '{detail}'.")
