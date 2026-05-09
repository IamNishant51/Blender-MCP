/**
 * Model Builder - Creates 3D models by executing Blender scripts
 */
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
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
                return { success: true, output: outputPath };
            }
            else {
                this.logger.error(`Blender script failed: ${result.error}`);
                return { success: false, error: result.error };
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
    runBlender(scriptPath) {
        return new Promise((resolve) => {
            const args = ['--background', '--python', scriptPath];
            this.logger.debug(`Running: ${this.blender.executable} ${args.join(' ')}`);
            const proc = spawn(this.blender.executable, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            proc.stdout?.on('data', (data) => {
                stdout += data.toString();
            });
            proc.stderr?.on('data', (data) => {
                stderr += data.toString();
            });
            const timeout = setTimeout(() => {
                proc.kill();
                resolve({ success: false, error: 'Execution timed out' });
            }, this.blender.timeout * 1000);
            proc.on('close', (code) => {
                clearTimeout(timeout);
                if (code === 0) {
                    resolve({ success: true });
                }
                else {
                    resolve({ success: false, error: stderr || `Process exited with code ${code}` });
                }
            });
            proc.on('error', (error) => {
                clearTimeout(timeout);
                if (error.message.includes('ENOENT')) {
                    resolve({ success: false, error: 'Blender executable not found' });
                }
                else {
                    resolve({ success: false, error: error.message });
                }
            });
        });
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
// Material definitions
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
};
export function getMaterialScript(materialType) {
    const mat = MATERIALS[materialType.toLowerCase()] || MATERIALS.stone;
    return `
mat = bpy.data.materials.new(name="${materialType}")
mat.use_nodes = True
nodes = mat.node_tree.nodes
nodes["Principled BSDF"].inputs["Base Color"].default_value = ${JSON.stringify(mat.baseColor)}
nodes["Principled BSDF"].inputs["Roughness"].default_value = ${mat.roughness}
nodes["Principled BSDF"].inputs["Metallic"].default_value = ${mat.metallic}
`;
}
//# sourceMappingURL=model.js.map