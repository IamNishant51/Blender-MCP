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
export declare const WORK_AREA_HALF = 5;
export declare const WORK_AREA_HEIGHT = 10;
export declare const ATTACH_TOLERANCE = 0.05;
export declare const KINDS: readonly ["cube", "sphere", "cylinder", "cone", "torus"];
export type SpecKind = (typeof KINDS)[number];
export interface SpecObject {
    name: string;
    kind: SpecKind;
    size_m: [number, number, number];
    position_m: [number, number, number];
    rotation_deg?: [number, number, number];
    material?: string;
    attach?: string;
}
export interface SceneSpec {
    objects: SpecObject[];
}
export declare const MATE_HELPERS = "\n# --- mate helpers (placement solved from bounding boxes) ---\ndef _bbox_bottom_centre(obj):\n    lo, hi = _bounds_of([obj])\n    return ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2])\n\ndef _bbox_centre(obj):\n    lo, hi = _bounds_of([obj])\n    return ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)\n\ndef _bbox_top(obj):\n    return _bounds_of([obj])[1][2]\n\ndef grounded(size):\n    \"\"\"Bottom z of an object standing on the ground (z = 0).\"\"\"\n    return 0.0\n\ndef on_top_of(parent, size):\n    \"\"\"Bottom-centre of an object sitting on top of 'parent'.\"\"\"\n    cx, cy, _ = _bbox_centre(parent)\n    return (cx, cy, _bbox_top(parent))\n\ndef centred_on(parent, size):\n    \"\"\"Bottom-centre of an object centred horizontally on 'parent'.\"\"\"\n    cx, cy, _ = _bbox_centre(parent)\n    return (cx, cy, None)  # z comes from position_m\n";
type Bounds = {
    lo: [number, number, number];
    hi: [number, number, number];
};
/** (min, max) world-space AABB of one spec object. position_m is the bottom-centre. */
export declare function objectBounds(obj: SpecObject): Bounds;
/** Accept a spec object or a JSON string; returns [spec, error]. */
export declare function parseSpec(spec: unknown): [SceneSpec | null, string | null];
/**
 * Validate a scene spec. Returns the list of failed checks
 * (empty list = valid). Each entry names the object and the exact check.
 */
export declare function validateSpec(spec: unknown): string[];
export interface BuildFromSpecResult {
    script: string | null;
    errors: string[];
}
/**
 * Generate bpy for a validated spec. Returns {script, errors}: on
 * validation failure `script` is null and `errors` lists the exact failed
 * checks. One primitive per object, dimensions from size_m, centre computed
 * as bottom-centre + half height, rotation applied, material from the
 * material library.
 */
export declare function buildFromSpec(spec: unknown): BuildFromSpecResult;
export {};
//# sourceMappingURL=spec.d.ts.map