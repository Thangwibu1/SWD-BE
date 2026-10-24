/* global structuredClone, console */
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

// Stable IDs A01–A16 are never rewritten. Generate the missing cache variants
// of each executable topology, rather than silently mapping an AI proposal.
const seeds = Array.from({ length: 16 }, (_, i) =>
  parse(readFileSync(`architecture-registry/A${String(i + 1).padStart(2, '0')}.yaml`, 'utf8')));
const topologies = ['A02', 'A03', 'A04', 'A06', 'A07', 'A08', 'A10', 'A11', 'A12', 'A13', 'A15', 'A16']
  .map(id => seeds.find(p => p.id === id));
const singleApiTwoWorkers = structuredClone(topologies.at(-1));
singleApiTwoWorkers.scalingProfile = 'QUEUE_SINGLE_API_DUAL_WORKER';
topologies.push(singleApiTwoWorkers);
const modes = [[], ['product'], ['cart'], ['product', 'cart']];
const key = p => JSON.stringify([p.family, p.messaging.broker, p.scalingProfile, [...(p.cache.targets ?? [])].sort()]);
const existing = new Map(seeds.map(p => [key(p), p]));
const matrix = [];
let nextId = 17;
for (const base of topologies) {
  for (const targets of modes) {
    const profile = structuredClone(base);
    profile.cache = { enabled: targets.length > 0, targets };
    const present = existing.get(key(profile));
    if (present) { matrix.push(present); continue; }
    profile.id = `A${String(nextId++).padStart(2, '0')}`;
    const compose = parse(readFileSync(base.composeTemplate, 'utf8'));
    if (profile.scalingProfile === 'QUEUE_SINGLE_API_DUAL_WORKER') {
      delete compose.services['sut-monolith-2'];
      delete compose.services.app.depends_on['sut-monolith-2'];
      compose.services.app.environment.MONOLITH_URL = 'http://sut-monolith:3000';
      delete profile.resources['sut-monolith-2'];
      profile.resources['sut-monolith'] = { cpus: 0.6, memoryMiB: 1280 };
      profile.allowedRoles = profile.allowedRoles.filter(r => r !== 'sut-monolith-2');
    }
    if (profile.cache.enabled && !compose.services.redis) {
      compose.services.redis = {
        image: 'redis:${REDIS_VERSION}',
        healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '5s', timeout: '2s', retries: 12 },
        cpus: '0.1', mem_limit: '128m',
      };
      profile.resources.redis = { cpus: 0.1, memoryMiB: 128 };
      profile.allowedRoles.push('redis');
    }
    if (!profile.cache.enabled) {
      delete compose.services.redis;
      delete profile.resources.redis;
      profile.allowedRoles = profile.allowedRoles.filter(r => r !== 'redis');
    }
    for (const svc of Object.values(compose.services)) {
      if (svc.environment?.APP_ROLE) {
        svc.environment.ARCHITECTURE_ID = profile.id;
        const role = svc.environment.APP_ROLE;
        if (profile.cache.enabled && ['sut-monolith', 'catalog-service', 'order-service'].includes(role)) {
          svc.environment.REDIS_URL = 'redis://redis:6379';
          svc.depends_on ??= {};
          svc.depends_on.redis = { condition: 'service_healthy' };
        } else delete svc.environment.REDIS_URL;
      }
      if (!profile.cache.enabled && svc.depends_on) delete svc.depends_on.redis;
    }
    profile.composeTemplate = `infra/sut-templates/matrix-${profile.id.toLowerCase()}.compose.yaml`;
    profile.resourceProfile = `matrix_${profile.id.toLowerCase()}_v1`;
    writeFileSync(profile.composeTemplate, stringify(compose));
    writeFileSync(`architecture-registry/${profile.id}.yaml`, stringify(profile));
    existing.set(key(profile), profile);
    matrix.push(profile);
  }
}
writeFileSync('docs/ai-contract/matrix.json', JSON.stringify(matrix.map(p => ({
  architectureId: p.id, family: p.family, scalingProfile: p.scalingProfile,
  broker: p.messaging.broker, cacheTargets: p.cache.targets ?? [],
})), null, 2) + '\n');
const rows = topologies.map(base => {
  const variants = modes.map(targets => matrix.find(p => key(p) === key({ ...base, cache: { targets } })).id);
  return `| ${base.family} | ${base.messaging.broker} | ${base.scalingProfile} | ${variants.join(' | ')} |`;
});
writeFileSync('docs/architecture-matrix.md', `# Ma trận cấu hình kiến trúc\n\n13 topology × 4 chế độ Redis = 52 cấu hình. Tài liệu sinh bằng \`npm run registry:expand-matrix\`.\n\n| Family | Broker | Scaling | Không Redis | Product | Cart | Product + cart |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\nKhông Redis cho cart thì giỏ hàng lưu chung trong PostgreSQL. Cart trong Redis là kho dữ liệu, không phải queue. Chỉ dùng đúng ID và decisions từ [catalog](ai-contract/catalog.json); yêu cầu vượt phạm vi phải trả lỗi thay vì chọn gần đúng. Xem [phạm vi và lưu ý nghiên cứu](supported-architectures.md).\n`);
console.log(`Complete matrix: ${matrix.length} configurations across ${topologies.length} topologies.`);
