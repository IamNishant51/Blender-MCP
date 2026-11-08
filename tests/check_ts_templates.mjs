// Checks the TypeScript templates with the same numeric expectations as the
// Python tests (tests/test_geometry.py), by running each generated script
// through the Python geometry checker (tests/geometry.py). Run via `npm test`
// (which builds first), or directly:  node tests/check_ts_templates.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateModelScript, matchTemplate } from '../dist/commands/generators.js';
import { buildImportScript, IMPORT_OPERATORS } from '../dist/commands/import.js';
import { validateSpec, buildFromSpec } from '../dist/commands/spec.js';
import { getMaterialScript, pickPolyhavenMaps } from '../dist/commands/model.js';
import { buildRenderScript, RENDER_VIEWS } from '../dist/commands/render.js';
import {
  buildMeshyTextRequest,
  buildMeshyRefineRequest,
  buildMeshyImageRequest,
  buildTripoTextRequest,
  buildTripoImageRequest,
  isMeshyTerminal,
  isTripoTerminal,
  extractMeshyGlb,
  extractTripoGlb,
} from '../dist/commands/generate.js';
import { getDetailScript, DETAIL_KINDS } from '../dist/commands/details.js';
import {
  buildCritiqueScript,
  parseCritiqueJson,
  buildCritiquePrompt,
  MAX_REFINE_ROUNDS,
} from '../dist/commands/critique.js';
import { getProductScript, getRetrievedProductScript, PRODUCTS } from '../dist/commands/products.js';
import {
  searchPolyhavenCatalogue,
  pickPolyhavenGltfPackage,
  polyPizzaSearchStatus,
  KNOWN_GOOD_ASSETS,
} from '../dist/commands/retrieve.js';
import {
  DIMENSION_LIBRARY,
  checkGrounding,
  getDimensions,
  mintGrounding,
  buildVerifyScript,
  parseVerifyJson,
  verifyBuildReport,
  specMatchesLibrary,
} from '../dist/commands/grounding.js';

const here = dirname(fileURLToPath(import.meta.url));
const python = process.env.PYTHON || 'python3';
let failures = 0;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function approx(actual, expected, tol = 0.01) {
  return Math.abs(actual - expected) <= tol;
}

/** Run a generated Blender script through the fake-bpy geometry checker. */
function boundsFor(script) {
  const dir = mkdtempSync(join(tmpdir(), 'blender-mcp-'));
  const file = join(dir, 'script.py');
  writeFileSync(file, script);
  const out = execFileSync(python, [join(here, 'geometry.py'), file], { encoding: 'utf8' });
  return JSON.parse(out);
}

function byName(result) {
  return Object.fromEntries(result.objects.map((o) => [o.name, o]));
}

function assertOnGround(name, result) {
  for (const o of result.objects) {
    check(`${name}: ${o.name} min z >= 0`, o.min[2] >= -0.001, `min z = ${o.min[2]}`);
  }
}

// --- temple ---
console.log('temple');
{
  const r = boundsFor(generateModelScript('indian temple', ''));
  check('temple: at least 10 objects', r.objects.length >= 10, `got ${r.objects.length}`);
  assertOnGround('temple', r);
  const height = r.scene_max[2] - r.scene_min[2];
  const width = r.scene_max[0] - r.scene_min[0];
  check('temple: height 6-8 m', height > 6 && height < 8, `height = ${height}`);
  check('temple: taller than wide (tower up, not sideways)', height > width);
  check('temple: finial above 7 m', r.scene_max[2] > 7, `max z = ${r.scene_max[2]}`);
  const tiers = r.objects.filter((o) => o.name.startsWith('ShikharaTier'));
  check('temple: 5 shikhara tiers', tiers.length === 5, `got ${tiers.length}`);
}

// --- rickshaw (Bajaj RE: 2.66 x 1.30 x 1.70, wheelbase 2.00, 3 wheels, tyre Ø 0.42) ---
console.log('rickshaw');
{
  const r = boundsFor(generateModelScript('auto rickshaw', ''));
  assertOnGround('rickshaw', r);
  const wheels = r.objects.filter((o) => o.name === 'Wheel');
  check('rickshaw: 3 wheels', wheels.length === 3, `got ${wheels.length}`);
  for (const w of wheels) {
    check('rickshaw: wheel touches ground', approx(w.min[2], 0), `min z = ${w.min[2]}`);
    check('rickshaw: tyre diameter 0.42 m', approx(w.max[2] - w.min[2], 0.42, 0.02), `height = ${w.max[2] - w.min[2]}`);
  }
  const length = r.scene_max[0] - r.scene_min[0];
  const height = r.scene_max[2] - r.scene_min[2];
  check('rickshaw: length 2.66 m ±10%', Math.abs(length - 2.66) / 2.66 < 0.1, `length = ${length}`);
  check('rickshaw: height 1.70 m ±10%', Math.abs(height - 1.7) / 1.7 < 0.1, `height = ${height}`);
  const canopy = byName(r).Canopy;
  check('rickshaw: canopy peaks at 1.70 m', approx(canopy.max[2], 1.7, 0.02), `top = ${canopy.max[2]}`);
  check('rickshaw: canopy is a thin sheet, not a dome', canopy.max[2] - canopy.min[2] < 0.2);
  const floor = byName(r).FloorPan;
  check('rickshaw: floor bottom at z = 0.20 (ground clearance)', approx(floor.min[2], 0.2), `min z = ${floor.min[2]}`);
}

// --- thali (plate Ø 0.32, depth 0.022) ---
console.log('thali');
{
  const r = boundsFor(generateModelScript('thali', ''));
  check('thali: 11 objects (plate + rice + 4 katoris + 4 contents + roti)', r.objects.length === 11, `got ${r.objects.length}`);
  assertOnGround('thali', r);
  check('thali: under 0.25 m tall', r.scene_max[2] - r.scene_min[2] < 0.25);
  const plate = byName(r).ThaliPlate;
  check('thali: plate Ø 0.32 m ±10%', Math.abs(plate.max[0] - plate.min[0] - 0.32) / 0.32 < 0.1);
  check('thali: plate top at z = 0.022', approx(plate.max[2], 0.022, 0.002));
  for (const food of ['Dal', 'Sabzi', 'Curd', 'Kheer']) {
    check(`thali: katori + contents ${food}`, byName(r)[`Katori_${food}`] !== undefined && byName(r)[food] !== undefined);
  }
}

// --- haveli (12 x 10 footprint, plinth 0.5, two 3.2 m floors, courtyard void) ---
console.log('haveli');
{
  const r = boundsFor(generateModelScript('haveli palace', ''));
  assertOnGround('haveli', r);
  const n = byName(r);
  check('haveli: no temple spire', !r.objects.some((o) => o.name.startsWith('Shikhara')));
  check('haveli: plinth 12 m long', approx(n.Plinth.max[0] - n.Plinth.min[0], 12.0));
  check('haveli: plinth 10 m deep', approx(n.Plinth.max[1] - n.Plinth.min[1], 10.0));
  check('haveli: ground floor tops at z = 3.7', approx(n.GroundFloor_Front.max[2], 3.7));
  check('haveli: first floor starts at z = 3.7', approx(n.FirstFloor_Front.min[2], 3.7));
  check('haveli: first floor tops at z = 6.9', approx(n.FirstFloor_Front.max[2], 6.9));
  check('haveli: total height 7.9-9.4 m', r.scene_max[2] > 7.9 && r.scene_max[2] < 9.4, `max z = ${r.scene_max[2]}`);
  const blocking = r.objects.filter((o) => o.name !== 'CourtyardPaving'
    && o.min[0] < 0 && o.max[0] > 0 && o.min[1] < 0 && o.max[1] > 0 && o.max[2] > 0.6);
  check('haveli: courtyard void is open to the sky', blocking.length === 0, `blocked by ${blocking.map((o) => o.name).join(', ')}`);
  check('haveli: jharokha projects ~1 m from front face', n['JharokhaSlab_3.0'].min[1] < -5.9);
}

// --- character (H 1.75, 7.5 heads) ---
console.log('character');
{
  const r = boundsFor(generateModelScript('person', ''));
  assertOnGround('character', r);
  const n = byName(r);
  check('character: head above torso above dhoti', n.Head.min[2] > n.Torso.min[2] && n.Torso.min[2] > n.Dhoti.min[2]);
  check('character: head top above z = 1.5', n.Head.max[2] > 1.5, `head top = ${n.Head.max[2]}`);
  check('character: 1.75 m tall ±10%', Math.abs(r.scene_max[2] - 1.75) / 1.75 < 0.1, `max z = ${r.scene_max[2]}`);
  check('character: torso narrower than shoulders', n.Torso.max[0] - n.Torso.min[0] < n.Shoulders.max[0] - n.Shoulders.min[0]);
  const hands = r.objects.filter((o) => o.name === 'Hand');
  check('character: 2 hands, fingertips at z = 0.65 (mid-thigh)', hands.length === 2 && hands.every((h) => approx(h.min[2], 0.65)), `got ${hands.map((h) => h.min[2]).join(', ')}`);
  const feet = r.objects.filter((o) => o.name === 'Foot');
  check('character: feet on the ground', feet.length === 2 && feet.every((f) => approx(f.min[2], 0)));
}

// --- no temple default ---
console.log('no-template default');
{
  check('chair matches no template', matchTemplate('wooden chair') === null);
  check('sports car matches no template', matchTemplate('red sports car') === null);
  check('chair generates empty script', generateModelScript('wooden chair', '') === '');
  check('temple still matches', matchTemplate('indian temple') === 'temple');
  check('rickshaw still matches', matchTemplate('auto rickshaw') === 'rickshaw');
}

// --- import script ---
console.log('import script');
{
  const stl = buildImportScript('/tmp/m.stl', IMPORT_OPERATORS.stl, '/tmp/o.blend', 1.0);
  check('import: STL uses import_mesh.stl', stl.includes('bpy.ops.import_mesh.stl'));
  check('import: STL never uses import_scene.stl', !stl.includes('import_scene.stl'));
  const glb = buildImportScript('/tmp/m.glb', IMPORT_OPERATORS.glb, '/tmp/o.blend', 1.0);
  check('import: GLB uses import_scene.gltf', glb.includes('bpy.ops.import_scene.gltf'));
  // The fake import creates a 4 x 2 x 0.5 m box floating at z = 3;
  // after normalisation it must be 1 m long and on the ground.
  const r = boundsFor(glb);
  const longest = Math.max(r.scene_size[0], r.scene_size[1], r.scene_size[2]);
  check('import: normalised longest side 1.0 m', approx(longest, 1.0), `longest = ${longest}`);
  check('import: normalised min z = 0', approx(r.scene_min[2], 0), `min z = ${r.scene_min[2]}`);
}

// --- scene spec (v1.2.0) ---
console.log('scene spec');
{
  const valid = {
    objects: [
      { name: 'Table', kind: 'cube', size_m: [1.2, 0.8, 0.05], position_m: [0, 0, 0.7], material: 'wood', dimension_source: 'measured' },
      { name: 'Leg', kind: 'cylinder', size_m: [0.08, 0.08, 0.7], position_m: [0, 0, 0], attach: 'grounded', material: 'steel', dimension_source: 'measured' },
      { name: 'Top', kind: 'cube', size_m: [1.2, 0.8, 0.05], position_m: [0, 0, 0.75], attach: 'on_top_of:Table', material: 'wood', dimension_source: 'measured' },
    ],
  };
  check('spec: valid spec passes', validateSpec(valid).length === 0, validateSpec(valid).join('; '));
  const { script, errors } = buildFromSpec(valid);
  check('spec: build returns a script', typeof script === 'string' && script.length > 0, errors.join('; '));
  check('spec: flat caps stay flat-shaded, sides smooth', script.includes('abs(_p.normal.z) < 0.999') && !script.includes('for _p in _obj.data.polygons: _p.use_smooth = True'));
  check('spec: mate helpers emitted', script.includes('def on_top_of') && script.includes('def grounded') && script.includes('def centred_on'));
  const r = boundsFor(script);
  const n = byName(r);
  check('spec: on_top_of places Top on Table at z = 0.75', approx(n.Top.min[2], 0.75), `min z = ${n.Top.min[2]}`);
  check('spec: grounded Leg stands on the ground', approx(n.Leg.min[2], 0));
  check('spec: rejects negative z', validateSpec({ objects: [{ name: 'X', kind: 'cube', size_m: [1, 1, 1], position_m: [0, 0, -1] }] }).some((e) => e.includes('position_m.z')));
  check('spec: rejects zero size', validateSpec({ objects: [{ name: 'X', kind: 'cube', size_m: [0, 1, 1], position_m: [0, 0, 0] }] }).some((e) => e.includes('size_m.x')));
  check('spec: rejects out-of-bounds', validateSpec({ objects: [{ name: 'X', kind: 'cube', size_m: [1, 1, 1], position_m: [6, 0, 0] }] }).some((e) => e.includes('outside work area')));
  check('spec: rejects non-touching attach', validateSpec({ objects: [
    { name: 'A', kind: 'cube', size_m: [1, 1, 1], position_m: [0, 0, 0] },
    { name: 'B', kind: 'cube', size_m: [1, 1, 1], position_m: [0, 0, 5], attach: 'on_top_of:A' },
  ] }).some((e) => e.includes('does not touch')));
  const bad = buildFromSpec({ objects: [{ name: 'X', kind: 'cube', size_m: [1, 1, 1], position_m: [0, 0, -1] }] });
  check('spec: invalid spec returns errors, not a script', bad.script === null && bad.errors.length > 0);
}

// --- materials v2 + render script ---
console.log('materials + render');
{
  for (const name of ['wood', 'marble', 'metal', 'fabric', 'steel', 'glass', 'skin', 'sandstone']) {
    const s = getMaterialScript(name);
    check(`material: ${name} builds a node tree`, s.includes('ShaderNode') && s.includes('Principled BSDF'));
  }
  check('material: wood has Noise + ColorRamp + Bump', getMaterialScript('wood').includes('ShaderNodeTexNoise') && getMaterialScript('wood').includes('ShaderNodeValToRGB') && getMaterialScript('wood').includes('ShaderNodeBump'));
  check('material: marble has Voronoi veins', getMaterialScript('marble').includes('ShaderNodeTexVoronoi'));
  check('material: unknown name falls back to flat colour', !getMaterialScript('not_a_material').includes('ShaderNodeTexNoise'));
  const maps = pickPolyhavenMaps({
    Diffuse: { '1k': { jpg: { url: 'https://x/diff_1k.jpg' } } },
    Rough: { '1k': { jpg: { url: 'https://x/rough_1k.jpg' } } },
    nor_gl: { '1k': { jpg: { url: 'https://x/nor_1k.jpg' } } },
  });
  check('polyhaven: picks 1k maps', maps.color === 'https://x/diff_1k.jpg' && maps.roughness === 'https://x/rough_1k.jpg' && maps.normal === 'https://x/nor_1k.jpg');
  let threw = false;
  try { pickPolyhavenMaps({}); } catch { threw = true; }
  check('polyhaven: no maps throws', threw);
  check('render: views known', RENDER_VIEWS.includes('front') && RENDER_VIEWS.includes('perspective'));
  let renderThrew = false;
  try { buildRenderScript(['diagonal']); } catch { renderThrew = true; }
  check('render: unknown view throws', renderThrew);
  const renderScript = buildRenderScript(['front', 'side', 'perspective']);
  check('render: script has 50 mm camera + 3-point rig', renderScript.includes('LENS = 50') && renderScript.includes('KeyLight') && renderScript.includes('FillLight') && renderScript.includes('RimLight'));
  check('render: EEVEE default', renderScript.includes('BLENDER_EEVEE_NEXT'));
  const cyclesScript = buildRenderScript(['perspective'], { engine: 'CYCLES', samples: 128, view_transform: 'AgX', lens: 85 });
  check('render: Cycles engine + CPU + OIDN', cyclesScript.includes("scene.render.engine = 'CYCLES'") && cyclesScript.includes("scene.cycles.device = 'CPU'") && cyclesScript.includes('OPENIMAGEDENOISE'));
  check('render: Cycles AgX + 85 mm', cyclesScript.includes('VIEW_TRANSFORM = "AgX"') && cyclesScript.includes('LENS = 85'));
  const transparentScript = buildRenderScript(['front'], { engine: 'CYCLES', transparent: true, turntable_frames: 4 });
  check('render: transparent Cycles uses shadow catcher', transparentScript.includes('ground.is_shadow_catcher = True'));
  check('render: turntable frames', transparentScript.includes('TURNTABLE_FRAMES = 4') && transparentScript.includes('turntable_'));
  let badEngine = false;
  try { buildRenderScript(['front'], { engine: 'WORKBENCH' }); } catch { badEngine = true; }
  check('render: unknown engine throws', badEngine);
  // v1.3.0 fix round: exact fill-based framing (the old max_dim * 2.5
  // heuristic rendered the demo watch at ~30% of the frame).
  // v1.4.0 note: `max_dim * 2.5` still appears in the script, but only as
  // the cinematic fog-cube size — so the check scopes to _frame_camera,
  // the framing code the heuristic lived in.
  const fillScript = buildRenderScript(['perspective'], { engine: 'CYCLES' });
  const frameStart = fillScript.indexOf('def _frame_camera');
  const frameEnd = fillScript.indexOf('\ndef ', frameStart + 1);
  const frameFn = fillScript.slice(frameStart, frameEnd === -1 ? undefined : frameEnd);
  check('render: fill framing replaces 2.5x heuristic', fillScript.includes('FILL_FRACTION = 0.7') && fillScript.includes('_frame_camera') && !frameFn.includes('max_dim * 2.5'));
  let badFill = false;
  try { buildRenderScript(['front'], { fill_fraction: 0.1 }); } catch { badFill = true; }
  check('render: bad fill_fraction throws', badFill);
  check('material: smooth_leather has no noise nodes', !getMaterialScript('smooth_leather').includes('ShaderNodeTexNoise'));
  check('material: polished_steel/white/accent_red have no noise nodes', !getMaterialScript('polished_steel').includes('ShaderNodeTexNoise') && !getMaterialScript('white').includes('ShaderNodeTexNoise') && !getMaterialScript('accent_red').includes('ShaderNodeTexNoise'));
}

// --- product builders + free retrieval (v1.3.0 fix round) ---
console.log('products + retrieve');
{
  check('products: 4 catalogue products', Object.keys(PRODUCTS).sort().join(',') === 'headphones,perfume,smartwatch,sneaker');
  const [hp, hpErr] = getProductScript('headphones');
  check('product: headphones has arched swept band + cushions', hpErr === null && hp.includes('_arc_spine') && hp.includes('_sweep_strip') && hp.includes('HeadbandCushion') && hp.includes('EarCushion'));
  const [sn] = getProductScript('sneaker');
  check('product: sneaker has loft + bezier laces + eyelets', sn.includes('_loft') && sn.includes('LacesCurve') && sn.includes('Eyelet') && sn.includes('ToeCap'));
  const [pf] = getProductScript('perfume');
  check('product: perfume bevelled + seated cap + NOIR', pf.includes('bevel=0.008') && pf.includes('NOIR') && pf.includes('NeckRing'));
  const [sw] = getProductScript('smartwatch');
  check('product: smartwatch dial + hands + curved strap', sw.includes('Marker') && sw.includes('HourHand') && sw.includes('MinuteHand') && sw.includes('Strap'));
  check('product: no noisy fabric on small parts', ![hp, sn, pf, sw].some((s) => s.includes('MAT_fabric')));
  const [bad, badErr] = getProductScript('spaceship');
  check('product: unknown product errors', bad === null && badErr.includes('Unknown product'));
  const retrieved = getRetrievedProductScript('/tmp/watch.gltf', 0.22);
  check('product: retrieved import normalises + grounds', retrieved.includes('import_scene.gltf') && retrieved.includes('RETRIEVED_PRODUCT_JSON'));
  check('retrieve: catalogue search finds the watch', searchPolyhavenCatalogue({ digital_wrist_watch: { name: 'Digital Wrist Watch' }, bleach_bottle: { name: 'Bleach Bottle' } }, 'watch').join() === 'digital_wrist_watch');
  check('retrieve: no headphones on Poly Haven', searchPolyhavenCatalogue({ digital_wrist_watch: { name: 'Digital Wrist Watch' } }, 'headphones').length === 0);
  check('retrieve: known good smartwatch is CC0 Poly Haven', KNOWN_GOOD_ASSETS.smartwatch.slug === 'digital_wrist_watch' && KNOWN_GOOD_ASSETS.smartwatch.licence === 'CC0');
  const plan = pickPolyhavenGltfPackage({ gltf: { '1k': { gltf: { url: 'https://x/m.gltf', include: { 'm.bin': { url: 'https://x/m.bin' } } } } } }, '1k');
  check('retrieve: glTF package picked', plan.main.url === 'https://x/m.gltf' && 'm.bin' in plan.include);
  let noGltf = false;
  try { pickPolyhavenGltfPackage({}, '1k'); } catch { noGltf = true; }
  check('retrieve: missing glTF package throws', noGltf);
  delete process.env.POLY_PIZZA_API_KEY;
  const [pizzaOk, pizzaMsg] = polyPizzaSearchStatus();
  check('retrieve: Poly Pizza without a key is honest', pizzaOk === false && pizzaMsg.includes('401'));
}

// --- generate_3d (v1.3.0): Meshy first, Tripo second ---
console.log('generate_3d');
{
  const text = buildMeshyTextRequest('a red leather armchair', {});
  check('generate: Meshy text preview request', text.mode === 'preview' && text.target_formats[0] === 'glb' && text.auto_size === true && text.origin_at === 'bottom');
  let tooLong = false;
  try { buildMeshyTextRequest('x'.repeat(801), {}); } catch { tooLong = true; }
  check('generate: Meshy prompt over 800 chars throws', tooLong);
  const refine = buildMeshyRefineRequest('preview-1', {});
  check('generate: Meshy refine request', refine.mode === 'refine' && refine.preview_task_id === 'preview-1' && refine.enable_pbr === true);
  const img = buildMeshyImageRequest({ image_url: 'https://example.com/chair.jpg' });
  check('generate: Meshy image request', img.image_url === 'https://example.com/chair.jpg');
  const b64 = buildMeshyImageRequest({ image_base64: 'iVBORw0KGgo=' });
  check('generate: Meshy base64 becomes data URI', b64.image_url.startsWith('data:image/png;base64,'));
  const tripo = buildTripoTextRequest('a brass desk lamp', {});
  check('generate: Tripo text request', tripo.model === 'v3.1-20260211' && tripo.texture === true && tripo.pbr === true);
  check('generate: Meshy terminal states', isMeshyTerminal('SUCCEEDED') && isMeshyTerminal('FAILED') && !isMeshyTerminal('PENDING'));
  check('generate: Tripo terminal states', isTripoTerminal('success') && isTripoTerminal('banned') && !isTripoTerminal('queued'));
  check('generate: Meshy GLB extraction', extractMeshyGlb({ model_urls: { glb: 'https://x/m.glb' } }) === 'https://x/m.glb' && extractMeshyGlb({ model_urls: {} }) === null);
  check('generate: Tripo GLB extraction', extractTripoGlb({ output: { model_url: 'https://x/m.glb' } }) === 'https://x/m.glb');
}

// --- detail helpers (v1.3.0) ---
console.log('detail helpers');
{
  check('details: 11 kinds', DETAIL_KINDS.length === 11 && DETAIL_KINDS.includes('bevel') && DETAIL_KINDS.includes('grille') && DETAIL_KINDS.includes('label') && DETAIL_KINDS.includes('condensation') && DETAIL_KINDS.includes('emissive_ring') && DETAIL_KINDS.includes('glow_strip'));
  for (const kind of DETAIL_KINDS) {
    const s = getDetailScript(kind, 'Table', {});
    check(`detail: ${kind} script mentions its mechanism`, s.includes('Bevel') || s.includes('SUBSURF') || s.includes('PanelLine') || s.includes('Screw') || s.includes('Bolt') || s.includes('Seam') || s.includes('Grille') || s.includes('Label') || s.includes('Condensation') || s.includes('EmissiveRing') || s.includes('GlowStrip'));
  }
  let unknown = false;
  try { getDetailScript('engrave', 'Table', {}); } catch { unknown = true; }
  check('detail: unknown kind throws', unknown);
  let badWidth = false;
  try { getDetailScript('bevel', 'Table', { width_m: 0 }); } catch { badWidth = true; }
  check('detail: bad width throws', badWidth);
  // Regression (v1.3.0 demo): the bevel/subdivision DETAIL_OK prints used
  // bare Python-style {width}/{levels} inside a TS template literal, so the
  // generated script raised NameError in real Blender. The values must be
  // interpolated into the generated Python (literal numbers in the print).
  const bevelScript = getDetailScript('bevel', 'Table', {});
  check('detail: bevel print has interpolated values, no bare {width}', bevelScript.includes('width=0.002 segments=3') && !bevelScript.includes('{width}'));
  const subdivScript = getDetailScript('subdivision', 'Table', {});
  check('detail: subdivision print has interpolated levels', subdivScript.includes('levels=2') && !subdivScript.includes('{levels}'));
  for (const kind of DETAIL_KINDS) {
    const s = getDetailScript(kind, 'Table', {});
    const prints = [...s.matchAll(/DETAIL_OK[^\n]*/g)].map((m) => m[0]);
    check(`detail: ${kind} DETAIL_OK print has no un-interpolated {var}`, prints.every((p) => !/\{(width|segments|levels|rows|face|axisName)\}/.test(p)));
  }
  // Seam regression (v1.3.0 demo): unit torus scaled into an ellipse that
  // hugs the cross-section — never a circle sized by max().
  const seamScript = getDetailScript('seam', 'Table', {});
  check('detail: seam is a unit torus scaled to the cross-section ellipse', seamScript.includes('major_radius=1.0') && seamScript.includes('_seam.scale') && !seamScript.includes('max(_size'));
}

// --- cinematic preset (v1.4.0) ---
console.log('cinematic preset');
{
  const cine = buildRenderScript(['perspective'], { style: 'cinematic' });
  check('cinematic: AgX Punchy + 512 samples + 85 mm + 0.4 fill', cine.includes('AgX - Punchy') && cine.includes('SAMPLES = 512') && cine.includes('LENS = 85') && cine.includes('FILL_FRACTION = 0.4'));
  check('cinematic: teal/amber rims, no sun in the cinematic branch', cine.includes('CineRimTeal') && cine.includes('CineRimAmber') && cine.includes('if not CINEMATIC:'));
  check('cinematic: fog + mist + glare', cine.includes('FOG_DENSITY') && cine.includes('use_pass_mist') && cine.includes('FOG_GLOW'));
  // Regression (2026-11-08 NISHANT hero): a 256x256 vignette image fed
  // into a MULTIPLY Mix node shrank every cinematic render to a centred
  // 256x256 square, cropping the hero's lid, glow ring and base.
  check('cinematic: vignette is full render resolution, not 256x256', cine.includes('_vw, _vh = RES_X, RES_Y') && !cine.includes('_vw, _vh = 256, 256'));
  let badStyle = false;
  try { buildRenderScript(['front'], { style: 'moody' }); } catch { badStyle = true; }
  check('cinematic: bad style throws', badStyle);
  let badEnv = false;
  try { buildRenderScript(['front'], { style: 'cinematic', environment: 'beach' }); } catch { badEnv = true; }
  check('cinematic: bad environment throws', badEnv);
  let badFog = false;
  try { buildRenderScript(['front'], { style: 'cinematic', fog_density: 0.5 }); } catch { badFog = true; }
  check('cinematic: bad fog_density throws', badFog);
  let badTrans = false;
  try { buildRenderScript(['front'], { style: 'cinematic', transparent: true }); } catch { badTrans = true; }
  check('cinematic: cinematic + transparent throws', badTrans);
  const hall = buildRenderScript(['perspective'], { style: 'cinematic', environment: 'industrial_hall', hero_scale_m: 3.0, scale_figure: true });
  check('cinematic: hall + hero scale + scale figure', hall.includes('HALL_L') && hall.includes('ScaleFigure') && hall.includes('HERO_SCALE_M = 3.0'));
  const neon = buildRenderScript(['perspective'], { style: 'cinematic', environment: 'neon' });
  check('cinematic: neon has strips', neon.includes('NeonStrip'));
  const studio = buildRenderScript(['front', 'side', 'perspective']);
  check('cinematic: studio defaults unchanged', studio.includes('STYLE = "studio"') && studio.includes('LENS = 50') && studio.includes('FILL_FRACTION = 0.7'));
  check('material: weathered_stone has Pointiness + AO + Voronoi', getMaterialScript('weathered_stone').includes('Pointiness') && getMaterialScript('weathered_stone').includes('ShaderNodeAmbientOcclusion') && getMaterialScript('weathered_stone').includes('ShaderNodeTexVoronoi'));
  check('material: brushed_aluminium is anisotropic', getMaterialScript('brushed_aluminium').includes('Anisotropic') && getMaterialScript('brushed_aluminium').includes('ShaderNodeTangent'));
  check('material: printed_can rule (Metallic 0.0 + coat)', getMaterialScript('printed_can').includes('["Metallic"].default_value = 0.0') && getMaterialScript('printed_can').includes('["Coat Weight"].default_value = 1.0'));
  check('material: emissive teal/amber', getMaterialScript('emissive_teal').includes('Emission Strength') && getMaterialScript('emissive_amber').includes('(1.0, 0.55, 0.2, 1)'));
  check('material: coffee is dark brown, not stone grey', getMaterialScript('coffee').includes('(0.09, 0.045, 0.02, 1)') && getMaterialScript('coffee').includes('["Roughness"].default_value = 0.7') && getMaterialScript('coffee').includes('["Specular IOR Level"].default_value = 0.0'));
  check('material: ceramic is white glazed', getMaterialScript('ceramic').includes('(0.95, 0.95, 0.95, 1)') && getMaterialScript('ceramic').includes('["Roughness"].default_value = 0.3'));
  const cond = getDetailScript('condensation', 'CanBody', {});
  check('detail: condensation uses visible_shadow + template stamping', cond.includes('visible_shadow = False') && !cond.includes('_drops.cycles_visibility') && cond.includes('_stamp(_m)'));
  let badDensity = false;
  try { getDetailScript('condensation', 'CanBody', { density: 'soaked' }); } catch { badDensity = true; }
  check('detail: bad condensation density throws', badDensity);
  const ring = getDetailScript('emissive_ring', 'CanBody', { color: '#00D8FF', strength: 3 });
  check('detail: emissive_ring builds', ring.includes('EmissiveRing') && ring.includes('Emission Strength'));
  const strip = getDetailScript('glow_strip', 'CanBody', { face: 'front', strength: 5 });
  check('detail: glow_strip builds', strip.includes('GlowStrip') && strip.includes('Emission Strength'));
  const can = getDimensions('slim_can_250ml');
  check('grounding: slim can 53x133 from Crown', can.success === true && JSON.stringify(can.overall_size_m) === JSON.stringify([0.053, 0.053, 0.133]) && can.parts.CanBody.material === 'printed_can');
  const cprompt = buildCritiquePrompt({ objects: [{ name: 'CanBody', size_m: [0.053, 0.053, 0.133] }] }, []);
  check('critique: prompt has cinematic checks', cprompt.includes('brightest object') && cprompt.includes('rim light') && cprompt.includes('light shafts') && cprompt.includes('banding'));
}

// --- anti-hallucination grounding (v1.3.1) ---
console.log('grounding');
{
  check('grounding: no grounding is refused', checkGrounding(null).length > 0 && checkGrounding(null)[0].includes('no grounding'));
  check('grounding: fabricated grounding is refused', checkGrounding({ source: 'research_model', grounding_id: 'grd_madeup1234', query: 'coffee mug' }).length > 0);
  const g = mintGrounding({ source: 'research_model', query: 'coffee mug', references: [{ name: 'Mug', source: 'test', url: 'https://example.com/mug' }] });
  check('grounding: minted grounding validates', checkGrounding(g).length === 0);
  check('grounding: reference grounding needs observed features', checkGrounding({ source: 'reference_image', reference: '/tmp/mug.png' }).length > 0);
  check('grounding: reference grounding with features validates', checkGrounding({ source: 'reference_image', reference: '/tmp/mug.png', observed_features: ['MugBody', 'Handle'] }).length === 0);
  check('grounding: library grounding needs a known product', checkGrounding({ source: 'dimension_library', product: 'teleporter' }).length > 0 && checkGrounding({ source: 'dimension_library', product: 'coffee_mug' }).length === 0);
  const mug = getDimensions('coffee_mug');
  check('grounding: library has real coffee mug numbers', mug.success === true && JSON.stringify(mug.overall_size_m) === JSON.stringify([0.111, 0.082, 0.088]));
  check('grounding: library covers 16 products', Object.keys(DIMENSION_LIBRARY).length === 16);
  check('grounding: library rickshaw matches Bajaj RE4S spec', JSON.stringify(DIMENSION_LIBRARY.rickshaw.overall_size_m) === JSON.stringify([2.658, 1.3, 1.7]));
  check('grounding: unknown product fails cleanly', getDimensions('teleporter').success === false);
  check('spec: rejects missing dimension_source', validateSpec({ objects: [{ name: 'X', kind: 'cube', size_m: [0.2, 0.2, 0.2], position_m: [0, 0, 0], material: 'wood' }] }).some((e) => e.includes('dimension_source')));
  check('spec: rejects placeholder [1,1,1]', validateSpec({ objects: [{ name: 'X', kind: 'cube', size_m: [1, 1, 1], position_m: [0, 0, 0], material: 'wood', dimension_source: 'research' }] }).some((e) => e.includes('placeholder')));
  check('spec: rejects missing material', validateSpec({ objects: [{ name: 'X', kind: 'cube', size_m: [0.2, 0.2, 0.2], position_m: [0, 0, 0], dimension_source: 'measured' }] }).some((e) => e.includes('material')));
  check('spec: rejects floating part', validateSpec({ objects: [{ name: 'X', kind: 'cube', size_m: [0.2, 0.2, 0.2], position_m: [0, 0, 0.5], material: 'wood', dimension_source: 'research' }] }).some((e) => e.includes('FLOATING')));
  check('spec: library claim must match library numbers', specMatchesLibrary({ product: 'coffee_mug', objects: [{ name: 'MugBody', size_m: [0.5, 0.5, 0.5], dimension_source: 'library' }] }).length > 0);
  check('spec: library claim with real numbers passes', specMatchesLibrary({ product: 'coffee_mug', objects: [{ name: 'MugBody', size_m: [0.082, 0.082, 0.095], dimension_source: 'library' }] }).length === 0);
  const vspec = { objects: [{ name: 'MugBody', size_m: [0.082, 0.082, 0.095] }] };
  check('verify: script has VERIFY_JSON + material + feature checks', buildVerifyScript(JSON.stringify(vspec)).includes('VERIFY_JSON:') && buildVerifyScript(JSON.stringify(vspec)).includes('has_material:') && buildVerifyScript(JSON.stringify(vspec)).includes('observed_feature:'));
  check('verify: missing payload is a failure', verifyBuildReport(vspec, null).passed === false);
  check('verify: failing check is a failure', verifyBuildReport(vspec, { checks: [{ check: 'connected:Handle', passed: false, detail: 'FLOATING' }] }).passed === false);
  check('verify: all passing is a success', verifyBuildReport(vspec, { checks: [{ check: 'part_count', passed: true, detail: 'ok' }] }).passed === true);
  check('verify: parse VERIFY_JSON', parseVerifyJson('VERIFY_JSON:' + JSON.stringify({ checks: [{ check: 'part_count', passed: true, detail: 'ok' }] }))?.checks.length === 1);
}

// --- critique loop (v1.3.0) ---
console.log('critique loop');
{
  check('critique: max 3 refine rounds', MAX_REFINE_ROUNDS === 3);
  const spec = { objects: [{ name: 'Table', size_m: [1.2, 0.8, 0.05] }] };
  const script = buildCritiqueScript(JSON.stringify(spec));
  check('critique: script has CRITIQUE_JSON + connectivity checks', script.includes('CRITIQUE_JSON:') && script.includes('connected:') && script.includes('min_z:'));
  const parsed = parseCritiqueJson('CRITIQUE_JSON:' + JSON.stringify({ checks: [{ check: 'min_z:Table', passed: true, detail: 'ok' }] }));
  check('critique: parse CRITIQUE_JSON', parsed !== null && parsed.checks.length === 1);
  const prompt = buildCritiquePrompt(spec, [{ check: 'min_z:Table', passed: true, detail: 'min z = 0.0000 m' }]);
  check('critique: prompt has spec + dual gate + fix rules', prompt.includes('Table') && prompt.includes('DUAL GATE') && prompt.includes('LOCALISED EDITS') && prompt.includes('cannot see'));
}

console.log(failures === 0 ? '\nAll TS template checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
