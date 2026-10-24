# Chọn kiến trúc AI có thể chạy được

Registry hiện có 52 profile A01–A52. Mỗi profile là một topology cụ thể với
Compose template, process role, tài nguyên và cùng hợp đồng API e-commerce.
Đây là toàn bộ cấu hình **được triển khai trong repository**, không phải toàn bộ
kiến trúc phần mềm có thể tồn tại. Một tên kiến trúc hay mô tả tự do không đủ để
hệ thống tự sinh code và chạy nó.

## Các cấu hình mới

| ID | API monolith | Worker | Cache | CPU / RAM cấp phát |
|---|---:|---:|---|---|
| A13 | 1 | 1 | Không | 1,8 vCPU / 3392 MiB |
| A14 | 2 | 1 | Không | 1,8 vCPU / 3392 MiB |
| A15 | 2 | 1 | Redis cho sản phẩm | 1,9 vCPU / 3520 MiB |
| A16 | 2 | 2 | Redis cho sản phẩm | 2 vCPU / 3904 MiB |

Cả bốn dùng API gateway, PostgreSQL queue và giỏ hàng dùng chung trong PostgreSQL.
A14 hỗ trợ topology monolith + hai API + một worker + PostgreSQL queue mà AI đã
đề xuất. Việc này không đồng nghĩa mọi chi tiết của bản đề xuất đều được triển khai:
framework là Express và gateway là Node HTTP proxy; hủy đơn tuân theo hợp đồng SUT hiện tại, chỉ hủy đơn đã xác nhận;
không có TTL tự hủy đơn đang pending hay tích hợp nhà cung cấp thanh toán thật.

Checkout tạo đơn, giữ tồn kho và enqueue trong một transaction, trả `202`;
client polling `GET /orders/:id` để chờ kết quả. Worker claim bằng `SKIP LOCKED`,
lease 30 giây và token kiểm tra quyền hoàn tất. Thanh toán mock lưu ledger để replay
không charge hai lần. Finalize đơn, commit/release stock và ack job cùng transaction.
Worker chết sẽ được worker đang chạy hoặc worker khởi động lại lấy job sau khi lease hết.
Lỗi dependency chưa rõ kết quả được retry với backoff tối đa 30 giây;
`MOCK_FAIL` và `MOCK_TIMEOUT` kết thúc FAILED và trả tồn kho.
Các bảng kỹ thuật nằm trong schema `reliability`, tách khỏi năm bảng nghiệp vụ.

## Dùng với AI khác

1. Mở `http://localhost:8088/architectures`, tải **AI prompt** và **JSON schema**.
2. Thay `[THAY BẰNG YÊU CẦU CỦA BẠN]` trong prompt bằng yêu cầu cần đánh giá.
3. Gửi prompt cho AI. AI phải chọn một candidate trong catalog, giữ nguyên ID,
   family, components và decisions; có thể viết priorities và giải thích lựa chọn.
4. Dán JSON vào **New Experiment**, validate rồi chọn workload và chạy.

Không cần thêm biến môi trường cho A13–A16 khi dùng launcher Docker hiện có.
Snapshot pilot đã có sẵn; main/capacity cần snapshot riêng theo runbook hiện tại.
Không dùng phần mô tả văn xuôi hoặc JSON tùy ý thay cho candidate schema.
Validator sẽ từ chối ID chưa hỗ trợ, components khác profile, trộn decisions,
messaging mâu thuẫn, cache targets khác registry và TTL khác 60 giây.
Khi yêu cầu bắt buộc vượt catalog, prompt yêu cầu AI trả lỗi UNSUPPORTED_REQUIREMENTS;
không thay bằng một cấu hình gần giống để tránh sai kết luận nghiên cứu.

## Ma trận đầy đủ trong phạm vi runtime hiện có

13 topology × 4 chế độ Redis = 52 cấu hình, mỗi tổ hợp có đúng một ID.
A01–A16 giữ nguyên ID và topology; A17–A52 bổ sung các tổ hợp còn thiếu.
Xem [ma trận máy đọc được](ai-contract/matrix.json) và [catalog candidate](ai-contract/catalog.json).

| Nhóm | Các topology | Chế độ Redis cho mỗi topology |
|---|---|---|
| Monolith đồng bộ | 1 API; 2 API + gateway; 2 API + gateway + notification process | Không; product; cart; product + cart |
| REST microservices | Mỗi service 1 instance; scale catalog; scale order | Không; product; cart; product + cart |
| Event-driven microservices + RabbitMQ | Mỗi service 1 instance; scale catalog; scale order | Không; product; cart; product + cart |
| Monolith + PostgreSQL queue | 1 API/1 worker; 2 API/1 worker; 1 API/2 worker; 2 API/2 worker | Không; product; cart; product + cart |

Redis cart là kho giỏ hàng dùng chung, không phải queue.
Broker NONE xử lý checkout đồng bộ; POSTGRES/RABBITMQ xử lý checkout bất đồng bộ.
Tên DUAL_APP_PROXY_ASYNC chỉ nói về notification bất đồng bộ, không có checkout worker.
Khi không chọn cart trong
Redis, giỏ hàng dùng schema kỹ thuật PostgreSQL trên mọi profile. Cache product
chỉ được bật khi targets chứa product; bật Redis cart không tự bật cache product.
Thao tác Redis cart cập nhật từng field bằng HSET/HDEL, tránh mất cập nhật giữa replica.

Để tái sinh các profile bổ sung: `npm run registry:expand-matrix`, rồi validate và export AI.
Generator giữ nguyên A01–A16; các ID còn lại được sinh theo thứ tự ổn định.
Đây là ma trận lựa chọn được hỗ trợ, không bao phủ mọi tổ hợp công nghệ hay mọi số replica.
SUT dùng Node.js/Express, gateway Node HTTP proxy và một PostgreSQL database dùng chung.
Các profile microservices chia process/API; chưa hỗ trợ database-per-service. Yêu cầu
đổi framework, database hoặc gateway bắt buộc phải được xem là chưa hỗ trợ, không đổi tên profile.
Monolith + RabbitMQ, Kafka, Redis queue, read replica, CQRS, event sourcing và serverless
chưa có runtime trong catalog này. Hexagonal/Clean Architecture/DDD là cách tổ chức code,
không thể khẳng định đã kiểm chứng chỉ vì topology triển khai tương tự.

Mọi cấu hình nằm dưới quota 2 vCPU/4096 MiB. Profile không Redis bỏ tài nguyên Redis,
nên tổng tài nguyên giữa các profile có thể khác: khi so sánh nghiên cứu phải nêu rõ
đang so chi phí cấp phát thực tế hay giữ ngân sách bằng nhau. Không xem smoke là kết quả SLO.

## Liệt kê và kiểm tra bằng lệnh

Trong thư mục backend:

```powershell
npm run registry:validate
npm run registry:export-ai
./scripts/smoke-all-architectures.ps1 -ApiBaseUrl http://localhost:8088/api/v1 -WorkloadProfile CHECKOUT_V1
```

Exporter tạo [prompt tiếng Việt](ai-contract/prompt.vi.txt),
[schema](ai-contract/supported-candidate.schema.json) và [catalog JSON](ai-contract/catalog.json).
Khi AI hỗ trợ đầu ra JSON theo schema, dùng [schema câu trả lời](ai-contract/ai-selection.schema.json):
schema này cho phép candidate hợp lệ hoặc lỗi UNSUPPORTED_REQUIREMENTS. Chỉ candidate
được validate và chạy experiment. `ttlSeconds` chỉ áp dụng cache product, không áp dụng kho cart.
API `GET /api/v1/architectures/ai-contract` luôn sinh từ registry đang chạy,
nên UI không cần giữ danh sách ID riêng.
Smoke script tự đọc toàn bộ ID từ API, chạy từng profile, lưu kết quả và kiểm tra
correctness/stability. Có thể giới hạn một nhóm bằng `-Architectures A13,A14,A15,A16`.
Để thu thập lại artifact của campaign đã có mà không tạo experiment mới, dùng
`-EvidenceDirectory results/ten-campaign -CollectOnly` cùng ApiBaseUrl tương ứng.

Một profile hoàn tất với invariants đúng vẫn có thể trượt P99 hoặc throughput.
P99 trong bảng HTTP không phải latency đến lúc đơn hoàn tất: với checkout 202,
cần đánh giá thêm kết quả polling/confirmation thay vì so trực tiếp với checkout đồng bộ.
Lượt smoke ngắn phục vụ xác nhận runtime; không dùng nó để kết luận khả năng tải,
xếp hạng kiến trúc hay bảo đảm SLO. Các profile mới có tổng tài nguyên khác nhau
như bảng trên, nên cần kiểm soát biến này trong nghiên cứu so sánh hiệu năng.
