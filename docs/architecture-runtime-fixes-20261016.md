# Sửa lỗi điều phối và đo runtime — 16/10/2026

## Kết quả cuối

**21/21 lượt kiểm tra sau sửa đã COMPLETED**, gồm toàn bộ 20 profile từng có FAILED và A25. Không có FAILED mới, không còn experiment hoạt động hoặc lease bị giữ; worker đã idle, mọi SUT container đã được cleanup.

- Cả 21 lượt đều có coverage 100%, 7/7 invariant qua, HTTP error rate 0 và stability qua. Thời lượng đo thực tế nằm trong 19,454–22,577 giây cho cấu hình 20 giây.
- A24, trước đó lỗi coverage cả ở 20 và 60 giây, nay hoàn tất ở 20 giây: coverage 100%, P99 khoảng 25,89 ms, mọi gate qua.
- **13/21** lượt vẫn trượt duy nhất P99 100 ms: A05, A06, A07, A08, A09, A13, A16, A25, A34, A35, A38, A39, A49. Không có gate khác trượt. Đây là hạn chế hiệu năng cần giữ trong dữ liệu, chưa được giải quyết bằng bản sửa collector.
- Kiểm chứng đủ **83 file JavaScript** của worker đang triển khai khớp build local. Đã lưu **483 artifact** của 21 experiment và kiểm tra khớp mọi SHA256.
- Lịch sử vẫn giữ nguyên 32 run FAILED và 16 CANCEL_REQUESTED; số run COMPLETED tăng từ 188 lên 209. Các yêu cầu đã hủy không bị khởi động lại.

Bảng kết quả cuối: [final-verification.csv](../results/architecture-fix-20261016/final-verification.csv), [final-verification.json](../results/architecture-fix-20261016/final-verification.json). Kiểm chứng artifact: [archive-verification.json](../results/architecture-fix-20261016/archive-verification.json). Đối chiếu mã triển khai: [code-fingerprint.json](../results/architecture-fix-20261016/code-fingerprint.json).

## Phạm vi và nguyên nhân

Rà toàn bộ SQLite đang chạy trước khi triển khai bản sửa: 32 run FAILED thuộc 20 architecture ID, 188 run COMPLETED và 16 run CANCEL_REQUESTED. Không có run bị bỏ dở trong các trạng thái triển khai/đo/cleanup. Trong hệ thống hiện tại, CANCEL_REQUESTED cũng là trạng thái kết thúc sau hủy; không tự khởi chạy lại các yêu cầu đã bị người dùng hủy.

24 lỗi lịch sử có mã `INFRA_INVALID_EXHAUSTED`; 8 lỗi `INTERNAL_ERROR` cũ liên quan deploy, HTTP 504 hoặc kết nối bị từ chối. Kết quả smoke A01–A52 trước bản sửa đã kiểm tra lại runtime của các profile này. Giữ nguyên toàn bộ trạng thái và bằng chứng cũ; một architecture có lịch sử FAILED không đồng nghĩa lần chạy hiện tại vẫn lỗi.

Ba lỗi được sửa trong mã điều phối:

1. Bộ thu `docker stats --no-stream` mất hơn 2 giây mỗi snapshot nhưng bộ tính coverage đòi chu kỳ 2 giây. Đổi lịch thu tài nguyên sang 5 giây, phù hợp chi phí thu thực tế; mỗi khoảng 5 giây trong cửa sổ đo chỉ được tính tối đa một mẫu. Mẫu trùng, ngoài cửa sổ hoặc kết thúc sau khi dừng đo không bù cho khoảng bị thiếu. Ngưỡng coverage vẫn là 95%. Độ phân giải tài nguyên giảm và được ghi rõ trong metadata; không gộp với chuỗi tài nguyên cũ.
2. Gate validity chỉ có cận dưới thời gian, nên A25 cấu hình 20 giây nhưng chạy 564,411 giây vẫn được coi là evidence hợp lệ. Thêm cận trên `scheduled + 60s`, cho phép thời gian hoàn tất request/khởi chạy/xuất kết quả nhưng loại bất thường lớn. Đây là kiểm tra tính hợp lệ; không biến latency cao hoặc thiếu throughput thành lỗi hạ tầng.
3. Controller parse `limit`/`offset` nhưng không truyền xuống repository, khiến lịch sử chỉ trả mặc định 50 bản ghi và bỏ qua trang tiếp theo. Truyền đúng cả hai tham số, thêm khóa sắp xếp theo ID khi thời gian tạo trùng nhau.

Thông báo lỗi hạ tầng mới chứa gate trượt, giá trị quan sát, ngưỡng và retry limit thực tế, kể cả trường hợp retry limit bằng 0. Không còn luôn nói “after deterministic retry” khi không có lần thử lại.

## Phiên bản và triển khai

- `resourceMeasurementVersion=2.0.0`, `containerStatsIntervalMs=5000`, `gateEvaluationVersion=2.0.0` trong metrics và environment artifacts.
- Giữ nguyên phiên bản ngữ nghĩa chỉ số tải `measurementSchemaVersion=2.0.0`.
- SUT giữ image ID `sha256:4e4740c07041cd117a570319765e343eb1c0f53fbf00c70577d4fca3cdf7f7fa`; không thay đổi topology, tài nguyên, workload hoặc SLO để làm kết quả qua.
- Controller/worker dùng tag riêng `architecture-evaluation-backend:measurement-fix-20261016`. Build đầy đủ gặp lỗi npm `ECONNRESET`; image triển khai kế thừa image runtime đã xác minh, thêm `dist/` biên dịch từ source hiện tại. Dockerfile và protocol được lưu cùng evidence. Dependency runtime giữ nguyên.
- File cấu hình triển khai tại `results/architecture-fix-20261016/runtime.env`. Nếu chạy lại Compose bằng env example cũ, image controller sẽ quay về tag cũ; dùng file này để giữ bản sửa trên máy hiện tại:

```powershell
docker compose --env-file results/architecture-fix-20261016/runtime.env -f infra/deploy/compose.yaml up -d backend worker
```

Chưa thay migration, chưa sửa/xóa trạng thái experiment cũ và giữ nguyên Docker volumes.

## Kiểm chứng

Build, typecheck, lint và 209 unit/contract tests qua. Regression tests tái hiện snapshot mất 2,6 giây, loại mẫu hoàn tất muộn/trùng/ngoài cửa sổ, A25 kéo dài 564 giây, phân biệt capacity failure với invalid evidence và phân trang qua HTTP API. Kiểm tra API đang triển khai: hai trang `limit=1`, offset 0/1 trả hai experiment khác nhau và cùng total.

Campaign kiểm tra sau sửa gồm toàn bộ 20 profile từng FAILED, cộng A25: A01–A09, A11–A14, A16, A24, A25, A34, A35, A38, A39, A49. Mỗi profile chạy một lần ở 2 operations/s, warm-up 5 giây, measure 20 giây, cooldown 0, không retry tự động; SLO vẫn là P99 100 ms, error rate tối đa 1%. Cửa sổ đo ngắn dùng để tái hiện lỗi collector, không dùng xếp hạng hiệu năng cho bài báo.

Kết quả từng lượt tại [verification.json](../results/architecture-fix-20261016/verification.json) và [verification.csv](../results/architecture-fix-20261016/verification.csv). Danh sách lỗi cũ cố định tại [historical-failures.json](../results/architecture-fix-20261016/historical-failures.json); protocol và image ID tại [protocol.json](../results/architecture-fix-20261016/protocol.json).

COMPLETED không đồng nghĩa đạt P99. Các lần trượt SLO phải giữ nguyên và cần nghiên cứu capacity/độ trễ riêng. Bản sửa này xử lý lỗi điều phối và tính hợp lệ của phép đo; không bảo đảm mọi topology đạt 100 ms trên cùng ngân sách máy.
