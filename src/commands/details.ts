/**
 * Detail helpers library (Blender-MCP 1.3.0) — small manufactured details
 * the calling model can apply to a target object: bevels, subdivision
 * surfaces, panel lines, screws/bolts, seams, grilles/vents, labels.
 *
 * MeshCoder's lesson, applied here: an expressive helper vocabulary beats
 * raw `primitive_*` calls — these are the details that make a model read
 * as manufactured rather than stacked primitives. Every helper is a real
 * `bpy` snippet that runs in Blender 4.2.0 (smoke-tested, see tests).
 *
 * `getDetailScript(detail, target, params)` returns a Blender snippet that
 * operates on the object named `target` (matched by substring, like the
 * rest of the server) and leaves the scene saved by the caller. Params are
 * validated; unknown detail names and out-of-range params fail with a
 * clear error instead of building silently wrong geometry.
 */

export type DetailKind =
  | 'bevel'
  | 'subdivision'
  | 'panel_line'
  | 'screw'
  | 'bolt'
  | 'seam'
  | 'grille'
  | 'label';

export interface DetailSpec {
  kind: DetailKind;
  description: string;
  params: string;
  example: string;
}

export const DETAIL_TYPES: DetailSpec[] = [
  {
    kind: 'bevel',
    description: 'Rounded edge (Bevel modifier) on the target — softens hard CG edges so highlights read as manufactured. Params: width_m (default 0.002), segments (default 3).',
    params: 'width_m, segments',
    example: '{detail: "bevel", target: "WatchCase", params: {width_m: 0.0015, segments: 3}}',
  },
  {
    kind: 'subdivision',
    description: 'Subdivision Surface modifier — smooths faceted curves (bottle shoulders, earcup shells, shoe uppers). Params: levels (default 2). Apply AFTER bevel for a clean edge.',
    params: 'levels',
    example: '{detail: "subdivision", target: "BottleBody", params: {levels: 2}}',
  },
  {
    kind: 'panel_line',
    description: 'Thin dark recessed strip on one face of the target — the seam between two manufactured panels (headphone cup split, watch case back, sneaker midsole line). Params: face ("top"|"front"|"back"|"left"|"right", default "front"), offset_m along the face normal (default 0.001), length_m, width_m (default 0.002), depth_m (default 0.001).',
    params: 'face, offset_m, length_m, width_m, depth_m',
    example: '{detail: "panel_line", target: "Earcup_L", params: {face: "front", length_m: 0.06}}',
  },
  {
    kind: 'screw',
    description: 'Small screw head (cylinder + dark slot) on one face of the target — case-back screws, sole screws, hinge screws. Params: face (default "back"), x_m, y_m position on the face (default 0, 0 = face centre), radius_m (default 0.003), head_depth_m (default 0.001).',
    params: 'face, x_m, y_m, radius_m, head_depth_m',
    example: '{detail: "screw", target: "WatchCaseBack", params: {face: "back", x_m: 0.01, y_m: 0.008}}',
  },
  {
    kind: 'bolt',
    description: 'Hex bolt (6-sided head + shaft) on one face of the target. Params: face (default "top"), x_m, y_m, radius_m (default 0.004), head_depth_m (default 0.002).',
    params: 'face, x_m, y_m, radius_m, head_depth_m',
    example: '{detail: "bolt", target: "SolePlate", params: {face: "top", x_m: 0.02}}',
  },
  {
    kind: 'seam',
    description: 'Thin dark ring around the target (torus hugging its bounding box) — the stitch/seam line where two parts meet (cushion seam, bottle neck ring, strap joint). Params: axis ("x"|"y"|"z", default "z"), radius_scale (default 1.0, fraction of the bbox half-size), tube_m (default 0.001).',
    params: 'axis, radius_scale, tube_m',
    example: '{detail: "seam", target: "EarCushion_L", params: {axis: "z"}}',
  },
  {
    kind: 'grille',
    description: 'Speaker/vent grille: a dark recessed panel with a grid of small slats on one face of the target (headphone driver cover, sneaker vent, watch speaker). Params: face (default "front"), rows (default 5), cols (default 8), size_m (panel size, default 0.04).',
    params: 'face, rows, cols, size_m',
    example: '{detail: "grille", target: "Earcup_L", params: {face: "front", rows: 6, cols: 10}}',
  },
  {
    kind: 'label',
    description: 'Thin label plate on one face of the target, with optional raised text (a real Text object). Params: face (default "front"), width_m (default 0.03), height_m (default 0.012), text (optional string, e.g. a brand name), text_size_m (default 0.006).',
    params: 'face, width_m, height_m, text, text_size_m',
    example: '{detail: "label", target: "BottleBody", params: {face: "front", text: "NOIR"}}',
  },
];

export const DETAIL_KINDS = DETAIL_TYPES.map((d) => d.kind);

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Face of a bounding box: (axis, sign, centre offset direction). */
function faceInfo(face: string): { axis: 0 | 1 | 2; sign: 1 | -1 } {
  switch ((face || 'front').toLowerCase()) {
    case 'top': return { axis: 2, sign: 1 };
    case 'bottom': return { axis: 2, sign: -1 };
    case 'front': return { axis: 1, sign: -1 };
    case 'back': return { axis: 1, sign: 1 };
    case 'left': return { axis: 0, sign: -1 };
    case 'right': return { axis: 0, sign: 1 };
    default: throw new Error(`Unknown face '${face}'. Allowed: top, bottom, front, back, left, right.`);
  }
}

/**
 * Shared Blender prelude: find the target object and compute its
 * world-space bounding box (centre, size). Throws in Blender when the
 * target is missing — a silent no-op would be worse than an error.
 */
function prelude(target: string): string {
  return `
import bpy
from mathutils import Vector
_target_name = ${JSON.stringify(target)}
_targets = [o for o in bpy.data.objects if o.type == 'MESH' and _target_name in o.name]
if not _targets:
    raise RuntimeError(f"add_detail: no mesh object matching '{_target_name}'")
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
`;
}

/** Position on a bbox face: returns a Blender expression for (x, y, z).
 *  `u` / `v` are offsets along the two non-normal axes, in metres — either
 *  literal numbers or Blender expressions (e.g. a loop variable). */
function facePoint(face: string, u: number | string, v: number | string, offset: number): string {
  const { axis, sign } = faceInfo(face);
  // u, v are offsets along the two non-normal axes, in metres.
  const coords = [0, 1, 2].map((a) => {
    if (a === axis) return `_centre[${a}] + ${sign} * (_size[${a}] / 2 + ${offset})`;
    // first non-normal axis gets u, second gets v
    const others = [0, 1, 2].filter((x) => x !== axis);
    return others[0] === a ? `_centre[${a}] + (${u})` : `_centre[${a}] + (${v})`;
  });
  return `(${coords[0]}, ${coords[1]}, ${coords[2]})`;
}

/** Rotation that points a cylinder's local Z along a bbox-face normal. */
function faceRotation(face: string): string {
  const { axis, sign } = faceInfo(face);
  if (axis === 2) return `(0, 0, 0)`; // Z normal: cylinder default is already Z
  if (axis === 1) return `(1.57079632679, 0, 0)`; // Y normal: rotate 90 deg about X
  return `(0, 1.57079632679, 0)`; // X normal: rotate 90 deg about Y
}

export function getDetailScript(detail: string, target: string, params: Record<string, unknown> = {}): string {
  if (!target || !target.trim()) throw new Error('add_detail needs a target object name.');
  const kind = (detail || '').toLowerCase() as DetailKind;
  if (!DETAIL_KINDS.includes(kind)) {
    throw new Error(`Unknown detail '${detail}'. Available: ${DETAIL_KINDS.join(', ')}.`);
  }
  const p = params;

  switch (kind) {
    case 'bevel': {
      const width = num(p.width_m, 0.002);
      const segments = Math.max(1, Math.min(6, Math.round(num(p.segments, 3))));
      if (width <= 0 || width > 0.05) throw new Error('bevel width_m must be > 0 and <= 0.05 m.');
      return prelude(target) + `
_mod = _target.modifiers.new(name="DetailBevel", type='BEVEL')
_mod.width = ${width}
_mod.segments = ${segments}
_mod.limit_method = 'ANGLE'
print(f"DETAIL_OK bevel width=${width} segments=${segments} on {_target.name}")
`;
    }
    case 'subdivision': {
      const levels = Math.max(1, Math.min(4, Math.round(num(p.levels, 2))));
      return prelude(target) + `
_mod = _target.modifiers.new(name="DetailSubdiv", type='SUBSURF')
_mod.subdivision_type = 'CATMULL_CLARK'
_mod.levels = ${levels}
_mod.render_levels = ${levels}
print(f"DETAIL_OK subdivision levels=${levels} on {_target.name}")
`;
    }
    case 'panel_line': {
      const face = String(p.face ?? 'front');
      const offset = num(p.offset_m, 0.001);
      const width = num(p.width_m, 0.002);
      const depth = num(p.depth_m, 0.001);
      const length = num(p.length_m, 0);
      const { axis } = faceInfo(face);
      // The strip runs along the longest non-normal bbox axis by default.
      const otherAxes = [0, 1, 2].filter((a) => a !== axis);
      const stripLenExpr = length > 0 ? String(length) : `min(_size[${otherAxes[0]}] * 0.8, _size[${otherAxes[0]}]) if _size[${otherAxes[0]}] > 0 else 0.05`;
      return prelude(target) + `
_face_axis = ${axis}
_len = ${stripLenExpr}
_other = [${otherAxes[0]}, ${otherAxes[1]}]
# Strip dims: long along the first non-normal axis, thin along the normal.
_dims = [0.001, 0.001, 0.001]
_dims[_other[0]] = _len
_dims[_other[1]] = ${width}
_dims[_face_axis] = ${depth}
_loc = ${facePoint(face, 0, 0, offset)}
bpy.ops.mesh.primitive_cube_add(location=_loc)
_strip = bpy.context.active_object
_strip.name = _target.name + "_PanelLine"
_strip.dimensions = _dims
_strip.data.materials.append(_detail_mat)
print(f"DETAIL_OK panel_line face=${face} on {_target.name}")
`;
    }
    case 'screw': {
      const face = String(p.face ?? 'back');
      const x = num(p.x_m, 0);
      const y = num(p.y_m, 0);
      const radius = num(p.radius_m, 0.003);
      const depth = num(p.head_depth_m, 0.001);
      if (radius <= 0 || radius > 0.05) throw new Error('screw radius_m must be > 0 and <= 0.05 m.');
      return prelude(target) + `
_loc = ${facePoint(face, x, y, depth / 2)}
bpy.ops.mesh.primitive_cylinder_add(location=_loc, radius=${radius}, depth=${depth}, vertices=24)
_screw = bpy.context.active_object
_screw.name = _target.name + "_Screw"
_screw.rotation_euler = ${faceRotation(face)}
_screw.data.materials.append(_detail_mat)
# Slot: thin dark box across the head.
_slot_loc = ${facePoint(face, x, y, depth + 0.0002)}
bpy.ops.mesh.primitive_cube_add(location=_slot_loc)
_slot = bpy.context.active_object
_slot.name = _target.name + "_ScrewSlot"
_slot.dimensions = (${radius * 1.6}, ${radius * 0.3}, ${depth * 0.6})
_slot.rotation_euler = ${faceRotation(face)}
_slot.data.materials.append(_detail_mat)
print(f"DETAIL_OK screw face=${face} on {_target.name}")
`;
    }
    case 'bolt': {
      const face = String(p.face ?? 'top');
      const x = num(p.x_m, 0);
      const y = num(p.y_m, 0);
      const radius = num(p.radius_m, 0.004);
      const depth = num(p.head_depth_m, 0.002);
      if (radius <= 0 || radius > 0.05) throw new Error('bolt radius_m must be > 0 and <= 0.05 m.');
      return prelude(target) + `
_loc = ${facePoint(face, x, y, depth / 2)}
bpy.ops.mesh.primitive_cylinder_add(location=_loc, radius=${radius}, depth=${depth}, vertices=6)
_bolt = bpy.context.active_object
_bolt.name = _target.name + "_Bolt"
_bolt.rotation_euler = ${faceRotation(face)}
_bolt.data.materials.append(_detail_mat)
# Shaft below the head, into the target.
_shaft_loc = ${facePoint(face, x, y, -depth)}
bpy.ops.mesh.primitive_cylinder_add(location=_shaft_loc, radius=${radius * 0.55}, depth=${depth * 2}, vertices=12)
_shaft = bpy.context.active_object
_shaft.name = _target.name + "_BoltShaft"
_shaft.rotation_euler = ${faceRotation(face)}
_shaft.data.materials.append(_detail_mat)
print(f"DETAIL_OK bolt face=${face} on {_target.name}")
`;
    }
    case 'seam': {
      const axisName = String(p.axis ?? 'z').toLowerCase();
      const axis = axisName === 'x' ? 0 : axisName === 'y' ? 1 : 2;
      if (!['x', 'y', 'z'].includes(axisName)) throw new Error(`seam axis must be x, y or z, got '${axisName}'.`);
      const scale = num(p.radius_scale, 1.0);
      const tube = num(p.tube_m, 0.001);
      if (tube <= 0 || tube > 0.02) throw new Error('seam tube_m must be > 0 and <= 0.02 m.');
      // Torus ring lies in XY by default; rotate so its plane is
      // perpendicular to the seam axis, then scale the UNIT ring into an
      // ellipse that hugs the object's actual cross-section. A circular
      // ring sized by max() floats far off any flat or long object (the
      // v1.3.0 demo's headband got a giant floating ring); the ellipse
      // uses the two cross-section half-dims, so the seam sits on the
      // surface. (The 1 mm tube is squashed in the short axis — fine for
      // a seam line.) Scale is in the torus's local axes: local x/y are
      // the ring plane, so per axis the tuple is (half-dim along local
      // x, half-dim along local y, 1).
      const rot = axis === 2 ? '(0, 0, 0)' : axis === 1 ? '(1.57079632679, 0, 0)' : '(0, 1.57079632679, 0)';
      const scaleTuple = axis === 2
        ? '_size[0] / 2, _size[1] / 2, 1'
        : axis === 1 ? '_size[0] / 2, _size[2] / 2, 1' : '_size[2] / 2, _size[1] / 2, 1';
      return prelude(target) + `
bpy.ops.mesh.primitive_torus_add(location=_centre, major_radius=1.0, minor_radius=${tube})
_seam = bpy.context.active_object
_seam.name = _target.name + "_Seam"
_seam.rotation_euler = ${rot}
_sx, _sy, _sz = ${scaleTuple}
_seam.scale = (_sx * ${scale}, _sy * ${scale}, _sz * ${scale})
_seam.data.materials.append(_detail_mat)
print(f"DETAIL_OK seam axis=${axisName} on {_target.name}")
`;
    }
    case 'grille': {
      const face = String(p.face ?? 'front');
      const rows = Math.max(1, Math.min(20, Math.round(num(p.rows, 5))));
      const cols = Math.max(1, Math.min(20, Math.round(num(p.cols, 8))));
      const size = num(p.size_m, 0.04);
      if (size <= 0 || size > 0.5) throw new Error('grille size_m must be > 0 and <= 0.5 m.');
      return prelude(target) + `
_panel_loc = ${facePoint(face, 0, 0, 0.0005)}
bpy.ops.mesh.primitive_cube_add(location=_panel_loc)
_panel = bpy.context.active_object
_panel.name = _target.name + "_GrillePanel"
_panel.dimensions = (${size}, ${size}, 0.001)
_panel.rotation_euler = ${faceRotation(face)}
_panel.data.materials.append(_detail_mat)
# Slats: thin raised bars across the panel, spaced along the panel.
for _i in range(${rows}):
    _t = (_i / max(1, ${rows} - 1) - 0.5) * ${size} * 0.8 if ${rows} > 1 else 0.0
    # Slats span the panel's U axis and are spaced along its V axis.
    _slat_loc = ${facePoint(face, 0, '_t', 0.001)}
    bpy.ops.mesh.primitive_cube_add(location=_slat_loc)
    _slat = bpy.context.active_object
    _slat.name = _target.name + "_GrilleSlat"
    _slat.dimensions = (${size} * 0.8, 0.0015, 0.0008)
    _slat.rotation_euler = ${faceRotation(face)}
print(f"DETAIL_OK grille rows=${rows} on {_target.name}")
`;
    }
    case 'label': {
      const face = String(p.face ?? 'front');
      const width = num(p.width_m, 0.03);
      const height = num(p.height_m, 0.012);
      const text = typeof p.text === 'string' ? p.text : '';
      const textSize = num(p.text_size_m, 0.006);
      if (width <= 0 || height <= 0) throw new Error('label width_m and height_m must be > 0.');
      const textBlock = text
        ? `
# Raised text on the label plate.
_curve = bpy.data.curves.new(name=_target.name + "_LabelText", type='FONT')
_curve.body = ${JSON.stringify(text)}
_curve.size = ${textSize}
_curve.align_x = 'CENTER'
_curve.align_y = 'CENTER'
_text_obj = bpy.data.objects.new(name=_target.name + "_LabelText", object_data=_curve)
bpy.context.scene.collection.objects.link(_text_obj)
_text_obj.location = ${facePoint(face, 0, 0, 0.002)}
_text_obj.rotation_euler = ${faceRotation(face)}
_text_mat = bpy.data.materials.get("DetailDark") or _detail_mat
_text_obj.data.materials.append(_text_mat)
`
        : '';
      return prelude(target) + `
_plate_loc = ${facePoint(face, 0, 0, 0.0008)}
bpy.ops.mesh.primitive_cube_add(location=_plate_loc)
_plate = bpy.context.active_object
_plate.name = _target.name + "_Label"
_plate.dimensions = (${width}, ${height}, 0.0008)
_plate.rotation_euler = ${faceRotation(face)}
_label_mat = bpy.data.materials.new(name="DetailLabel")
_label_mat.use_nodes = True
_label_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.92, 0.9, 0.85, 1)
_label_mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.5
_plate.data.materials.append(_label_mat)
${textBlock}
print(f"DETAIL_OK label face=${face} on {_target.name}")
`;
    }
  }
}
