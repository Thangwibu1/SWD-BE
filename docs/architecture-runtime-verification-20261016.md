# Kiểm tra runtime toàn catalog — 16/10/2026

## Kết quả cuối

**52/52 cấu hình A01–A52 đã có ít nhất một lượt smoke hợp lệ trên cùng image**, đủ 7/7 invariant, HTTP error rate bằng 0, correctness/stability và cleanup qua. Toàn bộ 13 topology × 4 chế độ Redis đã được chạy thực tế.

- Tổng **64 experiment**: 52 lượt ban đầu, 10 lượt đo lại 60 giây, một lượt 120 giây cho A24, một lượt 120 giây kiểm tra bất thường thời gian ở A25.
- Đợt đầu: **42 COMPLETED / 10 FAILED** do coverage tài nguyên. Đợt 60 giây: **9 COMPLETED / 1 FAILED**. A24 đo lại 120 giây hoàn tất và qua mọi gate.
- Giữ nguyên **11 experiment FAILED** và lượt A25 có thời gian bất thường; không sửa trạng thái hoặc xóa evidence cũ.
- Tất cả 64 lượt đều qua 7/7 invariant nghiệp vụ, HTTP error rate 0 và stability qua.
- **33/52** lượt smoke được chọn vẫn trượt `GATE_P99` 100 ms. Đây là xác nhận chạy được, không phải xác nhận tất cả kiến trúc đạt SLO. Các gate khác của 52 lượt được chọn đều qua, gồm achieved rate.
- Đã sao lưu **1.472 artifacts**, tổng 43.162.768 byte; tất cả SHA256 khớp index của evaluator. Worker kết thúc ở trạng thái idle, không còn SUT container chạy.

Kết quả cuối có cả lịch sử từng lần thử: [final-verification.csv](../results/architecture-runtime-20261016/final-verification.csv), [final-verification.json](../results/architecture-runtime-20261016/final-verification.json). Kiểm chứng toàn bộ artifacts: [archive-verification.json](../results/architecture-runtime-20261016/archive-verification.json).

## Phạm vi

Đợt kiểm tra này chạy lại A01–A52 trên cùng một image để thay cho việc suy rộng từ kết quả của một profile hoặc từ image cũ. Catalog gồm 13 topology × 4 chế độ Redis.

- Docker image ID trên máy này: `sha256:4e4740c07041cd117a570319765e343eb1c0f53fbf00c70577d4fca3cdf7f7fa`.
- Đã so hash nội dung chuẩn hóa LF của **83 file JavaScript** trong `dist/`: image khớp build local hiện tại.
- Đã so thêm **133 file định nghĩa runtime** (registry, Compose template, schema, workload, cost/score catalog, SQL và pilot snapshot manifest), cùng khai báo dependencies: tất cả khớp local/image; xem `input-fingerprint.json`.
- `npm run registry:validate`: **52/52** qua schema, render/deployment audit, kiểm tra process/resource allocations.
- Mỗi profile: `MIXED_V1`, 2 operations/s, warm-up 5 giây, measure 20 giây, cooldown 0, 1 repetition; snapshot `pilot-20261001`.
- Một worker, không chạy nhiều SUT benchmark đồng thời.
- Đây là campaign smoke riêng, không phải dữ liệu AI hoặc experiment publication.

## Bằng chứng

Campaign gốc đã kết thúc đủ 52 experiment. Kết quả ban đầu được giữ trong [verification.json](../results/architecture-runtime-20261016/verification.json) và [verification.csv](../results/architecture-runtime-20261016/verification.csv). Bảng này giữ nguyên 10 lượt FAILED; dùng `final-verification` để xem đầy đủ kết quả sau kiểm tra lại. Không coi static validation hoặc trạng thái COMPLETED riêng lẻ là đủ xác nhận chạy đúng.

Các lượt kết thúc với `INFRA_INVALID_EXHAUSTED` được xếp hàng đo lại riêng: warm-up 10 giây, measure 60 giây, các mức tải/SLO/dataset/image giữ nguyên. Chỉ xếp một lượt đo lại tự động cho mỗi ID; không lặp đến khi đạt P99 và không hạ gate coverage 95%. Đợt đo lại nằm trong `results/architecture-runtime-20261016-recheck60/`, với protocol và campaign riêng. Kết quả tổng hợp hai đợt ở [combined-verification.json](../results/architecture-runtime-20261016/combined-verification.json) và [combined-verification.csv](../results/architecture-runtime-20261016/combined-verification.csv); giữ đủ cả experiment gốc và experiment đo lại. Chỉ chọn một lượt hợp lệ để xác minh deployability, không gộp các cửa sổ 20/60 giây để xếp hạng hiệu năng.

A24 vẫn có coverage 90% ở lượt 60 giây, nên được kiểm tra thêm đúng một lượt 120 giây, warm-up 10 giây, cùng SLO và target 2 operations/s. Lượt này hoàn tất, P99 khoảng 54,80 ms và không gate trượt; xem `results/architecture-runtime-20261016-recheck120/`.

Rà soát raw evidence phát hiện lượt A25 gốc được cấu hình 20 giây nhưng thực tế có measurement window **564,411 giây**, chỉ đạt **0,07281 operations/s** (3,64% target), dù 41 iteration hoàn thành và nghiệp vụ qua. Không suy đoán nguyên nhân hoặc coi lượt đó là bằng chứng chạy đúng tốc độ tải. Giữ nguyên trạng thái COMPLETED với `GATE_ACHIEVED_RATE` trượt, rồi chạy riêng 120 giây trong `results/architecture-runtime-20261016-timing-recheck120/`. Lượt kiểm tra lại qua achieved rate; P99 118,18 ms vẫn trượt và được giữ nguyên. Việc đo lại này do bất thường thời gian, không phải để chọn P99 đẹp hơn.

Thư mục `results/architecture-runtime-20261016/` lưu:

- `image-fingerprint.json`: image ID, hash từng file runtime, đối chiếu local/image.
- `environment.json`: phiên bản Docker/Node, CPU và tài nguyên Docker host, cấu hình smoke.
- `ai-contract.json`: catalog/schema từ evaluator thực tế.
- `campaign.json`: ánh xạ A01–A52 sang experiment ID.
- `Axx-detail.json`, `Axx-artifacts.json`: trạng thái và evidence index của từng experiment kết thúc.
- `oracles/Axx.json`: raw invariant output tải từ evaluator, đã đối chiếu SHA256.
- `verification.json/csv`: bảng tổng hợp giữ cả lỗi, gate trượt và profile chưa hoàn tất.
- `final-verification.json/csv`: 52 profile cùng experiment được chọn, window, tất cả lần thử và gate trượt.
- `archive/`: toàn bộ raw/input/report/environment của cả 64 experiment, tách theo phase và architecture.
- `archive-verification.json`: SHA256 kỳ vọng/thực tế của từng artifact đã sao lưu.
- `collect.mjs`: collector đọc lại trạng thái và evidence, không tạo experiment mới.

Đọc lại evidence đợt đầu (không tạo experiment):

```powershell
node results/architecture-runtime-20261016/collect.mjs
```

Chạy lại toàn catalog bằng helper (tạo experiment mới):

```powershell
./scripts/smoke-all-architectures.ps1 -ApiBaseUrl http://localhost:8088/api/v1
```

Sau audit, mặc định helper được đổi sang warm-up 10 giây, measure 120 giây và timeout 240 phút cho toàn catalog. Các lượt audit ở trên giữ nguyên cấu hình đã lưu; thay đổi này chỉ áp dụng cho lần gọi helper tiếp theo. PowerShell parser kiểm tra helper mới không có lỗi. Không thay mã SUT, image hoặc ngưỡng gate để làm các lượt kiểm tra qua.

## Điều kiện xác nhận chạy được

Một profile chỉ được đánh dấu `runtimeVerified=true` khi:

1. Experiment `COMPLETED`, gồm triển khai, readiness, reset dataset, functional smoke, load, verify, scoring và cleanup.
2. Đủ **7/7 invariant nghiệp vụ** qua, gồm không tồn kho âm, idempotency order, tổng tiền, payment replay, hủy hoàn tồn kho, chống overselling và trạng thái cuối. Kiểm cả invariant WARNING, không chỉ CRITICAL.
3. Artifact invariant đúng SHA256 đã đăng ký trong evaluator.
4. Gate correctness và stability qua.
5. HTTP error rate bằng 0 ở cửa sổ smoke.

Gate hiệu năng vẫn được ghi nguyên trạng. Profile chạy được có thể trượt P99/achieved rate hoặc gate đo lường; không đổi SLO để làm đẹp kết quả và không coi `COMPLETED` đồng nghĩa mọi gate đều qua. Kết quả lỗi và lượt đo lại, nếu có, phải được giữ riêng.

## Giới hạn

Smoke ngắn trên Docker Desktop xác nhận deployability và các đường nghiệp vụ được thực thi trong lượt kiểm tra. Nó không bảo đảm không còn lỗi, mọi endpoint và failure mode đều đã phủ, đạt production SLO, HA, hoặc chịu được các mức tải 20–100 operations/s trong study AI. Những kết luận đó cần workload, số mẫu, repetition và fault/recovery tests tương ứng. Xem [audit trước](architecture-audit-20261006.md) để đối chiếu thay đổi runtime và phân biệt bằng chứng ngày 05/10 với ngày 06/10.
