import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type { ArchitectureProfile } from '../registry/index.js';

export interface RenderOptions {
  runId: string;
  profile: ArchitectureProfile;
  databaseUrl: string;
  redisUrl?: string;
  rabbitmqUrl?: string;
  hostPortStart: number;
  outputDir?: string;
}

export interface RenderedCompose {
  filePath: string;
  composeContent: string;
  hostPort: number;
  postgresHostPort: number;
  controlHost?: string;
  controlDatabaseHost?: string;
}

export function renderCompose(options: RenderOptions): RenderedCompose {
  // Read the whitelisted template
  const templatePath = path.resolve(options.profile.composeTemplate);
  const content = readFileSync(templatePath, 'utf8');

  // Parse YAML to manipulate
  const compose = yamlParse(content);

  // Remove services that are not part of the selected registry profile. The
  // shared event template is intentionally a superset (A09/A10), while the
  // registry remains the source of truth.
  const services = compose.services as Record<string, Record<string, unknown>>;
  const roleForService = (serviceName: string): string => {
    if (serviceName === 'app') {
      return options.profile.family === 'MODULAR_MONOLITH' ? 'sut-monolith' : 'api-gateway';
    }
    // Registry roles describe a logical service. Scaled templates use
    // deterministic numeric suffixes for concrete replicas.
    return serviceName.replace(/-\d+$/, '');
  };
  const allowed = new Set(options.profile.allowedRoles);
  for (const serviceName of Object.keys(services)) {
    if (!allowed.has(serviceName) && !allowed.has(roleForService(serviceName))) delete services[serviceName];
  }
  for (const svc of Object.values(services)) {
    const dependencies = svc.depends_on as Record<string, unknown> | undefined;
    if (dependencies) {
      for (const dependency of Object.keys(dependencies)) {
        if (!services[dependency]) delete dependencies[dependency];
      }
    }
  }

  // Assign host ports for the public SUT endpoint and the per-run PostgreSQL.
  const assignedHostPort = options.hostPortStart;
  const postgresHostPort = options.hostPortStart + 1;
  const bindHost = process.env['SUT_BIND_HOST'] ?? '127.0.0.1';
  const controlNetwork = process.env['SUT_CONTROL_NETWORK']?.trim();
  const controlHost = controlNetwork ? `sut-${options.runId}` : undefined;
  const controlDatabaseHost = controlNetwork ? `sut-db-${options.runId}` : undefined;
  if (!['127.0.0.1', '0.0.0.0'].includes(bindHost)) throw new Error(`Unsupported SUT_BIND_HOST ${bindHost}`);
  const mainServiceNames = ['app', 'api-gateway', 'gateway'];

  // Update resource limits and ports for each service based on profile
  for (const [serviceName, svc] of Object.entries(services)) {
    svc.init = true;
    svc.logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
    svc.ulimits = { nofile: { soft: 65535, hard: 65535 } };
    const resourceAlloc = options.profile.resources?.[serviceName];
    if (resourceAlloc) {
      svc.cpus = resourceAlloc.cpus.toString();
      svc.mem_limit = `${resourceAlloc.memoryMiB}m`;
    }

    const environment = (svc.environment ?? {}) as Record<string, unknown>;
    if ('APP_ROLE' in environment) {
      svc.restart = 'on-failure';
      environment.ARCHITECTURE_ID = options.profile.id;
      svc.security_opt = ['no-new-privileges:true'];
      svc.cap_drop = ['ALL'];
      svc.read_only = true;
      svc.tmpfs = ['/tmp:rw,noexec,nosuid,size=64m'];
      // Spawning a second Node.js process for every health probe can exceed
      // the intentionally small 128 MiB mock-service limits. curl is already
      // present in the runtime image and keeps the probe resource-neutral.
      const healthcheck = svc.healthcheck as Record<string, unknown> | undefined;
      if (healthcheck) {
        svc.healthcheck = {
          ...healthcheck,
          test: ['CMD', 'curl', '-fsS', 'http://localhost:3000/ready'],
        };
      }
    }
    if (!options.profile.cache.enabled) {
      delete environment.REDIS_URL;
    }
    svc.environment = environment;

    // Assign host port to main service
    if (mainServiceNames.includes(serviceName)) {
      if (!svc.ports) svc.ports = [];
      // Replace or add port mapping
      const ports = svc.ports as string[];
      const filtered = ports.filter((p: string) => !p.includes(':3000'));
      filtered.push(`${bindHost}:${assignedHostPort}:3000`);
      svc.ports = filtered;
    }
    if (serviceName === 'postgres') {
      svc.ports = [`${bindHost}:${postgresHostPort}:5432`];
    }

    if (serviceName === 'rabbitmq' && svc.healthcheck) {
      // rabbitmq-diagnostics starts an Erlang CLI node for every probe. Under
      // the frozen 0.2 CPU profile that probe can starve the broker it checks.
      // A local AMQP TCP probe is sufficient here; the application clients
      // still verify exchanges/queues when they connect.
      svc.healthcheck = {
        ...(svc.healthcheck as Record<string, unknown>),
        test: ['CMD-SHELL', 'nc -z 127.0.0.1 5672'],
        interval: '5s',
        timeout: '2s',
        retries: 120,
        start_period: '10s',
      };
    }

    // A containerized evaluator cannot reliably hairpin through a Docker host
    // published port (notably on Docker Desktop). Attach only the public SUT
    // endpoint and PostgreSQL to a pre-created internal control network, using
    // per-run aliases so the worker and Prometheus can address them directly.
    if (controlNetwork && (mainServiceNames.includes(serviceName) || serviceName === 'postgres')) {
      const alias = serviceName === 'postgres' ? controlDatabaseHost : controlHost;
      svc.networks = {
        default: {},
        evaluator_control: { aliases: [alias] },
      };
    }
  }

  // The benchmark stack can reach only its Compose dependencies. Published
  // HTTP/PostgreSQL ports remain reachable from the controller/load hosts,
  // while arbitrary SUT egress is denied.
  compose.networks = {
    ...(compose.networks ?? {}),
    default: { internal: true },
    ...(controlNetwork ? { evaluator_control: { external: true, name: controlNetwork } } : {}),
  };

  const renderedContent = yamlStringify(compose);

  // Write to a temporary run-specific file
  const resultsDir = options.outputDir
    ? path.resolve(options.outputDir, 'input')
    : path.resolve(process.env['RESULTS_ROOT'] ?? 'results', options.runId, 'input');
  mkdirSync(resultsDir, { recursive: true });

  const targetPath = path.join(resultsDir, 'resolved-compose.yaml');
  writeFileSync(targetPath, renderedContent);

  return {
    filePath: targetPath,
    composeContent: renderedContent,
    hostPort: assignedHostPort,
    postgresHostPort,
    ...(controlHost ? { controlHost } : {}),
    ...(controlDatabaseHost ? { controlDatabaseHost } : {}),
  };
}
