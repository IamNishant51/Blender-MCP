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

// --- rickshaw ---
console.log('rickshaw');
{
  const r = boundsFor(generateModelScript('auto rickshaw', ''));
  assertOnGround('rickshaw', r);
  const wheels = r.objects.filter((o) => o.name === 'Wheel');
  check('rickshaw: 3 wheels', wheels.length === 3, `got ${wheels.length}`);
  for (const w of wheels) {
    check('rickshaw: wheel touches ground', approx(w.min[2], 0), `min z = ${w.min[2]}`);
    check('rickshaw: wheel diameter 1.0 m', approx(w.max[2] - w.min[2], 1.0), `height = ${w.max[2] - w.min[2]}`);
  }
  const height = r.scene_max[2] - r.scene_min[2];
  check('rickshaw: under 2 m tall', height < 2, `height = ${height}`);
  const body = byName(r).BodyMain;
  check('rickshaw: body 2.2 m long', approx(body.max[1] - body.min[1], 2.2));
}

// --- thali ---
console.log('thali');
{
  const r = boundsFor(generateModelScript('thali', ''));
  check('thali: 5 objects', r.objects.length === 5, `got ${r.objects.length}`);
  assertOnGround('thali', r);
  check('thali: under 0.25 m tall', r.scene_max[2] - r.scene_min[2] < 0.25);
  const plate = byName(r).ThaliPlate;
  check('thali: plate 0.7 m across', approx(plate.max[0] - plate.min[0], 0.7));
  check('thali: plate top at z = 0.03', approx(plate.max[2], 0.03));
}

// --- haveli ---
console.log('haveli');
{
  const r = boundsFor(generateModelScript('haveli palace', ''));
  assertOnGround('haveli', r);
  const n = byName(r);
  check('haveli: ground floor tops at z = 3', approx(n.GroundFloor.max[2], 3.0));
  check('haveli: first floor starts at z = 3', approx(n.FirstFloor.min[2], 3.0));
  check('haveli: first floor tops at z = 5.5', approx(n.FirstFloor.max[2], 5.5));
  check('haveli: roof starts at z = 5.5', approx(n.MainRoof.min[2], 5.5));
  check('haveli: total height 7.5-8 m', r.scene_max[2] > 7.5 && r.scene_max[2] < 8, `max z = ${r.scene_max[2]}`);
}

// --- character ---
console.log('character');
{
  const r = boundsFor(generateModelScript('person', ''));
  assertOnGround('character', r);
  const n = byName(r);
  check('character: head above torso above dhoti', n.Head.min[2] > n.Torso.min[2] && n.Torso.min[2] > n.Dhoti.min[2]);
  check('character: dhoti starts at ground', approx(n.Dhoti.min[2], 0));
  check('character: 1.87 m tall', approx(r.scene_max[2], 1.87), `max z = ${r.scene_max[2]}`);
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

console.log(failures === 0 ? '\nAll TS template checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
