import { pino } from 'pino';
import type { Logger } from 'pino';

/**
 * Structured JSON logger shared by every APP_ROLE.
 * Redacts credentials so authorization headers, cookies and passwords
 * never reach log storage (guide section 27).
 */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'password',
        '*.password',
        'passwordHash',
        '*.passwordHash',
        'apiKey',
        '*.apiKey',
      ],
      censor: '[REDACTED]',
    },
  });
}

export type { Logger };
