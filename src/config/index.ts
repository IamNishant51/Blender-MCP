/**
 * Configuration for Blender MCP Server
 */

export interface ServerConfig {
  name: string;
  version: string;
  blender: BlenderConfig;
  paths: PathsConfig;
  search: SearchConfig;
  debug: boolean;
}

export interface BlenderConfig {
  executable: string;
  timeout: number;
  backgroundMode: boolean;
}

export interface PathsConfig {
  baseDir: string;
  tempDir: string;
  outputDir: string;
  textureDir: string;
  logDir: string;
}

export interface SearchConfig {
  sketchfabLimit: number;
  googleLimit: number;
  polyPizzaLimit: number;
  timeout: number;
}

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

export function getConfig(): ServerConfig {
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