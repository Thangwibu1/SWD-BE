# Kiểm chứng bộ cấu hình A01–A16

Đây là báo cáo của lượt mở rộng 16 profile trước ma trận 52 cấu hình.
Ma trận hiện tại xem [A01–A52](architecture-matrix.md); runtime mới dùng PostgreSQL
cart chung thay cho memory khi không chọn Redis cart. Không dùng số đo bên dưới
để đại diện cho phiên bản runtime sau thay đổi đó.

Ngày: 05/10/2026. Đã triển khai bốn profile mới A13–A16 và kiểm chứng 16/16 bằng Docker. Toàn bộ profile hoàn tất, không có lỗi HTTP trong lượt đo, qua 7/7 invariants, không OOM và không crash ngoài dự kiến.

A12 ở lượt đầu bị dừng toàn bộ container trước khi oracle thu thập dữ liệu, dẫn đến INFRA_INVALID_EXHAUSTED. Docker events ghi tín hiệu shutdown đồng loạt; chưa xác định tác nhân gửi lệnh dừng. Bằng chứng lỗi được giữ ở `results/architecture-expansion-20261005/A12-first-failed/` và `first-attempt-campaign.json`. Bảng bên dưới dùng lượt chạy lại A12 riêng; không xóa hoặc sửa trạng thái experiment lỗi.

## Phạm vi

- A01–A12 giữ topology cũ. A13–A16 là các biến thể monolith + PostgreSQL queue + worker; xem [hướng dẫn](supported-architectures.md).
- Candidate phải chọn profile trong registry. Không tự sinh runtime từ JSON kiến trúc bất kỳ. Schema và prompt được sinh từ registry, UI có nút tải cả hai.
- Validator đối chiếu components, family, cache targets, TTL, messaging và scaling/communication; không bỏ qua quyết định chưa hỗ trợ.
- Đã sửa catalog cache theo registry cho A10–A12 và tranh chấp lock giữa REST foreground/recovery.
- PostgreSQL queue không cần RabbitMQ; giỏ hàng dùng chung trong PostgreSQL.

## Lượt smoke toàn bộ registry

CHECKOUT_V1, 1 operation/giây, warmup 1 giây, đo 10 giây, cooldown 0, một repetition, dataset pilot. Tổng 172 HTTP request trong lượt đo. Kiểm tra active payment replay, cancel trả stock, concurrent oversell và terminal state nằm trong 7 invariants sau lượt đo.

| Profile | Runtime | Invariants | Lỗi HTTP | P99 HTTP (ms) | Gate trượt |
|---|---|---|---:|---:|---|
| A01 | COMPLETED | 7/7 | 0 | 16.01 | Không |
| A02 | COMPLETED | 7/7 | 0 | 34.71 | GATE_ACHIEVED_RATE |
| A03 | COMPLETED | 7/7 | 0 | 49.45 | Không |
| A04 | COMPLETED | 7/7 | 0 | 51.05 | GATE_ACHIEVED_RATE |
| A05 | COMPLETED | 7/7 | 0 | 141.89 | GATE_P99 |
| A06 | COMPLETED | 7/7 | 0 | 132.41 | GATE_P99 |
| A07 | COMPLETED | 7/7 | 0 | 39.16 | Không |
| A08 | COMPLETED | 7/7 | 0 | 159.18 | GATE_P99 |
| A09 | COMPLETED | 7/7 | 0 | 225.73 | GATE_P99 |
| A10 | COMPLETED | 7/7 | 0 | 212.86 | GATE_P99, GATE_ACHIEVED_RATE |
| A11 | COMPLETED | 7/7 | 0 | 96.55 | Không |
| A12 | COMPLETED | 7/7 | 0 | 44.37 | Không |
| A13 | COMPLETED | 7/7 | 0 | 247.15 | GATE_P99 |
| A14 | COMPLETED | 7/7 | 0 | 31.63 | Không |
| A15 | COMPLETED | 7/7 | 0 | 36.18 | Không |
| A16 | COMPLETED | 7/7 | 0 | 166.55 | GATE_P99, GATE_ACHIEVED_RATE |

P99/achieved-rate trượt không có nghĩa deploy hoặc correctness thất bại. Đây là smoke ngắn với ít mẫu, một máy Docker Desktop và có tác vụ kiểm tra/build cùng phiên; không dùng để xếp hạng hiệu năng. Tổng cấp phát của các profile mới khác nhau, cần kiểm soát tài nguyên khi so sánh nghiên cứu. Các image tag được rebuild trong phiên để sửa lỗi; báo cáo này là kiểm chứng chức năng, không phải campaign publication với một digest đóng băng.

## Lượt xác nhận checkout bất đồng bộ

FLASH_SALE_V1, 5 operation/giây, warmup 1 giây, đo 20 giây, pilot; E2E polling sampling tạm thời 100%, sau đó trả về mặc định. Cả bốn profile hoàn tất, qua 7/7 invariants, không lỗi HTTP/OOM/crash. Tổng 317 checkout được polling đến trạng thái cuối: tất cả xác nhận thành công, không đơn sampled bị treo.

| Profile | Checkout sampled | Confirmation rate | Unsettled rate |
|---|---:|---:|---:|
| A13 | 78 | 100% | 0% |
| A14 | 76 | 100% | 0% |
| A15 | 84 | 100% | 0% |
| A16 | 79 | 100% | 0% |

## Kiểm tra bổ sung

- 192 bài kiểm tra backend qua; gồm test PostgreSQL queue với transaction/idempotency, lease fencing, payment replay, decline/timeout trả tồn kho và cart giữa replica.
- Test kill rồi restart worker process thật qua; test rút ngắn thời gian chờ bằng cách đẩy lease deadline về quá khứ.
- Frontend build/lint, 2 unit test và 5 browser E2E qua; kiểm tra UI đang chạy ở localhost xác nhận 16 profile và tải prompt thật.
- Quan sát Redis trực tiếp xác nhận product-page cache có dữ liệu trong A10, A11 và A12.
- Registry validation, backend typecheck/build và script PowerShell parser qua.

## Bằng chứng và chạy lại

128 file artifact tải về của lượt đầu đã kiểm tra SHA256 với artifact registry. Experiment IDs nằm trong [campaign](../results/architecture-expansion-20261005/campaign.json); mỗi thư mục Axx có results, invariant-output, k6 summary, Compose log, resolved profile/template và report HTML. Lượt polling đầy đủ nằm trong [summary](../results/pg-queue-confirmation-20261005/summary.json).

```powershell
npm run registry:validate
npm run registry:export-ai
./scripts/smoke-all-architectures.ps1 -ApiBaseUrl http://localhost:8088/api/v1 -WorkloadProfile CHECKOUT_V1
```

Không cần bổ sung ENV để chạy các profile này bằng launcher Docker local hiện có. Dùng [prompt](ai-contract/prompt.vi.txt) để AI chọn candidate, rồi validate JSON trước khi tạo experiment. CQRS, read replica, serverless và các cấu hình ngoài registry vẫn cần triển khai riêng.
