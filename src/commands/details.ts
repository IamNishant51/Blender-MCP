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
  | 'label'
  | 'condensation'
  | 'emissive_ring'
  | 'glow_strip';

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
  {
    kind: 'condensation',
    description: 'Condensation droplets on a cold can/bottle (v1.4.0): bimodal flattened water droplets (Transmission 1.0, IOR 1.33) merged into one mesh on the target surface, plus a wet-film roughness drop (0.1-0.25) on the target material. Counts derive from the target lateral area (a 330 ml can gets ~1200 small + ~80 large); explicit drops_small/drops_large override. Params: density ("hero"|"wide", default "hero" — wide halves the small drops and drops the sub-mm class), drops_small, drops_large, runnels (vertical drip streaks on the lower third, default 8).',
    params: 'density, drops_small, drops_large, runnels',
    example: '{detail: "condensation", target: "CanBody", params: {density: "hero"}}',
  },
  {
    kind: 'emissive_ring',
    description: 'Glowing ring (torus hugging the target bounding box) — the energy-drink glow ring, a neon halo, a light-bar ring. Principled Emission (strength 2-5 for a can ring, 5-10 for hero strips; never > 10 on a large area in Cycles). Needs a Compositor Glare node to bloom — emission alone does not bloom in Cycles (see the cinematic render preset). Params: axis ("x"|"y"|"z", default "z"), radius_scale (default 1.0), tube_m (default 0.002), color ("#RRGGBB" or [r, g, b], default teal #00D8FF), strength (default 3.0).',
    params: 'axis, radius_scale, tube_m, color, strength',
    example: '{detail: "emissive_ring", target: "CanBody", params: {color: "#00D8FF", strength: 3}}',
  },
  {
    kind: 'glow_strip',
    description: 'Thin vertical emissive strip on one face of the target — a glow logo bar, a light strip, a neon edge. Principled Emission (strength 2-5 for a label accent, 5-10 for a hero strip; never > 10). Needs a Compositor Glare node to bloom in Cycles. Params: face (default "front"), width_m (default 0.005), length_m (default 0.8x the face height), color ("#RRGGBB" or [r, g, b], default teal #00D8FF), strength (default 5.0).',
    params: 'face, width_m, length_m, color, strength',
    example: '{detail: "glow_strip", target: "CanBody", params: {face: "front", color: "#00D8FF", strength: 5}}',
  },
];

export const DETAIL_KINDS = DETAIL_TYPES.map((d) => d.kind);

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Python repr parity: integral floats print as "3.0" in Python but "3" in JS. */
function pyNum(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** Accept '#RRGGBB' or [r, g, b] (0-1 floats); return an [r, g, b] tuple. */
function parseColor(v: unknown, fallback: [number, number, number]): [number, number, number] {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') {
    const s = v.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(s)) {
      return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
    }
    throw new Error(`color must be '#RRGGBB' or [r, g, b], got '${v}'.`);
  }
  if (Array.isArray(v) && v.length === 3) {
    const c = v.map((x) => Number(x));
    if (c.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) return c as [number, number, number];
  }
  throw new Error(`color must be '#RRGGBB' or [r, g, b] in 0-1, got ${JSON.stringify(v)}.`);
}

/** "(r, g, b, 1)" with Python float repr — matches the Python mirror byte-wise. */
function rgbaStr(c: [number, number, number]): string {
  return `(${pyNum(c[0])}, ${pyNum(c[1])}, ${pyNum(c[2])}, 1)`;
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
    case 'condensation': {
      const density = String(p.density ?? 'hero').toLowerCase();
      if (density !== 'hero' && density !== 'wide') {
        throw new Error(`condensation density must be 'hero' or 'wide', got '${density}'.`);
      }
      const dropsSmall = p.drops_small === undefined || p.drops_small === null
        ? null : Math.max(0, Math.min(5000, Math.round(num(p.drops_small, 0))));
      const dropsLarge = p.drops_large === undefined || p.drops_large === null
        ? null : Math.max(0, Math.min(500, Math.round(num(p.drops_large, 0))));
      const runnels = Math.max(0, Math.min(50, Math.round(num(p.runnels, 8))));
      const smallLit = dropsSmall === null ? 'None' : String(dropsSmall);
      const largeLit = dropsLarge === null ? 'None' : String(dropsLarge);
      return prelude(target) + `
import bmesh, random
from mathutils import Vector, Matrix
random.seed(42)
# Lateral bbox area of the target; a 330 ml can is ~0.024 m2.
_area = 2 * (_size[0] + _size[1]) * _size[2]
_factor = max(0.2, min(3.0, _area / 0.024))
_n_small = ${smallLit} if ${smallLit} is not None else max(100, min(2500, round(1200 * _factor)))
_n_large = ${largeLit} if ${largeLit} is not None else max(10, min(150, round(80 * _factor)))
# 'wide' density: halve the small drops and drop the sub-mm size class.
_r_small = (0.001, 0.0015) if '${density}' == 'wide' else (0.00025, 0.00075)
if '${density}' == 'wide':
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
for _i in range(${runnels}):
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
print(f"DETAIL_OK condensation small={_n_small} large={_n_large} on {_target.name}")
`;
    }
    case 'emissive_ring': {
      const axisName = String(p.axis ?? 'z').toLowerCase();
      if (axisName !== 'x' && axisName !== 'y' && axisName !== 'z') {
        throw new Error(`emissive_ring axis must be 'x', 'y' or 'z', got '${axisName}'.`);
      }
      const axis = { x: 0, y: 1, z: 2 }[axisName] as 0 | 1 | 2;
      const scale = num(p.radius_scale, 1.0);
      const tube = num(p.tube_m, 0.002);
      const color = parseColor(p.color, [0.0, 0.85, 1.0]);
      const strength = num(p.strength, 3.0);
      if (tube <= 0 || tube > 0.02) throw new Error('emissive_ring tube_m must be > 0 and <= 0.02 m.');
      if (!(strength > 0 && strength <= 10)) {
        throw new Error('emissive_ring strength must be > 0 and <= 10 (research: never > 10 on a large area).');
      }
      const rot = axis === 2 ? '(0, 0, 0)' : axis === 1 ? '(0, 0, math.pi / 2)' : '(0, math.pi / 2, 0)';
      const scaleTuple = axis === 2
        ? '_size[0] / 2, _size[1] / 2, 1'
        : axis === 1 ? '_size[0] / 2, _size[2] / 2, 1' : '_size[2] / 2, _size[1] / 2, 1';
      return prelude(target) + `
import math
bpy.ops.mesh.primitive_torus_add(location=_centre, major_radius=1.0, minor_radius=${pyNum(tube)})
_ring = bpy.context.active_object
_ring.name = _target.name + "_EmissiveRing"
_ring.rotation_euler = ${rot}
_sx, _sy, _sz = ${scaleTuple}
_ring.scale = (_sx * ${pyNum(scale)}, _sy * ${pyNum(scale)}, _sz * ${pyNum(scale)})
_ring_mat = bpy.data.materials.new(name="EmissiveRing")
_ring_mat.use_nodes = True
_rb = _ring_mat.node_tree.nodes["Principled BSDF"]
_rb.inputs["Base Color"].default_value = (0.01, 0.01, 0.01, 1)
_rb.inputs["Emission Color"].default_value = ${rgbaStr(color)}
_rb.inputs["Emission Strength"].default_value = ${pyNum(strength)}
_ring.data.materials.append(_ring_mat)
print(f"DETAIL_OK emissive_ring axis=${axisName} strength=${pyNum(strength)} on {_target.name}")
`;
    }
    case 'glow_strip': {
      const face = String(p.face ?? 'front');
      const width = num(p.width_m, 0.005);
      const length = num(p.length_m, 0);
      const color = parseColor(p.color, [0.0, 0.85, 1.0]);
      const strength = num(p.strength, 5.0);
      if (width <= 0 || width > 0.05) throw new Error('glow_strip width_m must be > 0 and <= 0.05 m.');
      if (!(strength > 0 && strength <= 10)) {
        throw new Error('glow_strip strength must be > 0 and <= 10 (research: never > 10 on a large area).');
      }
      const { axis } = faceInfo(face);
      const lenExpr = length ? pyNum(length) : axis === 2 ? '_size[0] * 0.8' : '_size[2] * 0.8';
      const dims = axis === 0
        ? `(${lenExpr}, ${pyNum(width)}, 0.002)`
        : axis === 1 ? `(${pyNum(width)}, ${lenExpr}, 0.002)` : `(${lenExpr}, ${pyNum(width)}, 0.002)`;
      return prelude(target) + `
_strip_loc = ${facePoint(face, 0, 0, 0.001)}
bpy.ops.mesh.primitive_cube_add(location=_strip_loc)
_strip = bpy.context.active_object
_strip.name = _target.name + "_GlowStrip"
_strip.dimensions = ${dims}
_strip.rotation_euler = ${faceRotation(face)}
_strip_mat = bpy.data.materials.new(name="GlowStrip")
_strip_mat.use_nodes = True
_sb = _strip_mat.node_tree.nodes["Principled BSDF"]
_sb.inputs["Base Color"].default_value = (0.01, 0.01, 0.01, 1)
_sb.inputs["Emission Color"].default_value = ${rgbaStr(color)}
_sb.inputs["Emission Strength"].default_value = ${pyNum(strength)}
_strip.data.materials.append(_strip_mat)
print(f"DETAIL_OK glow_strip face=${face} strength=${pyNum(strength)} on {_target.name}")
`;
    }
  }
}
