/**
 * Logging utilities for Blender MCP Server
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export declare class Logger {
    private name;
    private level;
    constructor(name: string, level?: LogLevel);
    private shouldLog;
    private formatMessage;
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
export declare function createLogger(name: string, debug?: boolean): Logger;
//# sourceMappingURL=logger.d.ts.map