/**
 * Structured logger with timestamps and optional jobId context.
 *
 * Usage:
 *   const log = createLogger('module-name');
 *   log.info('message', { jobId: 'abc' });    // → [2025-01-01T00:00:00.000Z] [INFO] [module-name] [abc] message
 *   log.warn('message');                       // → [2025-01-01T00:00:00.000Z] [WARN] [module-name] message
 *   log.error('message', err);
 */

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.INFO;

function formatTimestamp() {
  return new Date().toISOString();
}

function createLogger(module) {
  const log = (level, msg, ...args) => {
    if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

    const ts = formatTimestamp();
    let jobId = '';
    let extra = null;

    // Extract jobId from the first arg if it's an options object
    if (args.length > 0 && args[0] && typeof args[0] === 'object' && args[0].jobId) {
      jobId = ` [${args[0].jobId}]`;
      extra = args.slice(1);
    } else {
      extra = args;
    }

    const prefix = `[${ts}] [${level}] [${module}]${jobId}`;
    const extraStr = extra.length > 0 ? ' ' + extra.map(a => {
      if (a instanceof Error) return (a.stack || a.message);
      if (typeof a === 'object') return JSON.stringify(a);
      return String(a);
    }).join(' ') : '';

    switch (level) {
      case 'ERROR': console.error(`${prefix} ${msg}${extraStr}`); break;
      case 'WARN':  console.warn(`${prefix} ${msg}${extraStr}`); break;
      case 'DEBUG': console.debug(`${prefix} ${msg}${extraStr}`); break;
      default:      console.log(`${prefix} ${msg}${extraStr}`);
    }
  };

  return {
    debug: (msg, ...args) => log('DEBUG', msg, ...args),
    info:  (msg, ...args) => log('INFO', msg, ...args),
    warn:  (msg, ...args) => log('WARN', msg, ...args),
    error: (msg, ...args) => log('ERROR', msg, ...args),
  };
}

export { createLogger };
