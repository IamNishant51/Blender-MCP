/**
 * Model Builder - Creates 3D models by executing Blender scripts
 */
import type { BlenderConfig, PathsConfig } from '../config/index.js';
export interface ModelResult {
    success: boolean;
    output?: string;
    error?: string;
    texture?: string;
}
export declare class ModelBuilder {
    private blender;
    private paths;
    private logger;
    constructor(blender: BlenderConfig, paths: PathsConfig);
    private ensureDirectories;
    createMesh(script: string): Promise<ModelResult>;
    private runBlender;
    private openInBlender;
}
export declare const MATERIALS: Record<string, {
    baseColor: [number, number, number, number];
    roughness: number;
    metallic: number;
}>;
export declare function getMaterialScript(materialType: string): string;
//# sourceMappingURL=model.d.ts.map