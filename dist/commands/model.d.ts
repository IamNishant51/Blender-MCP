/**
 * Model Builder - Creates 3D models by executing Blender scripts
 */
import type { BlenderConfig, PathsConfig } from '../config/index.js';
export interface ModelResult {
    success: boolean;
    output?: string;
    error?: string;
    texture?: string;
    stdout?: string;
    objects?: Array<{
        name: string;
        min: number[];
        max: number[];
    }>;
    scene_min?: number[];
    scene_max?: number[];
    min_z?: number;
    renders?: Array<{
        view: string;
        path: string;
        size_bytes: number;
    }>;
    polyhaven?: {
        slug: string;
        url: string;
        licence: string;
    };
}
/** Blender snippet appended to a build script: prints object + scene bounds as JSON. */
export declare const BOUNDS_SNIPPET = "\nimport bpy, json\nfrom mathutils import Vector\nbpy.context.view_layer.update()  # flush scale/location edits into matrix_world\n_objs = []\nfor o in bpy.data.objects:\n    if o.type == 'MESH':\n        corners = [o.matrix_world @ Vector(c) for c in o.bound_box]\n        xs = [v.x for v in corners]; ys = [v.y for v in corners]; zs = [v.z for v in corners]\n        _objs.append({\"name\": o.name, \"min\": [min(xs), min(ys), min(zs)], \"max\": [max(xs), max(ys), max(zs)]})\n_all_min = [min(o[\"min\"][i] for o in _objs) for i in range(3)] if _objs else [0, 0, 0]\n_all_max = [max(o[\"max\"][i] for o in _objs) for i in range(3)] if _objs else [0, 0, 0]\nprint(\"BLENDER_BOUNDS_JSON:\" + json.dumps({\"objects\": _objs, \"scene_min\": _all_min, \"scene_max\": _all_max, \"scene_size\": [_all_max[i] - _all_min[i] for i in range(3)]}))\n";
export declare class ModelBuilder {
    private blender;
    private paths;
    private logger;
    constructor(blender: BlenderConfig, paths: PathsConfig);
    private ensureDirectories;
    createMesh(script: string): Promise<ModelResult>;
    /**
     * Like createMesh, but also returns the built objects' names and
     * bounding boxes (parsed from the BOUNDS_SNIPPET line Blender prints).
     * Used by build_from_spec: the caller needs numbers, not just exit 0.
     */
    createMeshWithReport(script: string): Promise<ModelResult>;
    /**
     * Render a saved .blend with the presentation preset (see render.ts).
     * Every PNG is verified to exist on disk and be non-empty before
     * success is reported — a missing/empty PNG is success:false.
     * `outputPrefix` is a file path prefix; each view renders to
     * `<prefix>_<view>.png` (a trailing .png/.blend extension is stripped).
     */
    renderModel(blendPath: string, outputPrefix: string, views: string[], options?: import('./render.js').RenderOptions): Promise<ModelResult>;
    /** Run Blender with an arbitrary argument list (e.g. --background <blend> --python ...).
     * `timeoutSeconds` overrides the configured timeout; renders pass a
     * higher floor because EEVEE on software GL is slow (~1 min/view). */
    runBlenderArgs(args: string[], timeoutSeconds?: number): Promise<{
        success: boolean;
        error?: string;
        stdout?: string;
    }>;
    private runBlender;
    private openInBlender;
}
export declare function parseBoundsJson(stdout: string): {
    objects: Array<{
        name: string;
        min: number[];
        max: number[];
    }>;
    scene_min: number[];
    scene_max: number[];
    scene_size: number[];
} | null;
export declare const MATERIALS: Record<string, {
    baseColor: [number, number, number, number];
    roughness: number;
    metallic: number;
}>;
/**
 * Generate a procedural material script. Returns a bpy snippet that creates
 * a material named after `materialType` and leaves it in the `mat`
 * variable. Known names get a Principled BSDF node tree; unknown names
 * fall back to a flat Principled colour (stone grey).
 */
export declare function getMaterialScript(materialType: string): string;
/**
 * Blender snippet: Smart UV Project every object in `targets`.
 * Run before any image-texture application. Angle limit 66 degrees
 * (converted to radians — the operator takes radians), island margin 0.02.
 */
export declare function getSmartUVScript(): string;
export declare const POLYHAVEN_API = "https://api.polyhaven.com";
export declare const POLYHAVEN_USER_AGENT = "blender-mcp/1.3.0 (https://github.com/IamNishant51/Blender-MCP)";
export declare const POLYHAVEN_LICENCE = "CC0";
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
export declare function pickPolyhavenMaps(files: Record<string, unknown>, resolution?: string): PolyHavenMaps;
/**
 * Blender snippet: build a Principled material from downloaded maps
 * (`maps` is {role: local_file_path}). Colour space is set correctly
 * (sRGB for colour, Non-Color for data maps), normals go through a
 * Normal Map node, ARM textures are split with SeparateRGB, images are
 * packed into the .blend, and provenance is written as custom properties
 * on the material. Leaves the material in `mat`.
 */
export declare function buildPolyhavenMaterialScript(slug: string, maps: PolyHavenMaps, materialName: string): string;
//# sourceMappingURL=model.d.ts.map