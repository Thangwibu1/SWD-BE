# Kiểm chứng ma trận kiến trúc A01–A52

Ngày 05/10/2026 (Asia/Saigon). Đã hoàn thiện 52 cấu hình, gồm 13 topology × 4 chế độ Redis. Xem [ma trận](architecture-matrix.md), [phạm vi](supported-architectures.md), [prompt](ai-contract/prompt.vi.txt) và [schema câu trả lời AI](ai-contract/ai-selection.schema.json).

## Kết quả chức năng

52/52 experiment Docker hoàn tất, mỗi profile qua 7/7 invariants và gate correctness/stability. Workload MIXED_V1, pilot, 2 operations/giây, warmup 1 giây, đo 10 giây, cooldown 0, một repetition. Tổng request trong lượt đo: 1082. Script kiểm SHA256 của 52 artifact invariant tải qua API. Bằng chứng local ở [summary](../results/architecture-matrix-20261005/summary.json) và [experiment IDs](../results/architecture-matrix-20261005/campaign.json).

| Profile | Runtime | Invariants | Error rate | P99 HTTP (ms) | Gate trượt |
|---|---|---|---|---|---|
| A01 | COMPLETED | 7/7 | 0 | 14.04 | Không |
| A02 | COMPLETED | 7/7 | 0 | 22.10 | Không |
| A03 | COMPLETED | 7/7 | 0 | 103.78 | GATE_P99 |
| A04 | COMPLETED | 7/7 | 0 | 63.56 | Không |
| A05 | COMPLETED | 7/7 | 0 | 334.59 | GATE_P99 |
| A06 | COMPLETED | 7/7 | 0 | 49.04 | Không |
| A07 | COMPLETED | 7/7 | 0 | 129.68 | GATE_P99 |
| A08 | COMPLETED | 7/7 | 0 | 303.97 | GATE_P99 |
| A09 | COMPLETED | 7/7 | 0 | 72.14 | Không |
| A10 | COMPLETED | 7/7 | 0 | 194.12 | GATE_P99 |
| A11 | COMPLETED | 7/7 | 0 | 136.60 | GATE_P99 |
| A12 | COMPLETED | 7/7 | 0 | 110.40 | GATE_P99 |
| A13 | COMPLETED | 7/7 | 0 | 281.84 | GATE_P99 |
| A14 | COMPLETED | 7/7 | 0 | 43.19 | Không |
| A15 | COMPLETED | 7/7 | 0 | 24.94 | Không |
| A16 | COMPLETED | 7/7 | 0 | 25.03 | Không |
| A17 | COMPLETED | 7/7 | 0 | 14.76 | Không |
| A18 | COMPLETED | 7/7 | 0 | 14.56 | Không |
| A19 | COMPLETED | 7/7 | 0 | 17.70 | Không |
| A20 | COMPLETED | 7/7 | 0 | 31.00 | Không |
| A21 | COMPLETED | 7/7 | 0 | 22.41 | Không |
| A22 | COMPLETED | 7/7 | 0 | 44.25 | Không |
| A23 | COMPLETED | 7/7 | 0 | 18.82 | Không |
| A24 | COMPLETED | 7/7 | 0 | 88.14 | Không |
| A25 | COMPLETED | 7/7 | 0 | 238.01 | GATE_P99 |
| A26 | COMPLETED | 7/7 | 0 | 480.39 | GATE_P99 |
| A27 | COMPLETED | 7/7 | 0 | 349.23 | GATE_P99 |
| A28 | COMPLETED | 7/7 | 0 | 166.81 | GATE_P99 |
| A29 | COMPLETED | 7/7 | 0 | 41.74 | Không |
| A30 | COMPLETED | 7/7 | 0 | 437.74 | GATE_P99 |
| A31 | COMPLETED | 7/7 | 0 | 157.53 | GATE_P99 |
| A32 | COMPLETED | 7/7 | 0 | 244.48 | GATE_P99, GATE_ACHIEVED_RATE |
| A33 | COMPLETED | 7/7 | 0 | 290.64 | GATE_P99 |
| A34 | COMPLETED | 7/7 | 0 | 148.45 | GATE_P99 |
| A35 | COMPLETED | 7/7 | 0 | 225.95 | GATE_P99 |
| A36 | COMPLETED | 7/7 | 0 | 166.35 | GATE_P99 |
| A37 | COMPLETED | 7/7 | 0 | 83.68 | Không |
| A38 | COMPLETED | 7/7 | 0 | 114.53 | GATE_P99 |
| A39 | COMPLETED | 7/7 | 0 | 71.86 | Không |
| A40 | COMPLETED | 7/7 | 0 | 219.80 | GATE_P99, GATE_ACHIEVED_RATE |
| A41 | COMPLETED | 7/7 | 0 | 232.24 | GATE_P99 |
| A42 | COMPLETED | 7/7 | 0 | 207.53 | GATE_P99 |
| A43 | COMPLETED | 7/7 | 0 | 221.71 | GATE_P99 |
| A44 | COMPLETED | 7/7 | 0 | 22.23 | Không |
| A45 | COMPLETED | 7/7 | 0 | 269.51 | GATE_P99 |
| A46 | COMPLETED | 7/7 | 0 | 36.57 | GATE_ACHIEVED_RATE |
| A47 | COMPLETED | 7/7 | 0 | 15.50 | Không |
| A48 | COMPLETED | 7/7 | 0 | 384.43 | GATE_P99 |
| A49 | COMPLETED | 7/7 | 0 | 30.85 | Không |
| A50 | COMPLETED | 7/7 | 0 | 210.78 | GATE_P99 |
| A51 | COMPLETED | 7/7 | 0 | 31.44 | Không |
| A52 | COMPLETED | 7/7 | 0 | 81.60 | Không |

## Redis và giỏ hàng

Đã quan sát Redis trực tiếp trên 36 profile trong campaign. Không phát hiện key product/page khi không chọn product, hoặc key cart khi không chọn Redis cart. Số key được lưu trong [observations](../results/architecture-matrix-20261005/cache-observations.json). Quan sát bắt đầu sau các profile đầu và workload ngẫu nhiên ngắn có thể không tạo key ở mỗi loại; không xem việc không quan sát được key là bằng chứng đầy đủ rằng chức năng không chạy.

Không Redis cart thì cart lưu PostgreSQL dùng chung, có transaction và advisory lock cho mutation. Redis cart dùng HSET/HDEL từng field và transaction khi thay toàn bộ cart; integration test hai client độc lập kiểm 24 lần upsert đồng thời rồi remove/update đồng thời, không mất cập nhật. Product-only/cart-only được chọn độc lập. TTL 60 giây chỉ áp dụng product cache.

## Giới hạn nghiên cứu

Campaign dùng một image SUT cố định, lưu ID trong [image IDs](../results/architecture-matrix-20261005/image-ids.json).
Đối chiếu 44 module JavaScript SUT giữa image và bản build hiện tại cho cùng SHA256
`0eb28b145b89a76230400cbfe782d600dd583b0ea8df8bf5c93aee22e1eed7dc` (chuẩn hóa CRLF/LF).
Trong lúc campaign chạy, contract AI được sửa để bỏ TTL khỏi candidate chỉ có Redis cart;
controller cũ có thể ghi ttlSeconds=60 vào metadata các candidate này. Trường đó không
làm cart hết hạn trong runtime đã đo. Dữ liệu gốc được giữ nguyên; contract mới chỉ dùng TTL
cho product cache, và dùng candidate mới từ catalog để tạo nghiên cứu tiếp theo.

P99 trong bảng là latency HTTP; checkout bất đồng bộ trả 202 nên cần thêm đánh giá
polling/confirmation khi so với checkout đồng bộ. Không coi P99 nhận yêu cầu là P99 hoàn tất đơn.

Đây là kiểm chứng chạy được, không phải benchmark công bố hay bảo đảm SLO. Một số gate P99/throughput trượt như bảng trên. Ít mẫu, một máy Docker Desktop và có kiểm tra/build trong phiên: không dùng bảng để xếp hạng kiến trúc. Quota từng profile ≤2 vCPU/4096 MiB, nhưng tổng cấp phát khác nhau (bỏ Redis cũng bỏ tài nguyên của Redis); nghiên cứu phải nêu ngân sách và phương pháp so sánh.

AI phải chọn đúng candidate trong catalog. Yêu cầu Kafka, Redis queue, monolith + RabbitMQ, CQRS, read replica, event sourcing, serverless hoặc topology ngoài matrix phải trả UNSUPPORTED_REQUIREMENTS, không ánh xạ gần đúng. Các nhãn DDD/Clean/Hexagonal không tự chứng minh cách tổ chức code. Không bảo đảm mọi kiến trúc AI có thể tự nghĩ ra đều chạy được.

## Kiểm tra mã và công cụ

- Backend: 24 test file, 284 test qua; lint, typecheck và build qua.
- Registry: 52/52 hợp lệ; contract tests kiểm đủ 13 topology × 4 chế độ Redis,
  render Compose đúng dependency/replica, không Redis khi tắt và quota ≤2 vCPU/4096 MiB.
- Protocol runner dry-run: 52 cấu hình × 4 workload = 208 kế hoạch; không tạo experiment.
- Thu thập artifact lần đầu gặp lỗi PowerShell với danh sách gate trượt rỗng. Đã sửa
  và chạy CollectOnly trên cùng 52 experiment, kiểm đủ từng invariant và SHA256.
- Frontend: 2 unit test qua; unit test chờ module Dashboard thật trước phần kiểm tra DOM
  để tránh timeout khi Vite còn transform lazy module. Browser E2E kiểm việc tải route thật.
- UI đang chạy xác nhận 52 card, bộ lọc không Redis có 13 profile và tải schema câu trả lời AI đúng.
- API bản cuối validate 52/52 canonical candidate, bao gồm nhánh UNSUPPORTED_REQUIREMENTS.
- Chạy lại A18 bằng controller/contract cuối: experiment `1f442d27-d8b8-4872-90b1-636aac0c425f`,
  7/7 invariants, lỗi HTTP 0, P99 13,61 ms; không gate trượt. Artifact ở
  [recheck](../results/architecture-matrix-contract-recheck-20261005/summary.json).
- Image cuối vẫn có cùng SHA256 44 module SUT như campaign; thay đổi contract không đổi mã SUT.
- Frontend browser E2E: 6/6 qua, gồm Dashboard lazy route, tải prompt/schema, lọc Redis và tạo/chặn experiment.
