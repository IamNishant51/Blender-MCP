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
export declare function getConfig(): ServerConfig;
export declare const config: ServerConfig;
//# sourceMappingURL=index.d.ts.map