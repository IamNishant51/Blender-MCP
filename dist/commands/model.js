/**
 * Model Builder - Creates 3D models by executing Blender scripts
 */
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../utils/logger.js';
import { buildRenderScript } from './render.js';
/** Blender snippet appended to a build script: prints object + scene bounds as JSON. */
export const BOUNDS_SNIPPET = `
import bpy, json
from mathutils import Vector
bpy.context.view_layer.update()  # flush scale/location edits into matrix_world
_objs = []
for o in bpy.data.objects:
    if o.type == 'MESH':
        corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
        xs = [v.x for v in corners]; ys = [v.y for v in corners]; zs = [v.z for v in corners]
        _objs.append({"name": o.name, "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]})
_all_min = [min(o["min"][i] for o in _objs) for i in range(3)] if _objs else [0, 0, 0]
_all_max = [max(o["max"][i] for o in _objs) for i in range(3)] if _objs else [0, 0, 0]
print("BLENDER_BOUNDS_JSON:" + json.dumps({"objects": _objs, "scene_min": _all_min, "scene_max": _all_max, "scene_size": [_all_max[i] - _all_min[i] for i in range(3)]}))
`;
export class ModelBuilder {
    blender;
    paths;
    logger = createLogger('model');
    constructor(blender, paths) {
        this.blender = blender;
        this.paths = paths;
        // Ensure directories exist
        this.ensureDirectories();
    }
    ensureDirectories() {
        for (const dir of [this.paths.tempDir, this.paths.outputDir]) {
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
        }
    }
    async createMesh(script) {
        this.logger.info('Creating 3D model');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outputPath = join(this.paths.outputDir, `model_${timestamp}.blend`);
        const fullScript = script + `\nbpy.ops.wm.save_mainfile(filepath="${outputPath}")`;
        // Write script to temp file
        const scriptPath = join(this.paths.tempDir, `script_${Date.now()}.py`);
        writeFileSync(scriptPath, fullScript);
        try {
            const result = await this.runBlender(scriptPath);
            if (result.success) {
                this.logger.info(`Model saved to: ${outputPath}`);
                // Open in Blender (non-blocking)
                this.openInBlender(outputPath);
                return { success: true, output: outputPath, stdout: result.stdout?.slice(-2000) };
            }
            else {
                this.logger.error(`Blender script failed: ${result.error}`);
                return { success: false, error: result.error, stdout: result.stdout?.slice(-2000) };
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Model creation failed: ${message}`);
            return { success: false, error: message };
        }
        finally {
            try {
                unlinkSync(scriptPath);
            }
            catch {
                // Ignore cleanup errors
            }
        }
    }
    /**
     * Like createMesh, but also returns the built objects' names and
     * bounding boxes (parsed from the BOUNDS_SNIPPET line Blender prints).
     * Used by build_from_spec: the caller needs numbers, not just exit 0.
     */
    async createMeshWithReport(script) {
        this.logger.info('Creating 3D model (with bounds report)');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outputPath = join(this.paths.outputDir, `model_${timestamp}.blend`);
        const fullScript = script + '\n' + BOUNDS_SNIPPET + `\nbpy.ops.wm.save_mainfile(filepath="${outputPath}")`;
        const scriptPath = join(this.paths.tempDir, `script_${Date.now()}.py`);
        writeFileSync(scriptPath, fullScript);
        try {
            const result = await this.runBlender(scriptPath);
            if (!result.success) {
                return { success: false, error: result.error, stdout: result.stdout?.slice(-2000) };
            }
            const bounds = parseBoundsJson(result.stdout ?? '');
            if (!bounds) {
                return {
                    success: false,
                    output: outputPath,
                    error: 'Blender ran but reported no object bounds (no meshes created?)',
                    stdout: result.stdout?.slice(-2000),
                };
            }
            return {
                success: true,
                output: outputPath,
                stdout: result.stdout?.slice(-2000),
                objects: bounds.objects,
                scene_min: bounds.scene_min,
                scene_max: bounds.scene_max,
                min_z: bounds.scene_min[2],
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }
        finally {
            try {
                unlinkSync(scriptPath);
            }
            catch {
                // Ignore cleanup errors
            }
        }
    }
    /**
     * Render a saved .blend with the presentation preset (see render.ts).
     * Every PNG is verified to exist on disk and be non-empty before
     * success is reported — a missing/empty PNG is success:false.
     * `outputPrefix` is a file path prefix; each view renders to
     * `<prefix>_<view>.png` (a trailing .png/.blend extension is stripped).
     */
    async renderModel(blendPath, outputPrefix, views, options = {}) {
        if (!existsSync(blendPath)) {
            return { success: false, error: `Blend file not found: ${blendPath}` };
        }
        let script;
        try {
            script = buildRenderScript(views, options);
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
        const prefix = outputPrefix.replace(/\.(png|blend)$/i, '');
        const outDir = dirname(prefix);
        if (outDir && !existsSync(outDir)) {
            mkdirSync(outDir, { recursive: true });
        }
        const scriptPath = join(this.paths.tempDir, `render_${Date.now()}.py`);
        writeFileSync(scriptPath, script);
        try {
            // Renders are slow on software GL (~1 min/view at 960x720); Cycles
            // on CPU is slower still — give them at least 600 s (EEVEE) or
            // 1800 s (Cycles) no matter what the build timeout is.
            const result = await this.runBlenderArgs([
                '--background', blendPath, '--python', scriptPath, '--', prefix, ...views,
            ], Math.max(this.blender.timeout, options.engine === 'CYCLES' ? 1800 : 600));
            if (!result.success) {
                this.logger.error(`Render failed: ${result.error}`);
                return { success: false, error: result.error, stdout: result.stdout?.slice(-2000) };
            }
            // The script prints RENDER_DONE_JSON with every render it wrote
            // (views + turntable frames). Trust that list — rebuilding it from
            // `views` alone silently dropped the turntable frames (they were
            // rendered to disk but never reported).
            const doneMatch = result.stdout?.match(/RENDER_DONE_JSON:(\{.*\})/);
            let listed = [];
            if (doneMatch) {
                try {
                    listed = (JSON.parse(doneMatch[1]).renders ?? []);
                }
                catch {
                    listed = [];
                }
            }
            const toCheck = listed.length > 0 ? listed : views.map((view) => ({ view, path: `${prefix}_${view}.png` }));
            const renders = [];
            for (const { view, path: pngPath } of toCheck) {
                if (!existsSync(pngPath)) {
                    return { success: false, error: `Render failed: ${pngPath} was not written by Blender`, stdout: result.stdout?.slice(-2000) };
                }
                const size = statSync(pngPath).size;
                if (size === 0) {
                    return { success: false, error: `Render failed: ${pngPath} is empty (0 bytes)`, stdout: result.stdout?.slice(-2000) };
                }
                renders.push({ view, path: pngPath, size_bytes: size });
            }
            return { success: true, output: blendPath, renders, stdout: result.stdout?.slice(-2000) };
        }
        finally {
            try {
                unlinkSync(scriptPath);
            }
            catch {
                // Ignore cleanup errors
            }
        }
    }
    /** Run Blender with an arbitrary argument list (e.g. --background <blend> --python ...).
     * `timeoutSeconds` overrides the configured timeout; renders pass a
     * higher floor because EEVEE on software GL is slow (~1 min/view). */
    runBlenderArgs(args, timeoutSeconds) {
        return new Promise((resolve) => {
            this.logger.debug(`Running: ${this.blender.executable} ${args.join(' ')}`);
            const proc = spawn(this.blender.executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            proc.stdout?.on('data', (data) => { stdout += data.toString(); });
            proc.stderr?.on('data', (data) => { stderr += data.toString(); });
            const timeout = setTimeout(() => {
                proc.kill();
                resolve({ success: false, error: 'Execution timed out', stdout });
            }, (timeoutSeconds ?? this.blender.timeout) * 1000);
            proc.on('close', (code) => {
                clearTimeout(timeout);
                // Blender exits 0 even when the --python script raises: the
                // traceback goes to stderr and nothing is saved. A traceback in
                // stderr is a failure, whatever the exit code says — otherwise a
                // broken script reports success:true with no .blend (the v1.1.0
                // false-success class of bug).
                if (code === 0 && !stderr.includes('Traceback (most recent call last)'))
                    resolve({ success: true, stdout });
                else
                    resolve({ success: false, error: stderr || `Process exited with code ${code}`, stdout });
            });
            proc.on('error', (error) => {
                clearTimeout(timeout);
                if (error.message.includes('ENOENT'))
                    resolve({ success: false, error: 'Blender executable not found', stdout });
                else
                    resolve({ success: false, error: error.message, stdout });
            });
        });
    }
    runBlender(scriptPath) {
        return this.runBlenderArgs(['--background', '--python', scriptPath]);
    }
    openInBlender(filePath) {
        try {
            spawn(this.blender.executable, [filePath], {
                detached: true,
                stdio: 'ignore',
            }).unref();
        }
        catch {
            // Ignore errors - opening is non-critical
        }
    }
}
export function parseBoundsJson(stdout) {
    for (const line of stdout.split('\n')) {
        if (line.startsWith('BLENDER_BOUNDS_JSON:')) {
            try {
                return JSON.parse(line.slice('BLENDER_BOUNDS_JSON:'.length));
            }
            catch {
                return null;
            }
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Materials v2 — Principled BSDF node trees (Generated coords, no UVs needed)
// ---------------------------------------------------------------------------
// Flat-colour fallback table (unknown names)
export const MATERIALS = {
    marble: { baseColor: [0.95, 0.95, 0.95, 1], roughness: 0.1, metallic: 0.0 },
    red_marble: { baseColor: [0.8, 0.3, 0.25, 1], roughness: 0.15, metallic: 0.1 },
    green_marble: { baseColor: [0.2, 0.5, 0.3, 1], roughness: 0.15, metallic: 0.1 },
    wood: { baseColor: [0.35, 0.2, 0.1, 1], roughness: 0.7, metallic: 0.0 },
    gold: { baseColor: [1.0, 0.76, 0.33, 1], roughness: 0.2, metallic: 1.0 },
    copper: { baseColor: [0.95, 0.64, 0.54, 1], roughness: 0.3, metallic: 1.0 },
    brass: { baseColor: [0.85, 0.7, 0.3, 1], roughness: 0.4, metallic: 1.0 },
    stone: { baseColor: [0.6, 0.58, 0.55, 1], roughness: 0.85, metallic: 0.0 },
    sandstone: { baseColor: [0.85, 0.75, 0.6, 1], roughness: 0.9, metallic: 0.0 },
    terracotta: { baseColor: [0.8, 0.45, 0.3, 1], roughness: 0.85, metallic: 0.0 },
    black: { baseColor: [0.02, 0.02, 0.02, 1], roughness: 0.15, metallic: 0.0 },
    smooth_leather: { baseColor: [0.16, 0.12, 0.10, 1], roughness: 0.7, metallic: 0.0 },
    brown_leather: { baseColor: [0.32, 0.20, 0.12, 1], roughness: 0.7, metallic: 0.0 },
    black_leather: { baseColor: [0.05, 0.05, 0.05, 1], roughness: 0.7, metallic: 0.0 },
    matte_plastic: { baseColor: [0.05, 0.05, 0.05, 1], roughness: 0.55, metallic: 0.0 },
    rubber: { baseColor: [0.03, 0.03, 0.03, 1], roughness: 0.95, metallic: 0.0 },
    white_leather: { baseColor: [0.93, 0.92, 0.90, 1], roughness: 0.5, metallic: 0.0 },
    amber_liquid: { baseColor: [0.85, 0.45, 0.12, 1], roughness: 0.05, metallic: 0.0 },
    coffee: { baseColor: [0.09, 0.045, 0.02, 1], roughness: 0.7, metallic: 0.0 },
    ceramic: { baseColor: [0.95, 0.95, 0.95, 1], roughness: 0.3, metallic: 0.0 },
    polished_steel: { baseColor: [0.85, 0.85, 0.86, 1], roughness: 0.25, metallic: 0.9 },
    white: { baseColor: [0.95, 0.95, 0.95, 1], roughness: 0.4, metallic: 0.0 },
    accent_red: { baseColor: [0.65, 0.08, 0.08, 1], roughness: 0.5, metallic: 0.0 },
    // Cinematic (v1.4.0) — flat-table entries for backwards compatibility.
    weathered_stone: { baseColor: [0.8, 0.7, 0.55, 1], roughness: 0.85, metallic: 0.0 },
    brushed_aluminium: { baseColor: [0.85, 0.85, 0.86, 1], roughness: 0.3, metallic: 1.0 },
    printed_can: { baseColor: [0.03, 0.03, 0.04, 1], roughness: 0.3, metallic: 0.0 },
    wet_floor: { baseColor: [0.02, 0.02, 0.022, 1], roughness: 0.6, metallic: 0.0 },
    emissive_teal: { baseColor: [0.01, 0.01, 0.01, 1], roughness: 0.4, metallic: 0.0 },
    emissive_amber: { baseColor: [0.01, 0.01, 0.01, 1], roughness: 0.4, metallic: 0.0 },
};
function nodeHeader(name) {
    return `
mat = bpy.data.materials.new(name=${JSON.stringify(name)})
mat.use_nodes = True
nt = mat.node_tree
nodes = nt.nodes
links = nt.links
bsdf = nodes["Principled BSDF"]
texcoord = nodes.new("ShaderNodeTexCoord")
texcoord.location = (-800, 0)
`;
}
function noiseBlock(scale, detail = 2.0, roughness = 0.7) {
    return `
noise = nodes.new("ShaderNodeTexNoise")
noise.location = (-600, 200)
noise.inputs["Scale"].default_value = ${scale}
noise.inputs["Detail"].default_value = ${detail}
noise.inputs["Roughness"].default_value = ${roughness}
links.new(texcoord.outputs["Generated"], noise.inputs["Vector"])
`;
}
function rampBlock(c0, c1) {
    return `
ramp = nodes.new("ShaderNodeValToRGB")
ramp.location = (-400, 200)
ramp.color_ramp.elements[0].position = 0.0
ramp.color_ramp.elements[0].color = ${JSON.stringify([...c0, 1])}
ramp.color_ramp.elements[1].position = 1.0
ramp.color_ramp.elements[1].color = ${JSON.stringify([...c1, 1])}
links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
`;
}
function bumpBlock(strength, distance = 0.1) {
    return `
bump = nodes.new("ShaderNodeBump")
bump.location = (-400, -200)
bump.inputs["Strength"].default_value = ${strength}
bump.inputs["Distance"].default_value = ${distance}
links.new(noise.outputs["Fac"], bump.inputs["Height"])
links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
`;
}
function woodScript(name) {
    return nodeHeader(name) + noiseBlock(5.0)
        + rampBlock([0.23, 0.12, 0.05], [0.55, 0.36, 0.19]) + bumpBlock(0.3)
        + `
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.7
`;
}
function marbleScript(name, base = [0.93, 0.93, 0.92], vein = [0.15, 0.15, 0.16]) {
    return nodeHeader(name) + `
voronoi = nodes.new("ShaderNodeTexVoronoi")
voronoi.location = (-600, 200)
voronoi.inputs["Scale"].default_value = 6.0
voronoi.feature = 'F1'
voronoi.distance = 'EUCLIDEAN'
links.new(texcoord.outputs["Generated"], voronoi.inputs["Vector"])
ramp = nodes.new("ShaderNodeValToRGB")
ramp.location = (-400, 200)
# Thin dark veins: dark at distance 0, base colour everywhere else.
ramp.color_ramp.elements[0].position = 0.0
ramp.color_ramp.elements[0].color = ${JSON.stringify([...vein, 1])}
ramp.color_ramp.elements[1].position = 1.0
ramp.color_ramp.elements[1].color = ${JSON.stringify([...base, 1])}
vein_stop = ramp.color_ramp.elements.new(0.12)
vein_stop.color = ${JSON.stringify([...base, 1])}
links.new(voronoi.outputs["Distance"], ramp.inputs["Fac"])
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.2
bsdf.inputs["Subsurface Weight"].default_value = 0.1
# NOTE: Blender 4.2's Principled BSDF has no "Subsurface Color" input —
# subsurface takes its colour from Base Color (the Voronoi ramp above).
# Setting it raises KeyError and kills the whole build.
`;
}
function metalScript(name, tint = [0.8, 0.8, 0.82], metallic = 1.0, roughLo = 0.2, roughHi = 0.4) {
    return nodeHeader(name) + noiseBlock(8.0) + `
# Noise varies the roughness between ${roughLo} and ${roughHi}.
rough_ramp = nodes.new("ShaderNodeValToRGB")
rough_ramp.location = (-400, 0)
rough_ramp.color_ramp.elements[0].position = 0.0
rough_ramp.color_ramp.elements[0].color = (${roughLo}, ${roughLo}, ${roughLo}, 1)
rough_ramp.color_ramp.elements[1].position = 1.0
rough_ramp.color_ramp.elements[1].color = (${roughHi}, ${roughHi}, ${roughHi}, 1)
links.new(noise.outputs["Fac"], rough_ramp.inputs["Fac"])
links.new(rough_ramp.outputs["Color"], bsdf.inputs["Roughness"])
` + bumpBlock(0.2) + `
bsdf.inputs["Base Color"].default_value = ${JSON.stringify([...tint, 1])}
bsdf.inputs["Metallic"].default_value = ${metallic}
`;
}
function fabricScript(name, base = [0.85, 0.8, 0.72]) {
    return nodeHeader(name) + noiseBlock(25.0) + bumpBlock(0.15) + `
bsdf.inputs["Base Color"].default_value = ${JSON.stringify([...base, 1])}
bsdf.inputs["Roughness"].default_value = 0.9
bsdf.inputs["Sheen Weight"].default_value = 1.0
bsdf.inputs["Sheen Roughness"].default_value = 0.5
`;
}
function glassScript(name) {
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1)
bsdf.inputs["Roughness"].default_value = 0.05
bsdf.inputs["Transmission Weight"].default_value = 1.0
bsdf.inputs["IOR"].default_value = 1.45
`;
}
function skinScript(name) {
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.55, 0.35, 0.25, 1)
bsdf.inputs["Roughness"].default_value = 0.6
bsdf.inputs["Subsurface Weight"].default_value = 0.4
# NOTE: Blender 4.2's Principled BSDF has no "Subsurface Color" input —
# subsurface takes its colour from Base Color. Setting it raises KeyError.
bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.2, 0.1)
`;
}
function sandstoneScript(name, dark = [0.75, 0.6, 0.35], light = [0.9, 0.78, 0.55]) {
    return nodeHeader(name) + noiseBlock(8.0)
        + rampBlock(dark, light) + bumpBlock(0.4)
        + `
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.9
`;
}
function smoothLeatherScript(name, base = [0.16, 0.12, 0.10]) {
    // Smooth leather for straps / cushions — deliberately NO noise nodes.
    // v1.3.0 fix: the v1.3.0 smartwatch strap used `fabric` (Noise -> Bump
    // at scale 25, Generated coordinates). On a 22 mm strap that noise reads
    // as a scribbled artifact under studio light. A real strap is smooth at
    // this scale: plain Principled + a little sheen, nothing else.
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = ${JSON.stringify([...base, 1])}
bsdf.inputs["Roughness"].default_value = 0.7
bsdf.inputs["Sheen Weight"].default_value = 0.3
bsdf.inputs["Sheen Roughness"].default_value = 0.6
`;
}
function mattePlasticScript(name, base = [0.05, 0.05, 0.05]) {
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = ${JSON.stringify([...base, 1])}
bsdf.inputs["Roughness"].default_value = 0.55
bsdf.inputs["Metallic"].default_value = 0.0
`;
}
function rubberScript(name) {
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.03, 0.03, 0.03, 1)
bsdf.inputs["Roughness"].default_value = 0.95
bsdf.inputs["Metallic"].default_value = 0.0
`;
}
function whiteLeatherScript(name) {
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.93, 0.92, 0.90, 1)
bsdf.inputs["Roughness"].default_value = 0.5
bsdf.inputs["Sheen Weight"].default_value = 0.5
bsdf.inputs["Sheen Roughness"].default_value = 0.5
`;
}
function amberLiquidScript(name) {
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.85, 0.45, 0.12, 1)
bsdf.inputs["Roughness"].default_value = 0.05
bsdf.inputs["Transmission Weight"].default_value = 0.85
bsdf.inputs["IOR"].default_value = 1.33
`;
}
function coffeeScript(name) {
    // Black coffee surface — very dark brown, soft sheen (Roughness 0.7).
    // v1.4.0 fix: the coffee_mug dimension-library part uses material
    // "coffee", but no builder existed, so it silently fell back to the
    // flat stone-grey fallback (0.6, 0.58, 0.55) — the v1.3.1 demo mug
    // rendered with a pale grey/white surface that read as a lid.
    // Roughness 0.7, not 0.35: the disc faces up and the camera looks down
    // at ~67 deg from its normal, where the Fresnel specular is strong —
    // at 0.35 the disc mirror-washed to pale grey-blue (cinematic) and
    // near-white (studio) by reflecting the cool fill light and fog, even
    // though the diffuse brown was correct; 0.7 spreads the specular lobe
    // so the diffuse brown reads with only a soft sheen. Specular IOR
    // Level is 0.0 (default 0.5): 0.7 alone only dimmed the wash to
    // grey-blue, so the mirror is removed entirely — a dark liquid in
    // this rig has no visible sheen once the mirror is gone, and a
    // mirror-washed disc reads as a lid.
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.09, 0.045, 0.02, 1)
bsdf.inputs["Roughness"].default_value = 0.7
bsdf.inputs["Metallic"].default_value = 0.0
bsdf.inputs["Specular IOR Level"].default_value = 0.0
`;
}
function ceramicScript(name) {
    // White glazed ceramic — the mug body. Same silent-fallback class as
    // coffee: "ceramic" had no builder and fell back to stone grey, which
    // only passed as white ceramic under bright studio light.
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.95, 0.95, 0.95, 1)
bsdf.inputs["Roughness"].default_value = 0.3
bsdf.inputs["Metallic"].default_value = 0.0
`;
}
function polishedSteelScript(name) {
    // Polished steel for small metal parts (yokes, rings, crowns) — NO
    // noise nodes. The `metal`/`steel` builders put Noise into roughness
    // + bump, which reads as a streaky/scratchy strip on a 5 mm yoke.
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.85, 0.85, 0.86, 1)
bsdf.inputs["Roughness"].default_value = 0.25
bsdf.inputs["Metallic"].default_value = 0.9
`;
}
function whiteScript(name) {
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.95, 0.95, 0.95, 1)
bsdf.inputs["Roughness"].default_value = 0.4
bsdf.inputs["Metallic"].default_value = 0.0
`;
}
function accentRedScript(name) {
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.65, 0.08, 0.08, 1)
bsdf.inputs["Roughness"].default_value = 0.5
bsdf.inputs["Metallic"].default_value = 0.0
`;
}
function blackScript(name) {
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1)
bsdf.inputs["Roughness"].default_value = 0.15
bsdf.inputs["Metallic"].default_value = 0.0
`;
}
// ---------------------------------------------------------------------------
// Cinematic materials (v1.4.0) — see research report §3.
//
// Scale note (research §3.9, the v1.3.0 strap lesson): every Noise/Voronoi
// scale below is tuned for its intended subject size in Generated
// coordinates (weathered_stone ~3 m head, wet_floor a large floor,
// brushed_aluminium a can lid). They are NOT size-derived: getMaterialScript
// receives no object size. If a builder is used on a wildly different
// scale, the grain will read wrong — that is a known gap, not a silent
// default (see report §9). The render preset's fog/hall/floor ARE
// size-derived from the hero bounding box.
// ---------------------------------------------------------------------------
function weatheredStoneScript(name) {
    // Weathered stone (the reference head): patchy colour, Voronoi cracks,
    // Pointiness edge wear, AO cavity grime, top dust — research §3.8.
    return nodeHeader(name) + `
# Patchy stone colour: large Noise -> warm grey-brown band.
stone_noise = nodes.new("ShaderNodeTexNoise")
stone_noise.location = (-600, 300)
stone_noise.inputs["Scale"].default_value = 4.0
stone_noise.inputs["Detail"].default_value = 3.0
links.new(texcoord.outputs["Generated"], stone_noise.inputs["Vector"])
stone_ramp = nodes.new("ShaderNodeValToRGB")
stone_ramp.location = (-400, 300)
stone_ramp.color_ramp.elements[0].position = 0.0
stone_ramp.color_ramp.elements[0].color = (0.55, 0.45, 0.32, 1)
stone_ramp.color_ramp.elements[1].position = 1.0
stone_ramp.color_ramp.elements[1].color = (0.78, 0.66, 0.48, 1)
links.new(stone_noise.outputs["Fac"], stone_ramp.inputs["Fac"])
# Thin dark cracks: Voronoi F1 distance -> ramp (dark at 0, white by 0.12).
vein = nodes.new("ShaderNodeTexVoronoi")
vein.location = (-600, 100)
vein.inputs["Scale"].default_value = 10.0
vein.feature = 'F1'
vein.distance = 'EUCLIDEAN'
links.new(texcoord.outputs["Generated"], vein.inputs["Vector"])
vein_ramp = nodes.new("ShaderNodeValToRGB")
vein_ramp.location = (-400, 100)
vein_ramp.color_ramp.elements[0].position = 0.0
vein_ramp.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1)
vein_ramp.color_ramp.elements[1].position = 1.0
vein_ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
vein_stop = vein_ramp.color_ramp.elements.new(0.12)
vein_stop.color = (1.0, 1.0, 1.0, 1)
links.new(vein.outputs["Distance"], vein_ramp.inputs["Fac"])
crack_mix = nodes.new("ShaderNodeMixRGB")
crack_mix.location = (-200, 200)
crack_mix.blend_type = 'MIX'
crack_mix.inputs[1].default_value = (0.12, 0.1, 0.08, 1)
links.new(vein_ramp.outputs["Color"], crack_mix.inputs[0])
links.new(stone_ramp.outputs["Color"], crack_mix.inputs[2])
# Edge wear: Pointiness (convex > 0.5, flat = 0.5) -> ramp (white > 0.65)
# x high-frequency Noise so the worn edge is patchy, not a perfect outline.
geom = nodes.new("ShaderNodeNewGeometry")
geom.location = (-600, -100)
wear_noise = nodes.new("ShaderNodeTexNoise")
wear_noise.location = (-600, -300)
wear_noise.inputs["Scale"].default_value = 25.0
wear_noise.inputs["Detail"].default_value = 2.0
links.new(texcoord.outputs["Generated"], wear_noise.inputs["Vector"])
wear_ramp = nodes.new("ShaderNodeValToRGB")
wear_ramp.location = (-400, -100)
wear_ramp.color_ramp.interpolation = 'EASE'
wear_ramp.color_ramp.elements[0].position = 0.5
wear_ramp.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1)
wear_ramp.color_ramp.elements[1].position = 0.65
wear_ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
links.new(geom.outputs["Pointiness"], wear_ramp.inputs["Fac"])
wear_mult = nodes.new("ShaderNodeMath")
wear_mult.location = (-200, -100)
wear_mult.operation = 'MULTIPLY'
links.new(wear_ramp.outputs["Color"], wear_mult.inputs[0])
links.new(wear_noise.outputs["Fac"], wear_mult.inputs[1])
wear_mix = nodes.new("ShaderNodeMixRGB")
wear_mix.location = (0, 200)
wear_mix.blend_type = 'MIX'
wear_mix.inputs[2].default_value = (0.92, 0.86, 0.74, 1)
links.new(wear_mult.outputs["Value"], wear_mix.inputs[0])
links.new(crack_mix.outputs["Color"], wear_mix.inputs[1])
# Cavity grime: AO (Distance = feature size) darkens crevices. The AO
# shader node is expensive in Cycles — it is used here, on the ONE hero
# stone material, never on every material in a scene.
ao = nodes.new("ShaderNodeAmbientOcclusion")
ao.location = (-400, -300)
ao.inputs["Distance"].default_value = 0.1
ao.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1)
grime_ramp = nodes.new("ShaderNodeValToRGB")
grime_ramp.location = (-200, -300)
grime_ramp.color_ramp.elements[0].position = 0.0
grime_ramp.color_ramp.elements[0].color = (0.6, 0.6, 0.6, 1)
grime_ramp.color_ramp.elements[1].position = 0.3
grime_ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1)
links.new(ao.outputs["Color"], grime_ramp.inputs["Fac"])
grime_mix = nodes.new("ShaderNodeMixRGB")
grime_mix.location = (200, 200)
grime_mix.blend_type = 'MULTIPLY'
grime_mix.inputs[1].default_value = (1.0, 1.0, 1.0, 1)
links.new(grime_ramp.outputs["Color"], grime_mix.inputs[2])
links.new(wear_mix.outputs["Color"], grime_mix.inputs[1])
links.new(grime_mix.outputs["Color"], bsdf.inputs["Base Color"])
# Bump from the same large noise (Distance 0.02 m — the 1.0 default is 1 m,
# far too big for products).
stone_bump = nodes.new("ShaderNodeBump")
stone_bump.location = (-200, -500)
stone_bump.inputs["Strength"].default_value = 0.3
stone_bump.inputs["Distance"].default_value = 0.02
links.new(stone_noise.outputs["Fac"], stone_bump.inputs["Height"])
links.new(stone_bump.outputs["Normal"], bsdf.inputs["Normal"])
bsdf.inputs["Roughness"].default_value = 0.85
`;
}
function brushedAluminiumScript(name) {
    // Brushed aluminium (can lids, rims, bases — NOT the printed body):
    // Metallic 1.0, Anisotropic 0.9, Radial-Z tangent (circular brushing on
    // a disc), stretched Noise -> Roughness (0.3-0.4) + Bump. Anisotropic is
    // Cycles-only — EEVEE silently ignores it; the stretched-roughness grain
    // is kept anyway so the brushed cue survives in EEVEE too.
    return nodeHeader(name) + `
# Stretched noise: Mapping scale (1, 200, 1) elongates the cells into
# brush streaks along one axis.
brush_map = nodes.new("ShaderNodeMapping")
brush_map.location = (-700, 200)
brush_map.inputs["Scale"].default_value = (1.0, 200.0, 1.0)
links.new(texcoord.outputs["Generated"], brush_map.inputs["Vector"])
brush_noise = nodes.new("ShaderNodeTexNoise")
brush_noise.location = (-600, 200)
brush_noise.inputs["Scale"].default_value = 8.0
brush_noise.inputs["Detail"].default_value = 2.0
links.new(brush_map.outputs["Vector"], brush_noise.inputs["Vector"])
brush_ramp = nodes.new("ShaderNodeValToRGB")
brush_ramp.location = (-400, 200)
brush_ramp.color_ramp.elements[0].position = 0.0
brush_ramp.color_ramp.elements[0].color = (0.3, 0.3, 0.3, 1)
brush_ramp.color_ramp.elements[1].position = 1.0
brush_ramp.color_ramp.elements[1].color = (0.4, 0.4, 0.4, 1)
links.new(brush_noise.outputs["Fac"], brush_ramp.inputs["Fac"])
links.new(brush_ramp.outputs["Color"], bsdf.inputs["Roughness"])
brush_bump = nodes.new("ShaderNodeBump")
brush_bump.location = (-400, -200)
brush_bump.inputs["Strength"].default_value = 0.3
brush_bump.inputs["Distance"].default_value = 0.01
links.new(brush_noise.outputs["Fac"], brush_bump.inputs["Height"])
links.new(brush_bump.outputs["Normal"], bsdf.inputs["Normal"])
# Circular brushing on a disc: Tangent node, Radial, axis Z.
tangent = nodes.new("ShaderNodeTangent")
tangent.location = (-400, 0)
tangent.direction_type = 'RADIAL'
tangent.axis = 'Z'
links.new(tangent.outputs["Tangent"], bsdf.inputs["Tangent"])
bsdf.inputs["Base Color"].default_value = (0.85, 0.85, 0.86, 1)
bsdf.inputs["Metallic"].default_value = 1.0
bsdf.inputs["Anisotropic"].default_value = 0.9
bsdf.inputs["Anisotropic Rotation"].default_value = 0.25
`;
}
function printedCanScript(name) {
    // Printed drink-can body — THE printed-can rule, encoded, not a
    // suggestion: a printed can is paint/lacquer over aluminium, NOT
    // anodised colour. Metallic 1.0 + a coloured Base Color renders dark
    // and desaturated (metallic tints only the specular; there is no
    // diffuse). Correct: Metallic 0.0 + label artwork in Base Color + a
    // clear Coat (Weight 1.0, Roughness 0.08, IOR 1.5) as the lacquer over
    // the print. Default colour is matte black; the label texture is applied
    // by the caller (apply_label / image texture in Base Color). Metallic
    // 1.0 belongs only on unprinted metal: lid/rim/tab/base — see
    // brushed_aluminium / polished_steel.
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.03, 0.03, 0.04, 1)
bsdf.inputs["Roughness"].default_value = 0.3
bsdf.inputs["Metallic"].default_value = 0.0
bsdf.inputs["Coat Weight"].default_value = 1.0
bsdf.inputs["Coat Roughness"].default_value = 0.08
bsdf.inputs["Coat IOR"].default_value = 1.5
`;
}
function wetFloorScript(name) {
    // Wet reflective floor as a named material (the render preset builds
    // the same node tree inline for the ground plane): Noise puddle mask ->
    // Roughness (puddle 0.02, dry 0.6) + wet darkening in Base Color + a
    // little bump so reflections ripple instead of mirroring perfectly.
    // Never pure-white dry roughness; never exactly 0.0 puddle roughness
    // over a large area. Scale is tuned for Generated coordinates on a
    // large floor (see the scale note at the top of this section).
    return nodeHeader(name) + `
floor_noise = nodes.new("ShaderNodeTexNoise")
floor_noise.location = (-600, 200)
floor_noise.inputs["Scale"].default_value = 8.0
floor_noise.inputs["Detail"].default_value = 3.0
links.new(texcoord.outputs["Generated"], floor_noise.inputs["Vector"])
floor_ramp = nodes.new("ShaderNodeValToRGB")
floor_ramp.location = (-400, 200)
floor_ramp.color_ramp.elements[0].position = 0.45
floor_ramp.color_ramp.elements[0].color = (0.02, 0.02, 0.02, 1)
floor_ramp.color_ramp.elements[1].position = 0.62
floor_ramp.color_ramp.elements[1].color = (0.6, 0.6, 0.6, 1)
links.new(floor_noise.outputs["Fac"], floor_ramp.inputs["Fac"])
links.new(floor_ramp.outputs["Color"], bsdf.inputs["Roughness"])
floor_cramp = nodes.new("ShaderNodeValToRGB")
floor_cramp.location = (-400, 0)
floor_cramp.color_ramp.elements[0].position = 0.45
floor_cramp.color_ramp.elements[0].color = (0.008, 0.008, 0.01, 1)
floor_cramp.color_ramp.elements[1].position = 0.62
floor_cramp.color_ramp.elements[1].color = (0.02, 0.02, 0.022, 1)
links.new(floor_noise.outputs["Fac"], floor_cramp.inputs["Fac"])
links.new(floor_cramp.outputs["Color"], bsdf.inputs["Base Color"])
floor_bump = nodes.new("ShaderNodeBump")
floor_bump.location = (-400, -200)
floor_bump.inputs["Strength"].default_value = 0.05
floor_bump.inputs["Distance"].default_value = 0.01
links.new(floor_noise.outputs["Fac"], floor_bump.inputs["Height"])
links.new(floor_bump.outputs["Normal"], bsdf.inputs["Normal"])
bsdf.inputs["Metallic"].default_value = 0.0
`;
}
function emissiveScript(name, color = [0.0, 0.85, 1.0], strength = 3.0) {
    // Emissive glow material (rings, strips, logos). Emission Strength
    // 2-5 for a can ring, 5-10 for hero strips; 1.0 is flat colour, not
    // glow; never exceed 10 on a large area in Cycles (fireflies). The
    // glow itself needs a Compositor Glare node to bloom — emission alone
    // does not bloom in Cycles (see the cinematic render preset).
    // Python repr parity: integral floats print as "3.0" in Python but "3"
    // in JS — keep the generated scripts byte-identical across servers.
    const pyNum = (n) => (Number.isInteger(n) ? `${n}.0` : String(n));
    return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.01, 0.01, 0.01, 1)
bsdf.inputs["Emission Color"].default_value = (${pyNum(color[0])}, ${pyNum(color[1])}, ${pyNum(color[2])}, 1)
bsdf.inputs["Emission Strength"].default_value = ${pyNum(strength)}
`;
}
const NODE_BUILDERS = {
    wood: woodScript,
    marble: (n) => marbleScript(n),
    red_marble: (n) => marbleScript(n, [0.8, 0.3, 0.25], [0.35, 0.08, 0.06]),
    green_marble: (n) => marbleScript(n, [0.2, 0.5, 0.3], [0.05, 0.2, 0.1]),
    metal: metalScript,
    gold: (n) => metalScript(n, [1.0, 0.76, 0.33]),
    copper: (n) => metalScript(n, [0.95, 0.64, 0.54]),
    brass: (n) => metalScript(n, [0.85, 0.7, 0.3]),
    steel: (n) => metalScript(n, [0.85, 0.85, 0.86], 0.9, 0.3, 0.4),
    fabric: fabricScript,
    smooth_leather: smoothLeatherScript,
    brown_leather: (n) => smoothLeatherScript(n, [0.32, 0.20, 0.12]),
    black_leather: (n) => smoothLeatherScript(n, [0.05, 0.05, 0.05]),
    matte_plastic: mattePlasticScript,
    rubber: rubberScript,
    white_leather: whiteLeatherScript,
    amber_liquid: amberLiquidScript,
    coffee: coffeeScript,
    ceramic: ceramicScript,
    polished_steel: polishedSteelScript,
    white: whiteScript,
    accent_red: accentRedScript,
    glass: glassScript,
    skin: skinScript,
    sandstone: sandstoneScript,
    stone: (n) => sandstoneScript(n, [0.55, 0.53, 0.5], [0.68, 0.66, 0.63]),
    terracotta: (n) => sandstoneScript(n, [0.72, 0.4, 0.26], [0.85, 0.52, 0.34]),
    black: blackScript,
    // Cinematic (v1.4.0).
    weathered_stone: weatheredStoneScript,
    brushed_aluminium: brushedAluminiumScript,
    printed_can: printedCanScript,
    wet_floor: wetFloorScript,
    emissive_teal: (n) => emissiveScript(n, [0.0, 0.85, 1.0], 3.0),
    emissive_amber: (n) => emissiveScript(n, [1.0, 0.55, 0.2], 3.0),
};
/**
 * Generate a procedural material script. Returns a bpy snippet that creates
 * a material named after `materialType` and leaves it in the `mat`
 * variable. Known names get a Principled BSDF node tree; unknown names
 * fall back to a flat Principled colour (stone grey).
 */
export function getMaterialScript(materialType) {
    const key = (materialType || '').toLowerCase().trim();
    const builder = NODE_BUILDERS[key];
    if (builder)
        return builder(materialType);
    const mat = MATERIALS.stone;
    return `
mat = bpy.data.materials.new(name=${JSON.stringify(materialType)})
mat.use_nodes = True
nodes = mat.node_tree.nodes
nodes["Principled BSDF"].inputs["Base Color"].default_value = ${JSON.stringify(mat.baseColor)}
nodes["Principled BSDF"].inputs["Roughness"].default_value = ${mat.roughness}
nodes["Principled BSDF"].inputs["Metallic"].default_value = ${mat.metallic}
`;
}
// ---------------------------------------------------------------------------
// Smart UV
// ---------------------------------------------------------------------------
/**
 * Blender snippet: Smart UV Project every object in `targets`.
 * Run before any image-texture application. Angle limit 66 degrees
 * (converted to radians — the operator takes radians), island margin 0.02.
 */
export function getSmartUVScript() {
    return `
for obj in targets:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)
`;
}
// ---------------------------------------------------------------------------
// Poly Haven textures
// ---------------------------------------------------------------------------
export const POLYHAVEN_API = 'https://api.polyhaven.com';
export const POLYHAVEN_USER_AGENT = 'blender-mcp/1.4.0 (https://github.com/IamNishant51/Blender-MCP)';
export const POLYHAVEN_LICENCE = 'CC0';
/**
 * Pick the 1k map URLs out of a GET /files/<slug> response. Returns
 * {role: url} for the roles we wire: color, roughness (or
 * roughness_from_arm), normal, displacement, ao. Throws when no usable
 * maps exist at the requested resolution.
 */
export function pickPolyhavenMaps(files, resolution = '1k') {
    const urlFor = (mapKey, fmt = 'jpg') => {
        const entry = files[mapKey];
        if (!entry || typeof entry !== 'object')
            return null;
        const res = entry[resolution];
        if (!res || typeof res !== 'object')
            return null;
        const fmtEntry = res[fmt] || res.png || res.exr;
        return fmtEntry?.url ?? null;
    };
    const maps = {};
    const color = urlFor('Diffuse');
    if (color)
        maps.color = color;
    const rough = urlFor('Rough');
    if (rough)
        maps.roughness = rough;
    else {
        const arm = urlFor('arm');
        if (arm)
            maps.roughness_from_arm = arm;
    }
    const normal = urlFor('nor_gl');
    if (normal)
        maps.normal = normal;
    const disp = urlFor('Displacement');
    if (disp)
        maps.displacement = disp;
    const ao = urlFor('AO');
    if (ao)
        maps.ao = ao;
    if (Object.keys(maps).length === 0) {
        throw new Error(`No usable ${resolution} maps found for this asset`);
    }
    if (!maps.color) {
        throw new Error(`No ${resolution} Diffuse (colour) map found for this asset`);
    }
    return maps;
}
/**
 * Blender snippet: build a Principled material from downloaded maps
 * (`maps` is {role: local_file_path}). Colour space is set correctly
 * (sRGB for colour, Non-Color for data maps), normals go through a
 * Normal Map node, ARM textures are split with SeparateRGB, images are
 * packed into the .blend, and provenance is written as custom properties
 * on the material. Leaves the material in `mat`.
 */
export function buildPolyhavenMaterialScript(slug, maps, materialName) {
    const lines = [`
mat = bpy.data.materials.new(name=${JSON.stringify(materialName)})
mat.use_nodes = True
nt = mat.node_tree
nodes = nt.nodes
links = nt.links
bsdf = nodes["Principled BSDF"]
texcoord = nodes.new("ShaderNodeTexCoord")
texcoord.location = (-800, 0)
mapping = nodes.new("ShaderNodeMapping")
mapping.location = (-600, 0)
links.new(texcoord.outputs["Generated"], mapping.inputs["Vector"])
`];
    let y = 300;
    const imageNode = (role, path, colorspace) => {
        const s = `
img_${role} = nodes.new("ShaderNodeTexImage")
img_${role}.location = (-400, ${y})
img_${role}.image = bpy.data.images.load(${JSON.stringify(path)})
img_${role}.image.colorspace_settings.name = ${JSON.stringify(colorspace)}
img_${role}.image.pack()
links.new(mapping.outputs["Vector"], img_${role}.inputs["Vector"])
`;
        y -= 250;
        return s;
    };
    if (maps.color) {
        lines.push(imageNode('color', maps.color, 'sRGB'));
        if (maps.ao) {
            lines.push(imageNode('ao', maps.ao, 'Non-Color'));
            lines.push(`
mix_ao = nodes.new("ShaderNodeMixRGB")
mix_ao.blend_type = 'MULTIPLY'
mix_ao.inputs[0].default_value = 1.0
links.new(img_color.outputs["Color"], mix_ao.inputs[1])
links.new(img_ao.outputs["Color"], mix_ao.inputs[2])
links.new(mix_ao.outputs["Color"], bsdf.inputs["Base Color"])
`);
        }
        else {
            lines.push('links.new(img_color.outputs["Color"], bsdf.inputs["Base Color"])');
        }
    }
    if (maps.roughness) {
        lines.push(imageNode('roughness', maps.roughness, 'Non-Color'));
        lines.push('links.new(img_roughness.outputs["Color"], bsdf.inputs["Roughness"])');
    }
    if (maps.roughness_from_arm) {
        lines.push(imageNode('arm', maps.roughness_from_arm, 'Non-Color'));
        lines.push(`
arm_split = nodes.new("ShaderNodeSeparateRGB")
arm_split.location = (-150, 0)
links.new(img_arm.outputs["Color"], arm_split.inputs["Image"])
links.new(arm_split.outputs["G"], bsdf.inputs["Roughness"])
links.new(arm_split.outputs["B"], bsdf.inputs["Metallic"])
`);
    }
    if (maps.normal) {
        lines.push(imageNode('normal', maps.normal, 'Non-Color'));
        lines.push(`
normal_map = nodes.new("ShaderNodeNormalMap")
normal_map.location = (-150, -250)
links.new(img_normal.outputs["Color"], normal_map.inputs["Color"])
links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
`);
    }
    if (maps.displacement) {
        lines.push(imageNode('displacement', maps.displacement, 'Non-Color'));
        lines.push(`
disp = nodes.new("ShaderNodeDisplacement")
disp.location = (-150, -500)
disp.inputs["Scale"].default_value = 0.1
links.new(img_displacement.outputs["Color"], disp.inputs["Height"])
links.new(disp.outputs["Displacement"], nt.nodes["Material Output"].inputs["Displacement"])
`);
    }
    lines.push(`
# Provenance (Poly Haven, CC0) — written onto the material.
mat["polyhaven_id"] = ${JSON.stringify(slug)}
mat["polyhaven_url"] = ${JSON.stringify('https://polyhaven.com/textures/' + slug)}
mat["polyhaven_licence"] = ${JSON.stringify(POLYHAVEN_LICENCE)}
`);
    return lines.join('\n');
}
//# sourceMappingURL=model.js.map