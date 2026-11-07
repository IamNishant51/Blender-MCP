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
      { name: 'Table', kind: 'cube', size_m: [1.2, 0.8, 0.05], position_m: [0, 0, 0.7], material: 'wood' },
      { name: 'Leg', kind: 'cylinder', size_m: [0.08, 0.08, 0.7], position_m: [0, 0, 0], attach: 'grounded' },
      { name: 'Top', kind: 'cube', size_m: [1.2, 0.8, 0.05], position_m: [0, 0, 0.75], attach: 'on_top_of:Table' },
    ],
  };
  check('spec: valid spec passes', validateSpec(valid).length === 0, validateSpec(valid).join('; '));
  const { script, errors } = buildFromSpec(valid);
  check('spec: build returns a script', typeof script === 'string' && script.length > 0, errors.join('; '));
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
  check('render: script has 50 mm camera + 3-point rig', renderScript.includes('lens = 50') && renderScript.includes('KeyLight') && renderScript.includes('FillLight') && renderScript.includes('RimLight'));
}

console.log(failures === 0 ? '\nAll TS template checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
