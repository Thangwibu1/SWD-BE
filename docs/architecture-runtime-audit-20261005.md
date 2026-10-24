# Kiểm tra chạy thực tế A01–A12 — 05/10/2026

Đã chạy đủ 12 kiến trúc bằng Docker trên máy local, qua evaluator API và worker thật. Cả 12 hoàn tất deploy, restore dataset, readiness, smoke test, workload, thu thập metrics, invariant oracle và cleanup. Đây là xác nhận khả năng chạy nghiệp vụ ở tải nhỏ; chưa phải chứng nhận đạt toàn bộ SLO hay capacity production.

## Campaign đầu: MIXED_V1

Dataset `pilot`, 5 thao tác/giây, warmup 2 giây, đo 30 giây, cooldown 2 giây, một repetition cho mỗi kiến trúc. Tổng cộng 1.806 thao tác đo; error rate HTTP, dropped iterations, OOM và unexpected crashes đều bằng 0 trong phần đo của từng kiến trúc.

| Kiến trúc | Trạng thái | Invariant lượt đầu | P99 (ms) | Gate chưa đạt |
|---|---|---|---:|---|
| A01 | COMPLETED | 7/7 | 38.13 | Không |
| A02 | COMPLETED | 7/7 | 15.99 | Không |
| A03 | COMPLETED | 7/7 | 50.08 | Không |
| A04 | COMPLETED | 7/7 | 70.29 | Không |
| A05 | COMPLETED | 7/7 | 229.69 | P99 |
| A06 | COMPLETED | 7/7 | 159.61 | P99, achieved rate |
| A07 | COMPLETED | 7/7 | 132.97 | P99 |
| A08 | COMPLETED | 7/7 | 117.78 | P99 |
| A09 | COMPLETED | 6/7 | 134.74 | P99 |
| A10 | COMPLETED | 6/7 | 278.34 | P99, achieved rate |
| A11 | COMPLETED | 6/7 | 403.70 | P99 |
| A12 | COMPLETED | 7/7 | 125.62 | P99, achieved rate |

SLO dùng trong smoke: P99 ≤ 100 ms, error rate ≤ 1%, không vi phạm invariant critical; achieved rate phải đạt ít nhất 95% tải yêu cầu. `COMPLETED` chỉ nói pipeline hoàn tất, không đồng nghĩa mọi gate đều đạt.

## Hai lỗi đo đã sửa và kiểm tra lại

1. `K6_E2E_POLL_SAMPLE_RATE=` trước đây bị chuyển thành số 0, khiến không lấy mẫu xác nhận đơn. Env trống/whitespace nay dùng mặc định cố định 1%; env mẫu và env local được điền `0.01`. Giá trị `0` và `1` vẫn có ý nghĩa cấu hình rõ ràng.
2. INV-05 đọc baseline ngay khi order chuyển CONFIRMED, trong khi event inventory commit có thể chưa xử lý xong. A09–A11 vì vậy báo sai reserved trước/sau cancellation. Oracle nay đợi reservation của chính order đó settle rồi mới đọc baseline.

Sau sửa, chạy lại A09–A12 bằng `CHECKOUT_V1`, 1 thao tác/giây, đo 20 giây, sampling 100%. Workload này gồm cart, checkout và order read; chỉ những thao tác checkout được tính vào số đơn theo dõi.

| Kiến trúc | Trạng thái | Invariant sau sửa | Đơn theo dõi | CONFIRMED | Unsettled | P99 (ms) |
|---|---|---|---:|---:|---:|---:|
| A09 | COMPLETED | 7/7 | 10 | 10 | 0 | 314.68 |
| A10 | COMPLETED | 7/7 | 13 | 13 | 0 | 168.76 |
| A11 | COMPLETED | 7/7 | 12 | 12 | 0 | 278.33 |
| A12 | COMPLETED | 7/7 | 11 | 11 | 0 | 521.20 |

Cả 46 đơn theo dõi đều CONFIRMED. Bốn lượt không lỗi HTTP trong phần đo, không dropped iteration, không crash/OOM và cleanup thành công. Cả bốn chưa đạt P99 100 ms; A11–A12 còn chưa đạt gate achieved rate ở lượt ngắn này. Không so sánh trực tiếp P99 giữa hai campaign vì workload và sampling khác nhau.

## Vấn đề còn lại

- A05–A12 chưa đạt SLO độ trễ đã cấu hình trong campaign MIXED; cần tối ưu và đo dài hơn trước khi kết luận capacity.
- Log A06 có một HTTP 503 `DEPENDENCY_UNAVAILABLE` trong bước oracle gửi checkout đồng thời, ngoài phần tải đo. Stack trace chỉ đến nhánh không lấy được advisory lock trong `src/sut/services/order/rest-saga.ts`: request tranh khóa cùng order với recovery worker. Đây là vấn đề concurrency còn tồn tại, chưa sửa trong lượt audit này. Invariant tồn kho vẫn đạt; không nên diễn giải error rate 0 của workload thành không bao giờ có lỗi HTTP.
- Lượt này không chạy toàn bộ bốn workload cho từng kiến trúc, không chạy sustained load/capacity campaign và không fault-inject từng replica của cả 12 profile.

## Kiểm chứng và bằng chứng

- 89/89 unit, contract và evaluator-golden tests đạt; gồm regression cho sampling trống và inventory commit trễ.
- Typecheck, lint, Docker build backend/frontend và Compose startup đạt. Giao diện `/architectures` và API danh sách trả đủ 12 profile.
- Evidence campaign đầu: `results/architecture-audit-20261005/`.
- Evidence chạy lại: `results/architecture-event-recheck-20261005/`.
- Mỗi thư mục Axx có experiment/transitions, results/gates, invariant output, Compose log, resolved Compose/profile, k6 summary, load configuration, environment và HTML report. Experiment IDs nằm trong `campaign.json`; các artifacts đầy đủ cũng còn trong evaluator volume và truy cập qua API/giao diện.
- Image đầu: `sha256:bedcfc9b2f4194d08a95d4cc642b6dcc166e3437b07c5c745c477f1e133fdfb9`.
- Image sau sửa: `sha256:cf950dc23a49b791efa05c2a9175d982269c9599b4cb9e6e0e71ba294b79b9ca`, đã gắn lại tag local `architecture-evaluation-backend:0.1.0`.
- Kiểm tra cleanup cuối: không còn container, network hay volume thuộc 16 lượt chạy này; scrape target SUT cũ đã được xóa. Bằng chứng: `results/architecture-audit-20261005/final-health-cleanup.json`. Network/cache cũ ngoài phạm vi các lượt audit được giữ nguyên.

Sau kiểm tra, sampling của evaluator được trả về mặc định 1%, giữ giao diện/API chạy tại `http://localhost:8088`. Các sửa đổi của audit vẫn ở workspace, chưa push.
