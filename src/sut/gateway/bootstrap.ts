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

  const isMicroservices = archId >= 'A05' && archId <= 'A12';

  let targets: string[] = [];
  const microserviceTargets: { user: string[]; catalog: string[]; inventory: string[]; order: string[]; payment: string[] } = {
    user: [],
    catalog: [],
    inventory: [],
    order: [],
    payment: [],
  };

  if (!isMicroservices) {
    targets = (config.MONOLITH_URL || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (targets.length === 0) {
      throw new Error('MONOLITH_URL must be configured for the API gateway to route traffic');
    }
    logger.info({ targets }, 'Gateway downstream targets (Monolith proxy)');
  } else {
    const parseUrls = (envVar: string | undefined, defaultUrl: string) =>
      (envVar || defaultUrl).split(',').map((s) => s.trim()).filter(Boolean);

    microserviceTargets.user = parseUrls(config.USER_URL, 'http://user-service:3000');
    microserviceTargets.catalog = parseUrls(config.CATALOG_URL, 'http://catalog-service:3000');
    microserviceTargets.inventory = parseUrls(config.INVENTORY_URL, 'http://inventory-service:3000');
    microserviceTargets.order = parseUrls(config.ORDER_URL, 'http://order-service:3000');
    microserviceTargets.payment = parseUrls(config.PAYMENT_URL, 'http://payment-mock:3000');
    logger.info('Gateway using path-based routing (Microservices)');
  }

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
  const currentMicroserviceIndex = {
    user: 0,
    catalog: 0,
    inventory: 0,
    order: 0,
    payment: 0,
  };

  // Proxy middleware
  app.use((req: Request, res: Response) => {
    let targetUrlString: string;
    
    if (isMicroservices) {
      if (req.originalUrl.startsWith('/auth')) {
        targetUrlString = microserviceTargets.user[currentMicroserviceIndex.user]!;
        currentMicroserviceIndex.user = (currentMicroserviceIndex.user + 1) % microserviceTargets.user.length;
      } else if (req.originalUrl.startsWith('/products')) {
        targetUrlString = microserviceTargets.catalog[currentMicroserviceIndex.catalog]!;
        currentMicroserviceIndex.catalog = (currentMicroserviceIndex.catalog + 1) % microserviceTargets.catalog.length;
      } else if (req.originalUrl.startsWith('/inventory')) {
        targetUrlString = microserviceTargets.inventory[currentMicroserviceIndex.inventory]!;
        currentMicroserviceIndex.inventory = (currentMicroserviceIndex.inventory + 1) % microserviceTargets.inventory.length;
      } else if (req.originalUrl.startsWith('/orders') || req.originalUrl.startsWith('/users')) {
        // Users contains /users/:id/orders and /users/:id/cart which both go to order-service
        targetUrlString = microserviceTargets.order[currentMicroserviceIndex.order]!;
        currentMicroserviceIndex.order = (currentMicroserviceIndex.order + 1) % microserviceTargets.order.length;
      } else if (req.originalUrl.startsWith('/payments')) {
        targetUrlString = microserviceTargets.payment[currentMicroserviceIndex.payment]!;
        currentMicroserviceIndex.payment = (currentMicroserviceIndex.payment + 1) % microserviceTargets.payment.length;
      } else {
        // Fallback
        targetUrlString = microserviceTargets.order[currentMicroserviceIndex.order]!;
        currentMicroserviceIndex.order = (currentMicroserviceIndex.order + 1) % microserviceTargets.order.length;
      }
    } else {
      const paymentOrderId = req.originalUrl.startsWith('/payments/') && typeof req.body?.orderId === 'string'
        ? req.body.orderId as string
        : undefined;
      if (paymentOrderId && targets.length > 1) {
        // The monolith payment mock intentionally keeps its idempotency state
        // in-process. Route all replays for one order to the same replica so a
        // scaled A03/A04 deployment preserves the single-payment contract.
        let hash = 0;
        for (const character of paymentOrderId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
        targetUrlString = targets[hash % targets.length]!;
      } else {
        targetUrlString = targets[currentTargetIndex]!;
        currentTargetIndex = (currentTargetIndex + 1) % targets.length;
      }
    }

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
