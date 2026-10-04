import pino from 'pino';
import type { Logger } from '../../src/utils/logger.js';

export function createTestLogger(): Logger {
  return pino({
    level: process.env.LOG_LEVEL || 'silent', // silent in tests by default
    ...(process.env.LOG_LEVEL ? { transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    } } : {}),
  });
}
