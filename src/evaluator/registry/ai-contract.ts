import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadRegistry, type ArchitectureProfile } from './index.js';

export function profileCandidate(profile: ArchitectureProfile) {
  return {
    schemaVersion: '1.0.0',
    candidateId: `ai-${profile.id}`,
    architectureId: profile.id,
    architectureFamily: profile.family,
    priorities: [
      { metric: 'p99_ms', operator: 'LTE', target: 100, weight: 0.45 },
      { metric: 'monthly_cost_usd', operator: 'MIN', weight: 0.3 },
      { metric: 'scalability', operator: 'MAX', weight: 0.25 },
    ],
    components: profile.allowedRoles,
    decisions: {
      cache: {
        enabled: profile.cache.enabled,
        targets: profile.cache.targets ?? [],
        ...(profile.cache.targets?.includes('product') ? { ttlSeconds: 60 } : {}),
      },
      messaging: profile.messaging,
      scalingProfile: profile.scalingProfile,
      communication: profile.communication,
    },
    assumptions: ['Fixed evaluator resources: at most 2 vCPU and 4096 MiB; payments are mocked.'],
    rationale: [`Selected supported profile ${profile.id}.`],
  };
}

/** The running registry is the only source of executable architecture choices. */
export function createAiContract() {
  const profiles = [...loadRegistry().values()].sort((a, b) => a.id.localeCompare(b.id));
  const candidates = profiles.map(profileCandidate);
  const schema = JSON.parse(
    readFileSync(path.resolve('schemas/architecture-candidate.schema.json'), 'utf8'),
  );
  schema.$id = 'supported-architecture-candidate';
  schema.oneOf = candidates.map((candidate) => ({
    properties: {
      architectureId: { const: candidate.architectureId },
      architectureFamily: { const: candidate.architectureFamily },
      components: { const: candidate.components },
      decisions: { const: candidate.decisions },
    },
  }));
  const selectionSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'architecture-ai-selection',
    oneOf: [schema, {
      type: 'object', additionalProperties: false,
      required: ['error', 'unsupportedRequirements'],
      properties: {
        error: { const: 'UNSUPPORTED_REQUIREMENTS' },
        unsupportedRequirements: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1, maxLength: 240 } },
      },
    }],
  };
  const prompt = `Bạn là kiến trúc sư lựa chọn cấu hình cho hệ thống benchmark e-commerce.
Yêu cầu bài toán: [THAY BẰNG YÊU CẦU CỦA BẠN].
Chọn ĐÚNG MỘT candidate trong catalog bên dưới. Chỉ trả về một JSON object, không Markdown.
Giữ nguyên schemaVersion, architectureId, architectureFamily, components và decisions của candidate được chọn.
Đổi candidateId thành tên duy nhất. Có thể thay priorities, assumptions và rationale để giải thích lựa chọn.
Tổng weight trong priorities phải bằng 1. LTE/GTE cần target. Mỗi assumptions/rationale tối đa 240 ký tự.
Không thêm Kafka, Kubernetes, serverless, read replica, CQRS hay dịch vụ ngoài catalog. Không trộn hai profile.
Redis là lựa chọn độc lập trong từng topology: không dùng, product, cart hoặc cả hai. Chọn đúng profile cho lựa chọn đó.
Redis cho cart là kho giỏ hàng; không phải queue. Queue chỉ dùng broker đã ghi trong profile.
Redis chỉ có các vai trò product cache/cart storage; không có Redis queue, session store, distributed lock hoặc rate limiter.
ttlSeconds chỉ áp dụng cache product; kho cart không tự hết hạn theo TTL đó.
Không Redis cho cart thì cart được lưu chung trong PostgreSQL. Các profile đều dùng PostgreSQL cho dữ liệu nghiệp vụ.
Runtime cố định: Node.js/Express; gateway Node HTTP proxy; một PostgreSQL database dùng chung giữa các process/service.
Replica cố định theo profile; không autoscaling/HPA. PostgreSQL, Redis và RabbitMQ đều là single instance, không cluster/HA/read replica.
Không có database-per-service, Nginx gateway, MongoDB/MySQL hay đổi framework trong các candidate này.
Nếu các công nghệ hoặc cách chia database đó là yêu cầu bắt buộc thì trả UNSUPPORTED_REQUIREMENTS.
Đây là các topology đã triển khai cho API benchmark cố định, không phải trình sinh code từ kiến trúc bất kỳ.
Không khẳng định đạt SLO trước khi chạy đo. Tất cả thanh toán là mock; async checkout trả 202 và cần polling.
Broker POSTGRES/RABBITMQ xử lý checkout bất đồng bộ; broker NONE xử lý checkout đồng bộ.
DUAL_APP_PROXY_ASYNC chỉ tách notification bất đồng bộ, không phải checkout queue/worker.
API e-commerce và nghiệp vụ cố định: chỉ hủy đơn CONFIRMED; không có TTL tự hủy PENDING, thanh toán thật hay API tùy biến.
PostgreSQL queue có lease 30 giây và retry backoff tối đa 30 giây; không có scheduler/reaper tùy ý.
Nếu yêu cầu bắt buộc vượt catalog, KHÔNG chọn profile gần nhất để thay thế. Trả {"error":"UNSUPPORTED_REQUIREMENTS","unsupportedRequirements":["yêu cầu chưa hỗ trợ"]}.
Object lỗi không phải candidate và không được đưa vào experiment. Chỉ trả candidate khi các quyết định triển khai bắt buộc khớp catalog.
Catalog candidate:
${JSON.stringify(candidates)}
JSON Schema cho câu trả lời (candidate hợp lệ hoặc lỗi ngoài phạm vi):
${JSON.stringify(selectionSchema)}
`;
  return {
    schemaVersion: '1.0.0',
    supportedArchitectureIds: profiles.map((p) => p.id),
    candidates,
    schema,
    selectionSchema,
    prompt,
  };
}
