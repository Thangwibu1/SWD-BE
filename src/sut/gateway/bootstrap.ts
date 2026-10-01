import type { AppConfig } from '../../config/env.js';
import { loadSutConfig } from '../../config/sut-env.js';
import type { Logger } from '../../utils/logger.js';
import { createSutApp, finalizeSutApp } from '../shared/http/sut-http.js';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { Request, Response } from 'express';

export async function bootstrapGateway(_appConfig: AppConfig, logger: Logger): Promise<void> {
  const config = loadSutConfig();
  const archId = config.ARCHITECTURE_ID;
  logger.info({ architectureId: archId }, 'Bootstrapping API Gateway');

  const app = createSutApp(logger);

  // Parse downstream targets
  const targets = (config.MONOLITH_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (targets.length === 0) {
    throw new Error('MONOLITH_URL must be configured for the API gateway to route traffic');
  }

  logger.info({ targets }, 'Gateway downstream targets');

  // Liveness and Readiness
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: `api-gateway-${archId}` });
  });
  
  app.get('/ready', (_req, res) => {
    // Gateway is ready if it's running. (Downstream health is checked by Docker/evaluator)
    res.json({ status: 'ready', checks: [] });
  });

  // Simple round-robin state
  let currentTargetIndex = 0;

  // Proxy middleware
  app.use((req: Request, res: Response) => {
    const targetUrlString = targets[currentTargetIndex];
    currentTargetIndex = (currentTargetIndex + 1) % targets.length;

    const targetUrl = new URL(req.originalUrl, targetUrlString);
    const options = {
      method: req.method,
      headers: { ...req.headers },
      timeout: config.SERVICE_TIMEOUT_MS,
    };

    // Remove host header so the target uses its own
    delete options.headers.host;

    const reqLib = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = reqLib.request(targetUrl, options, (proxyRes) => {
      res.status(proxyRes.statusCode || 500);
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value) res.setHeader(key, value);
      }
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      logger.error({ err, targetUrl: targetUrl.toString() }, 'Proxy request failed');
      if (!res.headersSent) {
        res.status(503).json({
          status: 503,
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'Downstream service unavailable',
        });
      }
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({
          status: 504,
          code: 'DEPENDENCY_TIMEOUT',
          message: 'Downstream service timed out',
        });
      }
    });

    // Pipe the request body to the proxy
    if (req.body && Object.keys(req.body).length > 0) {
      // Body was parsed by express.json(), need to stringify it again
      // We should really proxy the raw stream, but createSutApp adds express.json() globally.
      // So we have to re-stringify.
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Type', 'application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    }
    proxyReq.end();
  });

  finalizeSutApp(app, logger);

  const server = app.listen(config.SUT_PORT, '0.0.0.0', () => {
    logger.info({ port: config.SUT_PORT, architectureId: archId }, 'API Gateway listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down API Gateway');
    server.close(() => process.exit(0));
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
