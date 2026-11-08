/**
 * Structured scene spec (Blender-MCP 1.2.0) — research-first pipeline.
 *
 * The LLM first produces a small JSON spec instead of guessing coordinates
 * inside template code:
 *
 *   {objects: [{name: "Seat", kind: "cube",
 *               size_m: [0.45, 0.45, 0.10],
 *               position_m: [0.45, 0, 0.52],
 *               material: "fabric",
 *               attach: "on_top_of:Floor"}]}
 *
 * Conventions (Procedura / SceneCraft pattern):
 * - `position_m` is the BOTTOM-CENTRE of the object (origin at bottom
 *   centre), sizes are in metres, Z is up, ground is z = 0.
 * - `kind` is one of cube / sphere / cylinder / cone / torus.
 * - `attach` is a mate: `grounded`, `on_top_of:<name>` or
 *   `centred_on:<name>`. Placement is solved from the parent's bounding
 *   box by the mate helpers emitted into the generated code — never guessed.
 *
 * Validation (all failures are returned with the exact failed check):
 * - every size component > 0
 * - every position.z >= 0
 * - bounding boxes inside a 10 m work area (|x|, |y| <= 5, z <= 10)
 * - objects declaring `attach` must reference an existing object, and for
 *   `on_top_of` the child's bottom must touch the parent's top within
 *   0.05 m tolerance
 */
import { getMaterialScript } from './model.js';
import { DIMENSION_SOURCES, specMatchesLibrary } from './grounding.js';
export const WORK_AREA_HALF = 5.0; // |x|, |y| <= 5 m
export const WORK_AREA_HEIGHT = 10.0; // z <= 10 m
export const ATTACH_TOLERANCE = 0.05; // m
export const CONTACT_TOLERANCE = 0.01; // m — a part must touch the ground or another part
export const KINDS = ['cube', 'sphere', 'cylinder', 'cone', 'torus'];
// Mate helpers emitted into every generated script. Placement is solved
// from the parent's bounding box at build time, never from guessed
// coordinates.
export const MATE_HELPERS = `
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
    """Bottom-centre of an object sitting on top of 'parent'."""
    cx, cy, _ = _bbox_centre(parent)
    return (cx, cy, _bbox_top(parent))

def centred_on(parent, size):
    """Bottom-centre of an object centred horizontally on 'parent'."""
    cx, cy, _ = _bbox_centre(parent)
    return (cx, cy, None)  # z comes from position_m
`;
function rotatedCorners(size, rotationDeg) {
    const [rx, ry, rz] = rotationDeg.map((a) => (a * Math.PI) / 180);
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // R = Rz @ Ry @ Rx
    const r = [
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy, cy * sx, cy * cx],
    ];
    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    const corners = [];
    for (const x of [-hx, hx]) {
        for (const y of [-hy, hy]) {
            for (const z of [-hz, hz]) {
                corners.push([
                    r[0][0] * x + r[0][1] * y + r[0][2] * z,
                    r[1][0] * x + r[1][1] * y + r[1][2] * z,
                    r[2][0] * x + r[2][1] * y + r[2][2] * z,
                ]);
            }
        }
    }
    return corners;
}
/** (min, max) world-space AABB of one spec object. position_m is the bottom-centre. */
export function objectBounds(obj) {
    const size = obj.size_m;
    const pos = obj.position_m;
    const rot = obj.rotation_deg ?? [0, 0, 0];
    const corners = rotatedCorners(size, rot);
    // The rotated AABB height is independent of position: for a rotated
    // object the world height is the rotated height, not size[2] (a box
    // rotated 35 deg about X is taller than size[2]). The centre is the
    // bottom-centre plus half that rotated height, so validation and the
    // generated code agree on where the object actually sits.
    const rotHeight = Math.max(...corners.map((c) => c[2])) - Math.min(...corners.map((c) => c[2]));
    const centre = [pos[0], pos[1], pos[2] + rotHeight / 2];
    const xs = corners.map((c) => centre[0] + c[0]);
    const ys = corners.map((c) => centre[1] + c[1]);
    const zs = corners.map((c) => centre[2] + c[2]);
    return {
        lo: [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
        hi: [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
    };
}
/** Accept a spec object or a JSON string; returns [spec, error]. */
export function parseSpec(spec) {
    if (typeof spec === 'string') {
        try {
            spec = JSON.parse(spec);
        }
        catch (e) {
            return [null, `spec is not valid JSON: ${e instanceof Error ? e.message : String(e)}`];
        }
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
        return [null, "spec must be a JSON object with an 'objects' list"];
    }
    return [spec, null];
}
function isVec3(v) {
    return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
}
/**
 * Validate a scene spec. Returns the list of failed checks
 * (empty list = valid). Each entry names the object and the exact check.
 */
export function validateSpec(spec) {
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
        return ["spec must be a JSON object with an 'objects' list"];
    }
    const objects = spec.objects;
    if (!Array.isArray(objects) || objects.length === 0) {
        return ['spec.objects must be a non-empty list'];
    }
    const errors = [];
    const byName = new Map();
    const specDefaultSource = spec.dimension_source;
    for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        const label = obj?.name ?? `objects[${i}]`;
        if (typeof obj !== 'object' || obj === null) {
            errors.push(`${label}: object must be a JSON object`);
            continue;
        }
        if (!obj.name) {
            errors.push(`objects[${i}]: missing 'name'`);
            continue;
        }
        byName.set(obj.name, obj);
        if (!KINDS.includes(obj.kind)) {
            errors.push(`${obj.name}: kind ${JSON.stringify(obj.kind)} is not one of ${KINDS.join(', ')}`);
        }
        if (!isVec3(obj.size_m)) {
            errors.push(`${obj.name}: size_m must be [x, y, z] numbers`);
            continue;
        }
        ['x', 'y', 'z'].forEach((axis, idx) => {
            if (!Number.isFinite(obj.size_m[idx])) {
                errors.push(`${obj.name}: size_m.${axis} must be a finite number, got ${obj.size_m[idx]}`);
            }
            else if (!(obj.size_m[idx] > 0)) {
                errors.push(`${obj.name}: size_m.${axis} must be > 0, got ${obj.size_m[idx]}`);
            }
        });
        if (obj.size_m.every((v) => v === 1)) {
            errors.push(`${obj.name}: size_m ${JSON.stringify(obj.size_m)} is the [1, 1, 1] unit placeholder — replace it with real dimensions from research, the dimension library (get_dimensions) or a measurement, and state the source`);
        }
        if (!isVec3(obj.position_m)) {
            errors.push(`${obj.name}: position_m must be [x, y, z] numbers`);
            continue;
        }
        ['x', 'y', 'z'].forEach((axis, idx) => {
            if (!Number.isFinite(obj.position_m[idx])) {
                errors.push(`${obj.name}: position_m.${axis} must be a finite number, got ${obj.position_m[idx]}`);
            }
        });
        if (obj.position_m[2] < 0) {
            errors.push(`${obj.name}: position_m.z must be >= 0 (ground), got ${obj.position_m[2]}`);
        }
        // Every part needs a stated dimension source — a number with no
        // provenance is an invented number.
        const source = obj.dimension_source ?? specDefaultSource;
        if (!source) {
            errors.push(`${obj.name}: missing 'dimension_source' — state where the dimensions came from: ${DIMENSION_SOURCES.join(', ')}`);
        }
        else if (!DIMENSION_SOURCES.includes(source)) {
            errors.push(`${obj.name}: dimension_source ${JSON.stringify(source)} is not one of ${DIMENSION_SOURCES.join(', ')}`);
        }
        // Every part needs a material — an unmaterialed part renders flat grey.
        if (!obj.material) {
            errors.push(`${obj.name}: missing 'material' — every part must name a material (wood, metal, glass, fabric, steel, ...)`);
        }
        if (obj.rotation_deg !== undefined && (!isVec3(obj.rotation_deg) || !obj.rotation_deg.every((v) => Number.isFinite(v)))) {
            errors.push(`${obj.name}: rotation_deg must be [x, y, z] finite numbers`);
            continue;
        }
        const { lo, hi } = objectBounds(obj);
        if (lo[0] < -WORK_AREA_HALF || hi[0] > WORK_AREA_HALF) {
            errors.push(`${obj.name}: bounding box x [${lo[0].toFixed(2)}, ${hi[0].toFixed(2)}] outside work area |x| <= ${WORK_AREA_HALF}`);
        }
        if (lo[1] < -WORK_AREA_HALF || hi[1] > WORK_AREA_HALF) {
            errors.push(`${obj.name}: bounding box y [${lo[1].toFixed(2)}, ${hi[1].toFixed(2)}] outside work area |y| <= ${WORK_AREA_HALF}`);
        }
        if (lo[2] < 0 || hi[2] > WORK_AREA_HEIGHT) {
            errors.push(`${obj.name}: bounding box z [${lo[2].toFixed(2)}, ${hi[2].toFixed(2)}] outside work area 0 <= z <= ${WORK_AREA_HEIGHT}`);
        }
    }
    // Attach / mate checks (needs the full name table).
    for (const obj of objects) {
        if (typeof obj !== 'object' || obj === null || !obj.name)
            continue;
        const attach = obj.attach;
        if (!attach)
            continue;
        if (attach === 'grounded') {
            if (isVec3(obj.position_m) && obj.position_m[2] !== 0) {
                errors.push(`${obj.name}: attach 'grounded' requires position_m.z == 0, got ${obj.position_m[2]}`);
            }
            continue;
        }
        let handled = false;
        for (const prefix of ['on_top_of:', 'centred_on:']) {
            if (typeof attach === 'string' && attach.startsWith(prefix)) {
                handled = true;
                const parentName = attach.slice(prefix.length);
                const parent = byName.get(parentName);
                if (!parent) {
                    errors.push(`${obj.name}: attach ${JSON.stringify(attach)} names unknown object ${JSON.stringify(parentName)}`);
                    break;
                }
                if (prefix === 'on_top_of:') {
                    const parentBounds = objectBounds(parent);
                    const childBounds = objectBounds(obj);
                    const gap = Math.abs(childBounds.lo[2] - parentBounds.hi[2]);
                    if (gap > ATTACH_TOLERANCE + 1e-9) {
                        errors.push(`${obj.name}: attach 'on_top_of:${parentName}' does not touch: child bottom z = ${childBounds.lo[2].toFixed(3)}, parent top z = ${parentBounds.hi[2].toFixed(3)} (gap ${gap.toFixed(3)} m > ${ATTACH_TOLERANCE} m)`);
                    }
                    const overlapX = Math.min(childBounds.hi[0], parentBounds.hi[0]) - Math.max(childBounds.lo[0], parentBounds.lo[0]);
                    const overlapY = Math.min(childBounds.hi[1], parentBounds.hi[1]) - Math.max(childBounds.lo[1], parentBounds.lo[1]);
                    if (overlapX <= 0 || overlapY <= 0) {
                        errors.push(`${obj.name}: attach 'on_top_of:${parentName}' has no horizontal overlap with the parent footprint`);
                    }
                }
                break;
            }
        }
        if (!handled && typeof attach === 'string') {
            errors.push(`${obj.name}: attach ${JSON.stringify(attach)} is not 'grounded', 'on_top_of:<name>' or 'centred_on:<name>'`);
        }
    }
    // Floating check: a part with no mate (or a centred_on mate, whose z
    // still comes from position_m) must sit on the ground or touch
    // another part's bounding box. A part that touches nothing is floating
    // and is rejected — the failure VLMs miss most often.
    const boundsMap = new Map();
    for (const obj of objects) {
        if (typeof obj === 'object' && obj !== null && obj.name) {
            try {
                boundsMap.set(obj.name, objectBounds(obj));
            }
            catch {
                // bounds errors are reported by the per-object checks above
            }
        }
    }
    for (const obj of objects) {
        if (typeof obj !== 'object' || obj === null || !obj.name)
            continue;
        const attach = obj.attach ?? '';
        if (attach === 'grounded' || (typeof attach === 'string' && attach.startsWith('on_top_of:')))
            continue;
        const own = boundsMap.get(obj.name);
        if (!own)
            continue;
        if (own.lo[2] <= CONTACT_TOLERANCE)
            continue; // grounded
        let touches = false;
        for (const [otherName, other] of boundsMap) {
            if (otherName === obj.name)
                continue;
            const overlap = [0, 1, 2].map((i) => Math.min(own.hi[i], other.hi[i]) - Math.max(own.lo[i], other.lo[i]));
            if (overlap.every((v) => v >= -CONTACT_TOLERANCE)) {
                touches = true;
                break;
            }
        }
        if (!touches) {
            errors.push(`${obj.name}: FLOATING — bottom z = ${own.lo[2].toFixed(3)} m, touches nothing and is not on the ground. Give it an attach mate (grounded / on_top_of:<name>) or move it so it touches another part`);
        }
    }
    // Library cross-check: 'library' claims must match the real numbers.
    errors.push(...specMatchesLibrary(spec));
    return errors;
}
/**
 * Generate bpy for a validated spec. Returns {script, errors}: on
 * validation failure `script` is null and `errors` lists the exact failed
 * checks. One primitive per object, dimensions from size_m, centre computed
 * as bottom-centre + half height, rotation applied, material from the
 * material library.
 */
export function buildFromSpec(spec) {
    const [parsed, parseError] = parseSpec(spec);
    if (parseError)
        return { script: null, errors: [parseError] };
    const errors = validateSpec(parsed);
    if (errors.length > 0)
        return { script: null, errors };
    const lines = [`
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
`, MATE_HELPERS, '\ncreated = {}\n'];
    for (const obj of parsed.objects) {
        const name = obj.name;
        const kind = obj.kind;
        const size = obj.size_m.map(Number);
        const pos = obj.position_m.map(Number);
        const rot = (obj.rotation_deg ?? [0, 0, 0]).map(Number);
        const attach = obj.attach ?? '';
        // Placement: mates solve the bottom-centre from the parent's
        // bounding box; otherwise position_m is used as given.
        let place;
        if (attach === 'grounded') {
            place = `(${pos[0]}, ${pos[1]}, grounded(${JSON.stringify(size)}))`;
        }
        else if (attach.startsWith('on_top_of:')) {
            const parent = attach.slice('on_top_of:'.length);
            place = `on_top_of(created[${JSON.stringify(parent)}], ${JSON.stringify(size)})`;
        }
        else if (attach.startsWith('centred_on:')) {
            const parent = attach.slice('centred_on:'.length);
            place = `centred_on(created[${JSON.stringify(parent)}], ${JSON.stringify(size)})[:2] + (${pos[2]},)`;
        }
        else {
            place = `(${pos[0]}, ${pos[1]}, ${pos[2]})`;
        }
        const _hb = objectBounds(obj);
        const _rotH = _hb.hi[2] - _hb.lo[2];
        lines.push(`\n# ${name} (${kind}, size ${JSON.stringify(size)}, bottom-centre from mate/position)`);
        lines.push(`_bottom = ${place}`);
        // Centre from the ROTATED AABB height: for rotated objects the world
        // height is the rotated height, not size[2] (a cylinder rotated 90
        // degrees about Y is size[0] tall, not size[2]).
        lines.push(`_centre = (_bottom[0], _bottom[1], _bottom[2] + ${(_rotH / 2).toFixed(4)})`);
        if (kind === 'cube') {
            lines.push(`bpy.ops.mesh.primitive_cube_add(location=_centre)\n_obj = bpy.context.active_object\n_obj.scale = (${size[0] / 2}, ${size[1] / 2}, ${size[2] / 2})`);
        }
        else if (kind === 'sphere') {
            lines.push(`bpy.ops.mesh.primitive_uv_sphere_add(location=_centre, radius=0.5)\n_obj = bpy.context.active_object\n_obj.scale = (${size[0]}, ${size[1]}, ${size[2]})`);
        }
        else if (kind === 'cylinder') {
            lines.push(`bpy.ops.mesh.primitive_cylinder_add(location=_centre, radius=0.5, depth=1.0)\n_obj = bpy.context.active_object\n_obj.scale = (${size[0]}, ${size[1]}, ${size[2]})`);
        }
        else if (kind === 'cone') {
            lines.push(`bpy.ops.mesh.primitive_cone_add(location=_centre, radius1=0.5, radius2=0.0, depth=1.0)\n_obj = bpy.context.active_object\n_obj.scale = (${size[0]}, ${size[1]}, ${size[2]})`);
        }
        else if (kind === 'torus') {
            // Base torus: outer diameter 1.0, tube height 0.25.
            lines.push(`bpy.ops.mesh.primitive_torus_add(location=_centre, major_radius=0.375, minor_radius=0.125)\n_obj = bpy.context.active_object\n_obj.scale = (${size[0]}, ${size[1]}, ${size[2] / 0.25})`);
        }
        // Curved primitives are flat-shaded by default, which reads as faceted
        // "disco ball" segments under studio light (v1.3.0 demo sneaker
        // toe/heel). Smooth-shade them so they read as moulded parts. Cubes
        // stay flat-shaded for crisp edges.
        if (kind !== 'cube') {
            lines.push(`for _p in _obj.data.polygons: _p.use_smooth = True`);
        }
        if (rot.some((r) => r !== 0)) {
            lines.push(`_obj.rotation_euler = (math.radians(${rot[0]}), math.radians(${rot[1]}), math.radians(${rot[2]}))`);
        }
        lines.push(`_obj.name = ${JSON.stringify(name)}`);
        lines.push(`created[${JSON.stringify(name)}] = _obj`);
        if (obj.material) {
            lines.push(getMaterialScript(String(obj.material)));
            lines.push('_obj.data.materials.append(mat)');
        }
    }
    lines.push('\nprint("Built scene from spec: " + str(list(created.keys())))');
    return { script: lines.join('\n'), errors: [] };
}
//# sourceMappingURL=spec.js.map