/**
 * Configuration for Blender MCP Server
 */
function getEnv(key, defaultValue) {
    return process.env[key] || defaultValue;
}
function getEnvInt(key, defaultValue) {
    const value = process.env[key];
    return value ? parseInt(value, 10) : defaultValue;
}
export function getConfig() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const baseDir = getEnv('BLENDER_MCP_DIR', `${homeDir}/Desktop/BLENDER-MCP`);
    return {
        name: 'blender-copilot',
        version: '1.0.0',
        debug: getEnv('BLENDER_MCP_DEBUG', 'false').toLowerCase() === 'true',
        blender: {
            executable: getEnv('BLENDER_EXECUTABLE', 'blender'),
            timeout: getEnvInt('BLENDER_TIMEOUT', 120),
            backgroundMode: true,
        },
        paths: {
            baseDir,
            tempDir: `${baseDir}/.temp`,
            outputDir: `${baseDir}/output`,
            textureDir: `${baseDir}/textures`,
            logDir: `${baseDir}/logs`,
        },
        search: {
            sketchfabLimit: 5,
            googleLimit: 5,
            polyPizzaLimit: 5,
            timeout: 12,
        },
    };
}
// Default config instance
export const config = getConfig();
//# sourceMappingURL=index.js.map