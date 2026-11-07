/**
 * Model Builder - Creates 3D models by executing Blender scripts
 */

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../utils/logger.js';
import type { BlenderConfig, PathsConfig } from '../config/index.js';
import { buildRenderScript } from './render.js';

export interface ModelResult {
  success: boolean;
  output?: string;
  error?: string;
  texture?: string;
  stdout?: string;
  objects?: Array<{ name: string; min: number[]; max: number[] }>;
  scene_min?: number[];
  scene_max?: number[];
  min_z?: number;
  renders?: Array<{ view: string; path: string; size_bytes: number }>;
  polyhaven?: { slug: string; url: string; licence: string };
}

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
  private blender: BlenderConfig;
  private paths: PathsConfig;
  private logger = createLogger('model');

  constructor(blender: BlenderConfig, paths: PathsConfig) {
    this.blender = blender;
    this.paths = paths;

    // Ensure directories exist
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    for (const dir of [this.paths.tempDir, this.paths.outputDir]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  async createMesh(script: string): Promise<ModelResult> {
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
      } else {
        this.logger.error(`Blender script failed: ${result.error}`);
        return { success: false, error: result.error, stdout: result.stdout?.slice(-2000) };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Model creation failed: ${message}`);
      return { success: false, error: message };
    } finally {
      try {
        unlinkSync(scriptPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Like createMesh, but also returns the built objects' names and
   * bounding boxes (parsed from the BOUNDS_SNIPPET line Blender prints).
   * Used by build_from_spec: the caller needs numbers, not just exit 0.
   */
  async createMeshWithReport(script: string): Promise<ModelResult> {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    } finally {
      try {
        unlinkSync(scriptPath);
      } catch {
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
  async renderModel(blendPath: string, outputPrefix: string, views: string[]): Promise<ModelResult> {
    if (!existsSync(blendPath)) {
      return { success: false, error: `Blend file not found: ${blendPath}` };
    }
    let script: string;
    try {
      script = buildRenderScript(views);
    } catch (error) {
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
      // Renders are slow on software GL (~1 min/view at 960x720); give
      // them at least 600 s no matter what the build timeout is.
      const result = await this.runBlenderArgs([
        '--background', blendPath, '--python', scriptPath, '--', prefix, ...views,
      ], Math.max(this.blender.timeout, 600));
      if (!result.success) {
        this.logger.error(`Render failed: ${result.error}`);
        return { success: false, error: result.error, stdout: result.stdout?.slice(-2000) };
      }
      const renders: Array<{ view: string; path: string; size_bytes: number }> = [];
      for (const view of views) {
        const pngPath = `${prefix}_${view}.png`;
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
    } finally {
      try {
        unlinkSync(scriptPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /** Run Blender with an arbitrary argument list (e.g. --background <blend> --python ...).
   * `timeoutSeconds` overrides the configured timeout; renders pass a
   * higher floor because EEVEE on software GL is slow (~1 min/view). */
  runBlenderArgs(args: string[], timeoutSeconds?: number): Promise<{ success: boolean; error?: string; stdout?: string }> {
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
        if (code === 0) resolve({ success: true, stdout });
        else resolve({ success: false, error: stderr || `Process exited with code ${code}`, stdout });
      });
      proc.on('error', (error) => {
        clearTimeout(timeout);
        if (error.message.includes('ENOENT')) resolve({ success: false, error: 'Blender executable not found', stdout });
        else resolve({ success: false, error: error.message, stdout });
      });
    });
  }

  private runBlender(scriptPath: string): Promise<{ success: boolean; error?: string; stdout?: string }> {
    return this.runBlenderArgs(['--background', '--python', scriptPath]);
  }

  private openInBlender(filePath: string): void {
    try {
      spawn(this.blender.executable, [filePath], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } catch {
      // Ignore errors - opening is non-critical
    }
  }
}

export function parseBoundsJson(stdout: string): {
  objects: Array<{ name: string; min: number[]; max: number[] }>;
  scene_min: number[];
  scene_max: number[];
  scene_size: number[];
} | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('BLENDER_BOUNDS_JSON:')) {
      try {
        return JSON.parse(line.slice('BLENDER_BOUNDS_JSON:'.length));
      } catch {
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
export const MATERIALS: Record<string, { baseColor: [number, number, number, number]; roughness: number; metallic: number }> = {
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
};

function nodeHeader(name: string): string {
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

function noiseBlock(scale: number, detail = 2.0, roughness = 0.7): string {
  return `
noise = nodes.new("ShaderNodeTexNoise")
noise.location = (-600, 200)
noise.inputs["Scale"].default_value = ${scale}
noise.inputs["Detail"].default_value = ${detail}
noise.inputs["Roughness"].default_value = ${roughness}
links.new(texcoord.outputs["Generated"], noise.inputs["Vector"])
`;
}

function rampBlock(c0: number[], c1: number[]): string {
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

function bumpBlock(strength: number, distance = 0.1): string {
  return `
bump = nodes.new("ShaderNodeBump")
bump.location = (-400, -200)
bump.inputs["Strength"].default_value = ${strength}
bump.inputs["Distance"].default_value = ${distance}
links.new(noise.outputs["Fac"], bump.inputs["Height"])
links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
`;
}

function woodScript(name: string): string {
  return nodeHeader(name) + noiseBlock(5.0)
    + rampBlock([0.23, 0.12, 0.05], [0.55, 0.36, 0.19]) + bumpBlock(0.3)
    + `
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.7
`;
}

function marbleScript(name: string, base: number[] = [0.93, 0.93, 0.92], vein: number[] = [0.15, 0.15, 0.16]): string {
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
bsdf.inputs["Subsurface Color"].default_value = ${JSON.stringify([...base, 1])}
`;
}

function metalScript(name: string, tint: number[] = [0.8, 0.8, 0.82], metallic = 1.0, roughLo = 0.2, roughHi = 0.4): string {
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

function fabricScript(name: string, base: number[] = [0.85, 0.8, 0.72]): string {
  return nodeHeader(name) + noiseBlock(25.0) + bumpBlock(0.15) + `
bsdf.inputs["Base Color"].default_value = ${JSON.stringify([...base, 1])}
bsdf.inputs["Roughness"].default_value = 0.9
bsdf.inputs["Sheen Weight"].default_value = 1.0
bsdf.inputs["Sheen Roughness"].default_value = 0.5
`;
}

function glassScript(name: string): string {
  return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1)
bsdf.inputs["Roughness"].default_value = 0.05
bsdf.inputs["Transmission Weight"].default_value = 1.0
bsdf.inputs["IOR"].default_value = 1.45
`;
}

function skinScript(name: string): string {
  return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.55, 0.35, 0.25, 1)
bsdf.inputs["Roughness"].default_value = 0.6
bsdf.inputs["Subsurface Weight"].default_value = 0.4
bsdf.inputs["Subsurface Color"].default_value = (0.45, 0.2, 0.12, 1)
bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.2, 0.1)
`;
}

function sandstoneScript(name: string, dark: number[] = [0.75, 0.6, 0.35], light: number[] = [0.9, 0.78, 0.55]): string {
  return nodeHeader(name) + noiseBlock(8.0)
    + rampBlock(dark, light) + bumpBlock(0.4)
    + `
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.9
`;
}

function blackScript(name: string): string {
  return nodeHeader(name) + `
bsdf.inputs["Base Color"].default_value = (0.02, 0.02, 0.02, 1)
bsdf.inputs["Roughness"].default_value = 0.15
bsdf.inputs["Metallic"].default_value = 0.0
`;
}

const NODE_BUILDERS: Record<string, (name: string) => string> = {
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
  glass: glassScript,
  skin: skinScript,
  sandstone: sandstoneScript,
  stone: (n) => sandstoneScript(n, [0.55, 0.53, 0.5], [0.68, 0.66, 0.63]),
  terracotta: (n) => sandstoneScript(n, [0.72, 0.4, 0.26], [0.85, 0.52, 0.34]),
  black: blackScript,
};

/**
 * Generate a procedural material script. Returns a bpy snippet that creates
 * a material named after `materialType` and leaves it in the `mat`
 * variable. Known names get a Principled BSDF node tree; unknown names
 * fall back to a flat Principled colour (stone grey).
 */
export function getMaterialScript(materialType: string): string {
  const key = (materialType || '').toLowerCase().trim();
  const builder = NODE_BUILDERS[key];
  if (builder) return builder(materialType);
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
export function getSmartUVScript(): string {
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
export const POLYHAVEN_USER_AGENT = 'blender-mcp/1.2.0 (https://github.com/IamNishant51/Blender-MCP)';
export const POLYHAVEN_LICENCE = 'CC0';

export interface PolyHavenMaps {
  color?: string;
  roughness?: string;
  roughness_from_arm?: string;
  normal?: string;
  displacement?: string;
  ao?: string;
}

/**
 * Pick the 1k map URLs out of a GET /files/<slug> response. Returns
 * {role: url} for the roles we wire: color, roughness (or
 * roughness_from_arm), normal, displacement, ao. Throws when no usable
 * maps exist at the requested resolution.
 */
export function pickPolyhavenMaps(files: Record<string, unknown>, resolution = '1k'): PolyHavenMaps {
  const urlFor = (mapKey: string, fmt = 'jpg'): string | null => {
    const entry = files[mapKey] as Record<string, Record<string, { url?: string }>> | undefined;
    if (!entry || typeof entry !== 'object') return null;
    const res = entry[resolution];
    if (!res || typeof res !== 'object') return null;
    const fmtEntry = res[fmt] || res.png || res.exr;
    return fmtEntry?.url ?? null;
  };
  const maps: PolyHavenMaps = {};
  const color = urlFor('Diffuse');
  if (color) maps.color = color;
  const rough = urlFor('Rough');
  if (rough) maps.roughness = rough;
  else {
    const arm = urlFor('arm');
    if (arm) maps.roughness_from_arm = arm;
  }
  const normal = urlFor('nor_gl');
  if (normal) maps.normal = normal;
  const disp = urlFor('Displacement');
  if (disp) maps.displacement = disp;
  const ao = urlFor('AO');
  if (ao) maps.ao = ao;
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
export function buildPolyhavenMaterialScript(slug: string, maps: PolyHavenMaps, materialName: string): string {
  const lines: string[] = [`
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
  const imageNode = (role: string, path: string, colorspace: string): string => {
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
    } else {
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
