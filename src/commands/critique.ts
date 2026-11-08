/**
 * Vision critique loop (Blender-MCP 1.3.0) — `critique_model` support.
 *
 * Honest design, per notes/vlm-critique.md (LL3M + BlenderAlchemy +
 * VLM3D + BlenderWorld): the MCP itself does NOT see images. The actual
 * seeing is done by the calling model. The MCP's job is to (1) render the
 * views, (2) run programmatic checks that need no eyes (PNG exists and
 * decodes, min z >= 0, parts present, parts connected/grounded, dimensions
 * vs spec), and (3) return the rendered views plus a structured critique
 * prompt template the calling model uses — per-spec-item pass/fail plus
 * problem -> fix pairs phrased as concrete operations on named parts.
 *
 * Loop shape (recommendation from the notes, not a literature value):
 * max 3 auto-refine rounds, breadth 1 candidate per round, alternate
 * tweak rounds (numeric params) and leap rounds (structural changes),
 * geometry -> materials -> lighting passes in that order, keep-best +
 * revert if a round makes things worse. The verifier is a second pass by
 * the calling model over new renders + old renders + the critique list.
 */

export const MAX_REFINE_ROUNDS = 3;

export interface SpecItem {
  name: string;
  size_m?: [number, number, number];
  material?: string;
}

export interface CritiqueCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface CritiqueResult {
  success: boolean;
  checks: CritiqueCheck[];
  passed: boolean;
  renders?: Array<{ view: string; path: string; size_bytes: number }>;
  critique_prompt: string;
  refine_round?: number;
  max_rounds: number;
  note: string;
}

/**
 * Blender script that runs the programmatic checks inside Blender and
 * prints a CRITIQUE_JSON line: per-object min z, per-object size vs the
 * spec (when sizes are given), and a connectivity check — every mesh must
 * either sit on the ground (min z ~ 0) or touch/overlap another mesh's
 * bounding box within 0.01 m, otherwise it is floating/disconnected.
 * `specJson` is the JSON scene spec (objects with name + optional size_m).
 */
export function buildCritiqueScript(specJson: string): string {
  return `
import bpy, json
from mathutils import Vector

_spec = json.loads(${JSON.stringify(specJson)})
_expected = {o.get("name"): o for o in _spec.get("objects", []) if o.get("name")}

bpy.context.view_layer.update()
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
checks = []

def _bounds(o):
    corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return lo, hi

_bounds_map = {}
for o in meshes:
    lo, hi = _bounds(o)
    _bounds_map[o.name] = (lo, hi)

# 1. Every expected spec part is present as an object.
for name in _expected:
    found = any(name in o.name for o in meshes)
    checks.append({"check": f"part_present:{name}", "passed": found,
                   "detail": "present" if found else f"missing: no object named {name}"})

# 2. Nothing below the ground; nothing degenerate (zero-volume bbox).
for o in meshes:
    lo, hi = _bounds_map[o.name]
    checks.append({"check": f"min_z:{o.name}", "passed": lo.z >= -0.001,
                   "detail": f"min z = {lo.z:.4f} m"})
    vol = (hi.x - lo.x) * (hi.y - lo.y) * (hi.z - lo.z)
    checks.append({"check": f"non_degenerate:{o.name}", "passed": vol > 1e-9,
                   "detail": f"bbox volume = {vol:.6f} m^3"})

# 3. Dimensions vs spec (when the spec gives sizes), within 10%.
for name, item in _expected.items():
    size = item.get("size_m")
    if not size:
        continue
    match = next((o for o in meshes if name in o.name), None)
    if not match:
        continue
    lo, hi = _bounds_map[match.name]
    actual = (hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
    # Compare SORTED dimensions: a part rotated 90 deg about an axis
    # (e.g. a crown cylinder rotated to face sideways) permutes its bbox
    # axes, so a per-axis comparison false-positives on a correct part.
    actual_s = sorted(actual)
    size_s = sorted(size)
    ok = all(abs(actual_s[i] - size_s[i]) / max(size_s[i], 1e-6) < 0.10 for i in range(3))
    checks.append({"check": f"dimensions:{name}", "passed": ok,
                   "detail": f"spec={size} actual={[round(v, 3) for v in actual]} (sorted compare)"})

# 4. Connectivity / grounding: each part must touch the ground or touch
#    another part's bounding box (within 0.01 m). A part that touches
#    nothing is floating or disconnected — the failure VLMs miss most.
def _touches(a_lo, a_hi, b_lo, b_hi, tol=0.01):
    overlap = [min(a_hi[i], b_hi[i]) - max(a_lo[i], b_lo[i]) for i in range(3)]
    return all(v >= -tol for v in overlap)

names = list(_bounds_map)
for i, name in enumerate(names):
    lo, hi = _bounds_map[name]
    grounded = lo.z <= 0.001
    connected = grounded
    if not connected:
        for j, other in enumerate(names):
            if i == j:
                continue
            o_lo, o_hi = _bounds_map[other]
            if _touches(lo, hi, o_lo, o_hi):
                connected = True
                break
    checks.append({"check": f"connected:{name}", "passed": connected,
                   "detail": "grounded" if grounded else ("touches another part" if connected else "FLOATING / DISCONNECTED: touches nothing and is not on the ground")})

print("CRITIQUE_JSON:" + json.dumps({"checks": checks}))
`;
}

export function parseCritiqueJson(stdout: string): { checks: CritiqueCheck[] } | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('CRITIQUE_JSON:')) {
      try {
        return JSON.parse(line.slice('CRITIQUE_JSON:'.length));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The structured critique prompt template. The calling model fills it in
 * by LOOKING at the rendered views (the MCP cannot see). It enforces the
 * order from the research: content match -> connectivity/grounding ->
 * proportions/silhouette -> spatial relations -> materials/colour ->
 * lighting -> detail/completeness, then the VLM3D dual Yes/No gate.
 */
export const CRITIQUE_PROMPT_TEMPLATE = `You are the visual critic for this 3D model. You CAN see the rendered views listed below — look at every one of them (front 3/4, side, back, top, close-up) before answering. The MCP that rendered them cannot see; you are the eyes.

SPEC (the contract — critique against this, never against vibes):
{spec_json}

PROGRAMMATIC CHECKS (already run by the MCP — these need no eyes):
{checks_text}

Answer in this exact structure:

1. PER-SPEC-ITEM PASS/FAIL — one line per spec part: PASS or FAIL + one concrete reason.
2. CHECKS IN ORDER:
   a. Content match — is every spec part present, nothing major missing or extra?
   b. Connectivity / grounding — every part attached to what it should attach to? Nothing floating, nothing intersecting unintentionally? (Trust the programmatic connected:* checks above for this; a VLM misses disconnected parts.)
   c. Proportions / silhouette — part-to-part ratios vs the spec; overall height:width:depth; is the silhouette recognisable from the front 3/4 view? Check from at least two views.
   d. Spatial relations — above/below/inside/aligned, per the spec; no Janus faces, no part that exists from one angle and vanishes from another.
   e. Materials / colour — base colour vs the spec palette, roughness/metallic plausibility, texture presence vs flat grey. Judge on the close-up view.
   f. Lighting / readability — is the object legible (not crushed black / blown out)? Do shadows ground it?
   g. Detail / completeness — missing small parts (handles, feet, rims, screws, seams)? Blank surfaces that should carry detail?
3. PROBLEM -> FIX PAIRS — for each FAIL, one pair phrased as a concrete operation on a named part, in the form: "<part>: <difference> -> <concrete edit, e.g. move up 0.02 m on Z / scale down 0.8x on X/Y / raise roughness to 0.6>". Never write "make it better" — name the part, the axis, the direction and the magnitude.
4. HOLISTIC SCORES 0-10 — scene fidelity, physical plausibility, style and colour, realism, spatial layout, proportion and scale, lighting and materials, completeness.
5. DUAL GATE — answer Yes or No to both: (1) Content Match: does the object correspond to the spec? (2) Geometric Quality: is it geometrically sound and consistent across all views? Both must be Yes to accept the build.

FIX RULES for the next round: apply fixes as LOCALISED EDITS to the existing build (add_detail / execute_blender_code edits to the same script), never a rebuild from scratch. Geometry/connectivity first — do not critique texture on a floating part. One candidate per round; max {max_rounds} auto-refine rounds; keep the best render + code so far and REVERT if a round makes things worse. After the fix, re-render the same views and verify per fix: applied / not applied / regressed.
`;

export function buildCritiquePrompt(spec: unknown, checks: CritiqueCheck[], maxRounds: number = MAX_REFINE_ROUNDS): string {
  const checksText = checks.length > 0
    ? checks.map((c) => `- [${c.passed ? 'PASS' : 'FAIL'}] ${c.check}: ${c.detail}`).join('\n')
    : '(no programmatic checks were run)';
  return CRITIQUE_PROMPT_TEMPLATE
    .replace('{spec_json}', JSON.stringify(spec, null, 2))
    .replace('{checks_text}', checksText)
    .replace('{max_rounds}', String(maxRounds));
}

/** The honest note attached to every critique result. */
export const CRITIQUE_NOTE =
  'The MCP rendered the views and ran the programmatic checks above. It cannot see images. ' +
  'The visual judgement (per-spec pass/fail, problem->fix pairs, scores, dual gate) is done by YOU, ' +
  'the calling model, by looking at the rendered PNGs. Apply fixes as localised edits, re-render, ' +
  'and keep the best version; max 3 auto-refine rounds.';
