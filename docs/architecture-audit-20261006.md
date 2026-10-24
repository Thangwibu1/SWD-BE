# Rà soát toàn bộ catalog kiến trúc — 06/10/2026

## Phạm vi và kết quả đối chiếu

Catalog có **52 cấu hình A01–A52 = 13 topology × 4 chế độ Redis**.
Ba family là modular monolith, REST microservices và event-driven microservices.
Mỗi topology có đủ: không Redis, product cache, cart storage, product + cart.
Không phát hiện tổ hợp trùng hoặc thiếu trong ma trận đã công bố.

- 52/52 profile qua schema registry, render Compose, đối chiếu từng service,
  process role, số replica, dependency và CPU/RAM từng container.
- Tổng cấp phát của mỗi profile nằm trong 2 vCPU/4096 MiB.
- Docker Compose `config --quiet` kiểm **52/52** file đã render thành công;
  [kết quả](../results/architecture-audit-20261006/compose-config-audit.json).
- 52/52 canonical candidate qua schema câu trả lời AI và validator của API đang chạy.
- Catalog, hai schema xuất cho AI và prompt trên đĩa khớp contract sinh từ registry.
- Redis chỉ được dùng đúng targets; RabbitMQ và PostgreSQL queue chỉ xuất hiện
  ở profile tương ứng. Event `ORDER_SCALED` có 2 order process và 2 event worker.
- Bộ `registry:validate` đã bổ sung kiểm tra deployment, không chỉ kiểm tra schema
  và tổng tài nguyên như trước.

Chi tiết máy đọc được: [static audit](../results/architecture-audit-20261006/static-audit.json),
[candidate API](../results/architecture-audit-20261006/live-candidate-validation.json).
Compose đã render cho từng ID nằm trong `results/architecture-audit-20261006/catalog-compose/`.

## Các lỗi đã sửa

1. **Sổ thanh toán monolith chỉ nằm trong bộ nhớ process.** Checkout và yêu cầu
   thanh toán gửi lại có thể đến hai replica khác nhau; khởi động lại cũng mất ledger.
   Mọi monolith nay dùng ledger PostgreSQL. Ledger và checkout đồng bộ dùng cùng
   transaction; lỗi trước confirmation sẽ rollback cả thanh toán mock, order và stock.
   Gateway dùng round-robin cho cả payment, không cần ghim payment theo order ID.
2. **Checkout đồng bộ tranh chấp cùng idempotency key.** Bổ sung advisory transaction
   lock trước đọc/tạo đơn. Test 8 yêu cầu đồng thời từ các module replica xác nhận
   chỉ tạo một order, một payment và chỉ trừ stock một lần.
3. **Khóa tồn kho theo thứ tự payload.** Reserve, commit và release nay sắp xếp
   product ID trước khi cập nhật. Test thực PostgreSQL dùng các đơn có thứ tự sản phẩm
   ngược nhau và hủy đồng thời, xác nhận tồn kho trở về baseline.
4. **Resource alias `app` không nhận override từ profile.** Renderer nay ánh xạ
   `app` sang APP_ROLE khi registry cấp phát bằng role như `sut-monolith` hoặc
   `api-gateway`. Test thay CPU/RAM trong profile xác nhận Compose nhận đúng giá trị.
5. **Worker luôn đếm số application process là 1.** Cách tìm chữ `replica` trong
   tên role không khớp catalog. Nay đếm concrete application allocations, gồm service,
   mock và worker, loại gateway/PostgreSQL/Redis/RabbitMQ. Ví dụ A01=1, A03=2,
   A16=4, A49=3. Đây là input cho heuristic engineering complexity/TCO,
   không phải số replica riêng của database hoặc riêng một service.
6. Trường consistency truyền vào score engine nay đếm check thất bại thay vì đếm
   cả 7 check. Hiện score engine không dùng trường này để tính utility; gate correctness
   vốn đã đếm đúng các lỗi CRITICAL, nên sửa này không thay kết quả gate cũ.
7. **Collector dừng trước khi lưu artifact nếu một experiment FAILED.** Script
   nay thu thập bằng chứng trước khi trả lỗi. Run infrastructure-invalid không nằm
   trong official results được giữ riêng bằng raw experiment, với trạng thái FAILED
   và gate trượt trong summary; không biến số đo invalid thành kết quả benchmark hợp lệ.
   Đã kiểm tra bằng CollectOnly trên campaign có hai lượt invalid, script lưu đủ 7 ID,
   tải và kiểm SHA256 invariant rồi vẫn trả exit code 1 đúng với trạng thái campaign.

Các sửa đổi runtime làm thay đổi mã SUT so với ngày 05/10. Không gộp số đo hai
phiên bản để xếp hạng. Kết quả cost cũ cũng không được coi đã tự cập nhật sau sửa
cách đếm application process.

## Kiểm tra mã và giao diện

- Backend: **24 test file / 290 test qua**, lint, typecheck và build qua.
- Test bằng process Node thật: checkout ở monolith thứ nhất, payment replay ở
  monolith thứ hai và sau restart đều trả `duplicate=true`. Không chỉ test module.
- Test PostgreSQL queue giữ đủ claim lease, fencing token, retry và restart worker.
- Test Redis cart giữ kiểm tra cập nhật đồng thời từ các client độc lập.
- Frontend: lint/build, **2 unit test và 6 browser test qua**. Browser test dùng API
  mock; 52 candidate với backend thật được kiểm riêng bằng API như phần trên.
- Image backend mới: `sha256:4e4740c07041cd117a570319765e343eb1c0f53fbf00c70577d4fca3cdf7f7fa`.
  Đã đối chiếu 44 module JavaScript SUT giữa build local và image: khớp từng file.
  Fingerprint theo thuật toán ghi trong artifact:
  `9d2348b1d2a6badaf4dddccc57f8c88407219181f9337cc26be89bf7ca1d6fca`.
  [Image và fingerprint](../results/architecture-audit-20261006/image-sut-fingerprint.json).

## Phân biệt bằng chứng runtime

Campaign ngày 05/10 đã chạy đủ **52/52 cấu hình**, tất cả 7/7 invariant và lỗi HTTP 0.
Đã đọc lại summary để đối chiếu số lượng và kết quả; xem
[báo cáo gốc](architecture-matrix-verification-20261005.md). Đây là image trước các sửa
runtime trong báo cáo này; không gọi đó là chạy lại 52 cấu hình bằng image mới.

Đợt 06/10 chạy lại đại diện của cả 7 topology monolith: A01, A03, A04, A13, A14,
A16, A49. Workload MIXED_V1, 2 operations/s, warmup 1 giây, measure 5 giây, 1 repetition.
Lượt A13 và A49 đầu đạt 7/7 invariant và HTTP error 0 nhưng thiếu dữ liệu Prometheus
trong cửa sổ đo, nên evaluator đánh dấu FAILED do measurement invalid.
Giữ nguyên bằng chứng đó và tạo lượt riêng với warmup 2 giây/measure 15 giây.
A13 đo lại hoàn tất, 7/7 invariant, HTTP error 0 và không gate trượt;
experiment `6979aa44-cc78-4719-8673-0aae9edfb0e3`,
[bằng chứng](../results/architecture-audit-20261006-recheck/summary.json).
Campaign ban đầu [lưu đủ 7 dòng](../results/architecture-audit-20261006/summary.json),
bao gồm A13/A49 FAILED và A14 trượt achieved-rate dù experiment COMPLETED.
Không sửa dữ liệu gốc hoặc gọi các lượt invalid là kết quả performance hợp lệ.

A49 đo lại cũng hoàn tất, 7/7 invariant, HTTP error 0 và không gate trượt;
experiment `7932a854-f295-4542-8ae9-50a4d1a8c86f`,
[bằng chứng](../results/architecture-audit-20261006-a49-recheck/summary.json).
Như vậy cả 7 topology monolith có một lượt COMPLETED trên image mới, sau 2 lượt đo lại.
Tổng cộng đợt này tạo 9 experiment, không chạy lại cả 52 runtime.

| ID | Thời gian đo (s) | Invariant | HTTP error rate | Gate trượt ở lượt được chọn |
|---|---:|---|---:|---|
| A01 | 5 | 7/7 | 0 | Không |
| A03 | 5 | 7/7 | 0 | Không |
| A04 | 5 | 7/7 | 0 | Không |
| A13 (đo lại) | 15 | 7/7 | 0 | Không |
| A14 | 5 | 7/7 | 0 | GATE_ACHIEVED_RATE |
| A16 | 5 | 7/7 | 0 | Không |
| A49 (đo lại) | 15 | 7/7 | 0 | Không |

Lượt được chọn của A14 vẫn không đủ cơ sở kết luận đạt SLO. Hai lượt ngắn của
A13/A49 thiếu metrics là bằng chứng pipeline cần cửa sổ đo đủ dài; tăng thời gian
không làm thay đổi gate hoặc tự biến lượt cũ thành hợp lệ.

## Giới hạn cần giữ khi nghiên cứu

- Catalog này bao phủ 13 topology hiện có và 4 lựa chọn Redis, không bao phủ mọi
  thiết kế AI có thể nghĩ ra. Công nghệ/topology ngoài schema phải trả
  `UNSUPPORTED_REQUIREMENTS`; không đổi tên hoặc ánh xạ gần đúng để làm experiment.
- Runtime cố định Node.js/Express, gateway Node HTTP proxy, một PostgreSQL database
  dùng chung. Không có database-per-service, HA, autoscaling, Kafka, Redis queue,
  read replica, CQRS, event sourcing hay serverless trong 52 profile.
- Không Redis cho cart vẫn có cart dùng PostgreSQL. Redis cart không có product TTL
  và không phải queue/session store/distributed lock. Product TTL cố định 60 giây.
- Tổng tài nguyên giữa các profile khác nhau. So sánh Redis bật/tắt cần nêu rõ ngân
  sách cấp phát, vì bỏ Redis cũng bỏ phần CPU/RAM của Redis.
- Broker NONE checkout đồng bộ; POSTGRES/RABBITMQ trả 202 rồi xử lý bất đồng bộ.
  P99 HTTP acceptance không thay thế P99 đến lúc order CONFIRMED.
- `DUAL_APP_PROXY_ASYNC` chỉ tách notification dạng best-effort; không có checkout
  queue hoặc bảo đảm notification được gửi lại khi process mất trước khi gửi.
- Smoke ngắn, ít mẫu và một máy Docker Desktop chỉ xác nhận chạy nghiệp vụ.
  Chưa chứng minh capacity, production SLO hoặc thứ hạng nghiên cứu. Cost là mô hình
  catalog/heuristic, không phải hóa đơn cloud thực tế.
- Protocol pilot/main/capacity cũ vẫn là cohort 12 profile. Nghiên cứu 52 profile
  cần protocol riêng, nhiều repetition và workload/thời gian đo đủ dài.

Để tự kiểm tra lại catalog: `npm run registry:validate` và `npm run test:contract`.
Để chạy toàn bộ runtime mới: dùng `scripts/smoke-all-architectures.ps1` với thời gian
đo phù hợp, lưu evidence directory mới và giữ cố định image suốt campaign.
