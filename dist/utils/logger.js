/**
 * Logging utilities for Blender MCP Server
 */
const LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
const COLORS = {
    debug: '\x1b[36m',
    info: '\x1b[32m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
};
const RESET = '\x1b[0m';
export class Logger {
    name;
    level;
    constructor(name, level = 'info') {
        this.name = name;
        this.level = level;
    }
    shouldLog(level) {
        return LEVELS[level] >= LEVELS[this.level];
    }
    formatMessage(level, message) {
        const color = COLORS[level];
        const time = new Date().toTimeString().split(' ')[0];
        return `${time} | ${color}${level.toUpperCase().padEnd(5)}${RESET} | [${this.name}] ${message}`;
    }
    debug(message, ...args) {
        if (this.shouldLog('debug')) {
            console.debug(this.formatMessage('debug', message), ...args);
        }
    }
    info(message, ...args) {
        if (this.shouldLog('info')) {
            console.info(this.formatMessage('info', message), ...args);
        }
    }
    warn(message, ...args) {
        if (this.shouldLog('warn')) {
            console.warn(this.formatMessage('warn', message), ...args);
        }
    }
    error(message, ...args) {
        if (this.shouldLog('error')) {
            console.error(this.formatMessage('error', message), ...args);
        }
    }
}
export function createLogger(name, debug = false) {
    return new Logger(name, debug ? 'debug' : 'info');
}
//# sourceMappingURL=logger.js.map