"""Structured scene spec (Blender-MCP 1.2.0) — research-first pipeline.

The LLM first produces a small JSON spec instead of guessing coordinates
inside template code::

    {"objects": [{"name": "Seat", "kind": "cube",
                  "size_m": [0.45, 0.45, 0.10],
                  "position_m": [0.45, 0, 0.52],
                  "material": "fabric",
                  "attach": "on_top_of:Floor"}]}

Conventions (Procedura / SceneCraft pattern):

- ``position_m`` is the BOTTOM-CENTRE of the object (origin at bottom
  centre), sizes are in metres, Z is up, ground is z = 0.
- ``kind`` is one of cube / sphere / cylinder / cone / torus.
- ``attach`` is a mate: ``grounded``, ``on_top_of:<name>`` or
  ``centred_on:<name>``. Placement is solved from the parent's bounding
  box by the mate helpers emitted into the generated code — never guessed.

Validation (all failures are returned with the exact failed check):

- every size component > 0, finite, and not the [1, 1, 1] unit placeholder
- every position.z >= 0 and finite
- every part declares a dimension_source (measured / research / library /
  reference_image / retrieved_asset); a part that claims 'library' must
  match the built-in dimension library for the spec's product
- every part has a material (an unmaterialed part renders flat grey)
- bounding boxes inside a 10 m work area (|x|, |y| <= 5, z <= 10)
- every part must be grounded (bottom z ~ 0) or touch another part's
  bounding box — a part that touches nothing is floating and is rejected
- objects declaring ``attach`` must reference an existing object, and for
  ``on_top_of`` the child's bottom must touch the parent's top within
  0.05 m tolerance
"""

import json
import math

from blender_mcp.grounding import DIMENSION_SOURCES, spec_matches_library

WORK_AREA_HALF = 5.0   # |x|, |y| <= 5 m
WORK_AREA_HEIGHT = 10.0  # z <= 10 m
ATTACH_TOLERANCE = 0.05  # m
CONTACT_TOLERANCE = 0.01  # m — a part must touch the ground or another part

KINDS = ("cube", "sphere", "cylinder", "cone", "torus")

# Mate helpers emitted into every generated script. Placement is solved
# from the parent's bounding box at build time, never from guessed
# coordinates.
MATE_HELPERS = '''
# --- mate helpers (placement solved from bounding boxes) ---
def _bbox_bottom_centre(obj):
    lo, hi = _bounds_of([obj])
    return ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2])

def _bbox_centre(obj):
    lo, hi = _bounds_of([obj])
    return ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)

def _bbox_top(obj):
    return _bounds_of([obj])[1][2]

def grounded(size):
    """Bottom z of an object standing on the ground (z = 0)."""
    return 0.0

def on_top_of(parent, size):
    """Bottom-centre of an object sitting on top of ``parent``."""
    cx, cy, _ = _bbox_centre(parent)
    return (cx, cy, _bbox_top(parent))

def centred_on(parent, size):
    """Bottom-centre of an object centred horizontally on ``parent``."""
    cx, cy, _ = _bbox_centre(parent)
    return (cx, cy, None)  # z comes from position_m
'''


def _rotated_corners(size, rotation_deg):
    """8 corners of a size box rotated by rotation_deg (XYZ euler)."""
    rx, ry, rz = (math.radians(a) for a in rotation_deg)
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    # R = Rz @ Ry @ Rx
    r = [
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy, cy * sx, cy * cx],
    ]
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    corners = []
    for x in (-hx, hx):
        for y in (-hy, hy):
            for z in (-hz, hz):
                corners.append((
                    r[0][0] * x + r[0][1] * y + r[0][2] * z,
                    r[1][0] * x + r[1][1] * y + r[1][2] * z,
                    r[2][0] * x + r[2][1] * y + r[2][2] * z,
                ))
    return corners


def object_bounds(obj):
    """(min, max) world-space AABB of one spec object.

    position_m is the bottom-centre, so the centre is position + half
    height; rotation is applied to the box corners.
    """
    size = [float(v) for v in obj["size_m"]]
    pos = [float(v) for v in obj["position_m"]]
    rot = [float(v) for v in obj.get("rotation_deg") or [0, 0, 0]]
    corners = _rotated_corners(size, rot)
    # Rotated AABB height is position-independent: for a rotated object the
    # world height is the rotated height, not size[2]. The centre is the
    # bottom-centre plus half that rotated height, so validation and the
    # generated code agree on where the object actually sits.
    rot_height = max(c[2] for c in corners) - min(c[2] for c in corners)
    centre = (pos[0], pos[1], pos[2] + rot_height / 2)
    xs = [centre[0] + c[0] for c in corners]
    ys = [centre[1] + c[1] for c in corners]
    zs = [centre[2] + c[2] for c in corners]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def parse_spec(spec):
    """Accept a spec object or a JSON string; return (spec, error)."""
    if isinstance(spec, str):
        try:
            spec = json.loads(spec)
        except json.JSONDecodeError as e:
            return None, f"spec is not valid JSON: {e}"
    if not isinstance(spec, dict):
        return None, "spec must be a JSON object with an 'objects' list"
    return spec, None


def validate_spec(spec):
    """Validate a scene spec.

    Returns a list of failed checks (empty list = valid). Each entry
    names the object and the exact failed check.
    """
    errors = []
    if not isinstance(spec, dict):
        return ["spec must be a JSON object with an 'objects' list"]
    objects = spec.get("objects")
    if not isinstance(objects, list) or not objects:
        return ["spec.objects must be a non-empty list"]
    by_name = {}
    spec_default_source = spec.get("dimension_source")
    for i, obj in enumerate(objects):
        label = obj.get("name") if isinstance(obj, dict) else f"objects[{i}]"
        if not isinstance(obj, dict):
            errors.append(f"{label}: object must be a JSON object")
            continue
        if not obj.get("name"):
            errors.append(f"objects[{i}]: missing 'name'")
            continue
        by_name[obj["name"]] = obj
        kind = obj.get("kind")
        if kind not in KINDS:
            errors.append(f"{obj['name']}: kind {kind!r} is not one of {', '.join(KINDS)}")
        size = obj.get("size_m")
        if (not isinstance(size, (list, tuple)) or len(size) != 3
                or not all(isinstance(v, (int, float)) for v in size)):
            errors.append(f"{obj['name']}: size_m must be [x, y, z] numbers")
            continue
        for axis, value in zip("xyz", size):
            if not math.isfinite(value):
                errors.append(f"{obj['name']}: size_m.{axis} must be a finite number, got {value}")
            elif not value > 0:
                errors.append(f"{obj['name']}: size_m.{axis} must be > 0, got {value}")
        if (len(size) == 3 and all(isinstance(v, (int, float)) and v == 1 for v in size)):
            errors.append(
                f"{obj['name']}: size_m {list(size)} is the [1, 1, 1] unit placeholder — "
                "replace it with real dimensions from research, the dimension library "
                "(get_dimensions) or a measurement, and state the source")
        pos = obj.get("position_m")
        if (not isinstance(pos, (list, tuple)) or len(pos) != 3
                or not all(isinstance(v, (int, float)) for v in pos)):
            errors.append(f"{obj['name']}: position_m must be [x, y, z] numbers")
            continue
        for axis, value in zip("xyz", pos):
            if not math.isfinite(value):
                errors.append(f"{obj['name']}: position_m.{axis} must be a finite number, got {value}")
        if pos[2] < 0:
            errors.append(f"{obj['name']}: position_m.z must be >= 0 (ground), got {pos[2]}")
        # Every part needs a stated dimension source — a number with no
        # provenance is an invented number.
        source = obj.get("dimension_source") or spec_default_source
        if not source:
            errors.append(
                f"{obj['name']}: missing 'dimension_source' — state where the dimensions "
                f"came from: {', '.join(DIMENSION_SOURCES)}")
        elif source not in DIMENSION_SOURCES:
            errors.append(
                f"{obj['name']}: dimension_source {source!r} is not one of "
                f"{', '.join(DIMENSION_SOURCES)}")
        # Every part needs a material — an unmaterialed part renders flat grey.
        if not obj.get("material"):
            errors.append(
                f"{obj['name']}: missing 'material' — every part must name a material "
                "(wood, metal, glass, fabric, steel, ...)")
        rot = obj.get("rotation_deg")
        if rot is not None and (not isinstance(rot, (list, tuple)) or len(rot) != 3
                                or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in rot)):
            errors.append(f"{obj['name']}: rotation_deg must be [x, y, z] finite numbers")
            continue
        # Work-area check on the (possibly rotated) bounding box.
        try:
            lo, hi = object_bounds(obj)
        except (KeyError, TypeError, ValueError) as e:
            errors.append(f"{obj['name']}: cannot compute bounding box: {e}")
            continue
        if lo[0] < -WORK_AREA_HALF or hi[0] > WORK_AREA_HALF:
            errors.append(
                f"{obj['name']}: bounding box x [{lo[0]:.2f}, {hi[0]:.2f}] outside "
                f"work area |x| <= {WORK_AREA_HALF}")
        if lo[1] < -WORK_AREA_HALF or hi[1] > WORK_AREA_HALF:
            errors.append(
                f"{obj['name']}: bounding box y [{lo[1]:.2f}, {hi[1]:.2f}] outside "
                f"work area |y| <= {WORK_AREA_HALF}")
        if lo[2] < 0 or hi[2] > WORK_AREA_HEIGHT:
            errors.append(
                f"{obj['name']}: bounding box z [{lo[2]:.2f}, {hi[2]:.2f}] outside "
                f"work area 0 <= z <= {WORK_AREA_HEIGHT}")
    # Attach / mate checks (needs the full name table).
    for obj in objects:
        if not isinstance(obj, dict) or not obj.get("name"):
            continue
        attach = obj.get("attach")
        if not attach:
            continue
        if attach == "grounded":
            if obj.get("position_m") and obj["position_m"][2] != 0:
                errors.append(
                    f"{obj['name']}: attach 'grounded' requires position_m.z == 0, "
                    f"got {obj['position_m'][2]}")
            continue
        for prefix in ("on_top_of:", "centred_on:"):
            if isinstance(attach, str) and attach.startswith(prefix):
                parent_name = attach[len(prefix):]
                parent = by_name.get(parent_name)
                if parent is None:
                    errors.append(
                        f"{obj['name']}: attach {attach!r} names unknown object {parent_name!r}")
                    break
                if prefix == "on_top_of:":
                    try:
                        _, parent_hi = object_bounds(parent)
                        child_lo, _ = object_bounds(obj)
                    except (KeyError, TypeError, ValueError):
                        break
                    gap = abs(child_lo[2] - parent_hi[2])
                    if gap > ATTACH_TOLERANCE + 1e-9:
                        errors.append(
                            f"{obj['name']}: attach 'on_top_of:{parent_name}' does not touch: "
                            f"child bottom z = {child_lo[2]:.3f}, parent top z = "
                            f"{parent_hi[2]:.3f} (gap {gap:.3f} m > {ATTACH_TOLERANCE} m)")
                    # Horizontal overlap: the child must sit over the parent.
                    plo, phi = object_bounds(parent)
                    clo, chi = object_bounds(obj)
                    overlap_x = min(chi[0], phi[0]) - max(clo[0], plo[0])
                    overlap_y = min(chi[1], phi[1]) - max(clo[1], plo[1])
                    if overlap_x <= 0 or overlap_y <= 0:
                        errors.append(
                            f"{obj['name']}: attach 'on_top_of:{parent_name}' has no "
                            f"horizontal overlap with the parent footprint")
                break
        else:
            if isinstance(attach, str):
                errors.append(
                    f"{obj['name']}: attach {attach!r} is not 'grounded', "
                    f"'on_top_of:<name>' or 'centred_on:<name>'")
    # Floating check: a part with no mate (or a centred_on mate, whose z
    # still comes from position_m) must sit on the ground or touch
    # another part's bounding box. A part that touches nothing is floating
    # and is rejected — the failure VLMs miss most often.
    _bounds = {}
    for obj in objects:
        if isinstance(obj, dict) and obj.get("name"):
            try:
                _bounds[obj["name"]] = object_bounds(obj)
            except (KeyError, TypeError, ValueError):
                pass
    for obj in objects:
        if not isinstance(obj, dict) or not obj.get("name"):
            continue
        attach = obj.get("attach") or ""
        if attach == "grounded" or (isinstance(attach, str) and attach.startswith("on_top_of:")):
            continue  # covered by the mate checks above
        own = _bounds.get(obj["name"])
        if own is None:
            continue
        lo, hi = own
        if lo[2] <= CONTACT_TOLERANCE:
            continue  # grounded
        touches = False
        for other_name, (olo, ohi) in _bounds.items():
            if other_name == obj["name"]:
                continue
            overlap = [min(hi[i], ohi[i]) - max(lo[i], olo[i]) for i in range(3)]
            if all(v >= -CONTACT_TOLERANCE for v in overlap):
                touches = True
                break
        if not touches:
            errors.append(
                f"{obj['name']}: FLOATING — bottom z = {lo[2]:.3f} m, touches nothing "
                "and is not on the ground. Give it an attach mate (grounded / "
                "on_top_of:<name>) or move it so it touches another part")
    # Library cross-check: 'library' claims must match the real numbers.
    errors.extend(spec_matches_library(spec))
    return errors


def build_from_spec(spec, material_script_fn=None):
    """Generate bpy for a validated spec.

    Returns (script, errors): on validation failure ``script`` is None
    and ``errors`` lists the exact failed checks. One primitive per
    object, dimensions from size_m, centre computed as bottom-centre +
    half height, rotation applied, material from the material library.
    """
    from blender_mcp.materials import MaterialLibrary

    if material_script_fn is None:
        material_script_fn = MaterialLibrary.get_material_script
    spec, parse_error = parse_spec(spec)
    if parse_error:
        return None, [parse_error]
    errors = validate_spec(spec)
    if errors:
        return None, errors

    lines = ['''
import bpy, math
from math import pi
from mathutils import Vector

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

def _bounds_of(objs):
    bpy.context.view_layer.update()  # flush scale/location edits into matrix_world
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    return lo, hi
''', MATE_HELPERS, "\ncreated = {}\n"]

    for obj in spec["objects"]:
        name = obj["name"]
        kind = obj["kind"]
        size = [float(v) for v in obj["size_m"]]
        pos = [float(v) for v in obj["position_m"]]
        rot = [float(v) for v in obj.get("rotation_deg") or [0, 0, 0]]
        material = obj.get("material")
        attach = obj.get("attach") or ""

        # Placement: mates solve the bottom-centre from the parent's
        # bounding box; otherwise position_m is used as given.
        if attach == "grounded":
            place = f"({pos[0]!r}, {pos[1]!r}, grounded({size!r}))"
        elif isinstance(attach, str) and attach.startswith("on_top_of:"):
            parent = attach[len("on_top_of:"):]
            place = f"on_top_of(created[{parent!r}], {size!r})"
        elif isinstance(attach, str) and attach.startswith("centred_on:"):
            parent = attach[len("centred_on:"):]
            place = f"centred_on(created[{parent!r}], {size!r})[:2] + ({pos[2]!r},)"
        else:
            place = f"({pos[0]!r}, {pos[1]!r}, {pos[2]!r})"

        _lo_b, _hi_b = object_bounds(obj)
        _rot_h = _hi_b[2] - _lo_b[2]
        lines.append(f"\n# {name} ({kind}, size {size}, bottom-centre from mate/position)")
        lines.append(f"_bottom = {place}")
        # Centre from the ROTATED AABB height (see TS spec.ts): for rotated
        # objects the world height is the rotated height, not size[2].
        lines.append(f"_centre = (_bottom[0], _bottom[1], _bottom[2] + {_rot_h / 2})")

        if kind == "cube":
            lines.append(
                f"bpy.ops.mesh.primitive_cube_add(location=_centre)\n"
                f"_obj = bpy.context.active_object\n"
                f"_obj.scale = ({size[0] / 2!r}, {size[1] / 2!r}, {size[2] / 2!r})")
        elif kind == "sphere":
            lines.append(
                f"bpy.ops.mesh.primitive_uv_sphere_add(location=_centre, radius=0.5)\n"
                f"_obj = bpy.context.active_object\n"
                f"_obj.scale = ({size[0]!r}, {size[1]!r}, {size[2]!r})")
        elif kind == "cylinder":
            lines.append(
                f"bpy.ops.mesh.primitive_cylinder_add(location=_centre, radius=0.5, depth=1.0)\n"
                f"_obj = bpy.context.active_object\n"
                f"_obj.scale = ({size[0]!r}, {size[1]!r}, {size[2]!r})")
        elif kind == "cone":
            lines.append(
                f"bpy.ops.mesh.primitive_cone_add(location=_centre, radius1=0.5, radius2=0.0, depth=1.0)\n"
                f"_obj = bpy.context.active_object\n"
                f"_obj.scale = ({size[0]!r}, {size[1]!r}, {size[2]!r})")
        elif kind == "torus":
            # Base torus: outer diameter 1.0, tube height 0.25.
            lines.append(
                f"bpy.ops.mesh.primitive_torus_add(location=_centre, major_radius=0.375, minor_radius=0.125)\n"
                f"_obj = bpy.context.active_object\n"
                f"_obj.scale = ({size[0]!r}, {size[1]!r}, {size[2] / 0.25!r})")
        # Curved primitives are flat-shaded by default, which reads as
        # faceted "disco ball" segments under studio light (v1.3.0 demo
        # sneaker toe/heel). Smooth-shade them so they read as moulded
        # parts. Cubes stay flat-shaded for crisp edges.
        if kind != "cube":
            lines.append("for _p in _obj.data.polygons: _p.use_smooth = True")
        if any(rot):
            lines.append(
                f"_obj.rotation_euler = (math.radians({rot[0]!r}), math.radians({rot[1]!r}), "
                f"math.radians({rot[2]!r}))")
        lines.append(f"_obj.name = {name!r}")
        lines.append(f"created[{name!r}] = _obj")
        if material:
            mat_script = material_script_fn(str(material))
            # The material snippet creates `mat`; scope it per object.
            lines.append(mat_script)
            lines.append("_obj.data.materials.append(mat)")

    lines.append('\nprint("Built scene from spec: " + str(list(created.keys())))')
    return "\n".join(lines), []
