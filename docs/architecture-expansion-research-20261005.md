# Đề xuất kiến trúc bổ sung để benchmark

Ngày nghiên cứu: 05/10/2026. Đây là bản đề xuất ban đầu; các ID trong phần nghiên cứu bên dưới chỉ là tên dự kiến, không phải registry hiện hành. Sau đó A13–A16 được cấp cho bốn biến thể monolith + PostgreSQL queue + worker. Xem `architecture-registry/` và `docs/ai-contract/catalog.json` để lấy cấu hình thực sự đã triển khai. CQRS, read replica và dữ liệu riêng từng service trong bản nghiên cứu này chưa được hỗ trợ.

## Kết luận đề xuất

Nên bổ sung ba profile đầu tiên: service với ranh giới lớn hơn, web–queue–worker và primary/read replica. Chúng kiểm tra ba thay đổi mà bộ A01–A12 chưa đại diện rõ: mức độ chia nhỏ service, vị trí xử lý checkout và cấu trúc phục vụ dữ liệu đọc. Khi cần mở rộng nghiên cứu về dữ liệu phân tán, bổ sung CQRS và một cặp saga có quyền sở hữu dữ liệu riêng.

Đây là đánh giá cho repository này, không phải tuyên bố các kiến trúc mới chắc chắn nhanh hơn. Cần đo để xác nhận hoặc bác bỏ giả thuyết.

## Bộ hiện tại đang bao phủ gì?

- A01–A04: modular monolith, thêm cache, replica/proxy và notification bất đồng bộ.
- A05–A08: REST microservices, thêm cache hoặc scale catalog/order.
- A09–A12: event-driven microservices, thêm cache hoặc scale catalog/order/event worker.
- Các profile dùng một PostgreSQL chung cho dữ liệu nghiệp vụ. Nhiều service có quyền truy cập cùng bảng; chưa có ranh giới sở hữu dữ liệu độc lập được cưỡng chế.
- A04 gửi notification qua HTTP fire-and-forget. Nó chưa đại diện cho checkout được đưa vào durable queue và chạy trong worker riêng.
- Cache và số lượng replica đã có đối chứng. CQRS, read replica và data ownership chưa có đối chứng tương đương.

Bằng chứng local: `architecture-registry/A01.yaml`–`A12.yaml`, `infra/sut-templates/`, `src/sut/monolith/bootstrap.ts`, `src/sut/services/`, và báo cáo `architecture-runtime-audit-20261005.md`.

## Giai đoạn 1: ba profile đáng làm trước

### A13 — Service-based với service lớn hơn

**Topology:** gateway → identity/catalog service + commerce service; commerce giữ order và inventory cùng tiến trình, dùng local transaction cho tồn kho/đơn; payment mock giữ hành vi tương đương baseline. PostgreSQL chung, chưa thêm cache trong profile đầu.

**Đối chứng:** A01 và A05, cùng phiên bản, dữ liệu, payment behavior và tổng ngân sách tài nguyên.

**Giả thuyết:** bớt HTTP hop giữa order/inventory và bớt tiến trình có thể giảm overhead ở ngân sách 2 vCPU, nhưng giảm mức độ scale/triển khai riêng từng module. Đây là giả thuyết từ cấu trúc code và kết quả local, chưa được benchmark.

**Test:** CHECKOUT/MIXED; P99 checkout, confirmed throughput, CPU/RAM, DB connection wait và số HTTP hop. Khi commerce chậm, kiểm tra catalog còn đáp ứng ra sao. Không đồng thời thêm cache/circuit breaker để tránh trộn nhiều nguyên nhân.

**Độ khó dự kiến:** vừa; có thể tái sử dụng các module monolith nhưng phải tạo role, router và Compose mới.

### A14 — Web–Queue–Worker cho checkout

**Topology:** web/API giữ các module đọc và nhận checkout → ghi PENDING + transactional outbox → RabbitMQ → checkout worker chạy phần xử lý order/inventory/payment. Worker giữ phần nghiệp vụ gắn kết thay vì tách mỗi bước thành một microservice. Đơn nhận thành công trả 202 và có API đọc kết quả cuối.

**Đối chứng:** A01 cho xử lý đồng bộ và A09 cho pipeline nhiều service. Không coi ba cấu hình này chỉ khác một biến; chúng đo tradeoff của cả topology, còn cache/resource phải giữ theo thiết kế đã công bố.

**Test:** FLASH_SALE/CHECKOUT, backlog và tuổi message, thời gian accepted→CONFIRMED, tốc độ thoát backlog sau burst, duplicate/replay và kill/restart worker. Phải giới hạn consumer concurrency và admission; 202 nhanh mà backlog tăng mãi không được tính là thành công.

**Độ khó dự kiến:** vừa; tái sử dụng outbox/inbox, RabbitMQ, retry và dead-letter đã có.

Microsoft mô tả [Web–Queue–Worker](https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/web-queue-worker) như lớp web và worker tách biệt, giao tiếp qua queue. [Queue-based load leveling](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling) dùng queue để hấp thụ burst, nhưng cần kiểm soát tốc độ xử lý và backlog. [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) lưu event cùng transaction cập nhật nghiệp vụ rồi relay ra broker; đó là cơ sở cho cách nhận đơn ở profile này.

### A15 — Primary + read replica

**Topology:** lấy A01 làm baseline, thêm PostgreSQL standby; product list/detail/search đọc replica. Checkout, kiểm tra tồn kho và order status ngay sau ghi tiếp tục đọc primary. Không bật cache trong đối chứng đầu để thấy ảnh hưởng riêng của replication.

**Đối chứng:** A01. Standby phải nằm trong cùng ngân sách tổng; không cấp thêm CPU/RAM miễn phí cho profile mới.

**Test:** BROWSING/MIXED, write pressure + read pressure, replication lag, độ mới của product data, xử lý replica down và số query bị hủy do xung đột WAL replay. Không gọi một standby duy nhất là giải pháp HA hoàn chỉnh; failover cần thiết kế riêng.

**Độ khó dự kiến:** vừa đến cao; phải thay restore flow, replication readiness và routing pool.

[PostgreSQL 16 Hot Standby](https://www.postgresql.org/docs/16/hot-standby.html) hỗ trợ truy vấn read-only khi replay WAL. Replica có thể chậm hơn primary; query dài cũng có thể xung đột với replay. Vì vậy phép đo phải bao gồm freshness và lag, không chỉ latency.

## Giai đoạn 2: ba profile cho nghiên cứu dữ liệu

### A16 — CQRS với read model riêng

**Topology:** command vẫn cập nhật trạng thái chuẩn; event cập nhật projection phục vụ truy vấn catalog/order summary. Có thể bắt đầu bằng projection trong schema kỹ thuật riêng, không thay đổi năm loại bảng nghiệp vụ gốc.

**Đối chứng:** lấy một topology event-driven cố định làm baseline, giữ broker và cache behavior tương đương. Khác A15: projection có mô hình truy vấn riêng, không chỉ sao chép bảng gốc.

**Test:** đọc dưới tải ghi, projection lag, rebuild projection, duplicate/out-of-order events và correctness/freshness. Phải định nghĩa endpoint nào chấp nhận eventual consistency; không đưa kiểm tra tồn kho có tính quyết định sang projection trễ.

**Độ khó:** cao. [CQRS](https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs) tách mô hình đọc và ghi, cho phép tối ưu riêng từng bên; cấu hình tách store cần giải quyết đồng bộ và eventual consistency. CQRS không bắt buộc event sourcing.

### A17/A18 — Dữ liệu riêng + Saga orchestration/choreography

**Mục tiêu:** kiểm tra ảnh hưởng của quyền sở hữu dữ liệu và cách phối hợp transaction khi không còn thao tác trực tiếp lên bảng của service khác.

**A17:** order orchestrator gửi command/reply tới inventory và payment, mỗi bên chỉ sửa dữ liệu thuộc mình.

**A18:** cùng ranh giới dữ liệu, cùng broker/resource, nhưng service phối hợp qua domain events. Cặp này mới giúp so sánh orchestration với choreography tương đối rõ; chỉ thêm một cấu hình sẽ trộn ảnh hưởng của data ownership và cách phối hợp.

**Đối chứng:** A17↔A18 là cặp chính; A05/A09 là đối chứng bổ sung cho mô hình shared database hiện tại.

Có thể bắt đầu bằng schema/logical database riêng và credentials giới hạn trong một PostgreSQL để phù hợp ngân sách. Nhiều PostgreSQL container là một biến thể tiếp theo về isolation vật lý; không mặc định phải một container cho mỗi service.

**Test:** compensation khi payment declined/timeout, concurrent oversell, service restart, duplicate delivery, mất kết nối từng dependency, schema-change isolation và end-to-end confirmation. Oracle phải lấy bằng chứng từ từng store hoặc API xác minh phù hợp, không bỏ kiểm tra vì không còn cross-service SQL JOIN.

**Độ khó:** cao. [Database per service](https://microservices.io/patterns/data/database-per-service.html) yêu cầu dữ liệu riêng chỉ được service chủ sở hữu truy cập; có thể thực hiện bằng ranh giới logical database/schema và quyền truy cập. [Saga](https://microservices.io/patterns/data/saga.html) phối hợp các local transaction và compensation theo hai cách orchestration/choreography. [Shared database](https://microservices.io/patterns/data/shared-database.html) là đối chứng phù hợp với cấu hình hiện tại.

## Những bổ sung nên xem là cấu hình kiểm thử

Circuit breaker, bounded retry, bulkhead, giới hạn concurrency, DB pool tuning và gateway routing không nhất thiết là các family mới. Nên tạo đối chứng cấu hình, thay từng cơ chế một trên topology cố định. [Bulkhead](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead) cô lập tài nguyên cho từng dependency để hạn chế lỗi lan truyền; phù hợp với thử nghiệm payment chậm trong khi catalog vẫn nhận tải.

Lỗi 503 do request tranh khóa với recovery ở A06 nên được xử lý và kiểm tra hồi quy trước khi dùng REST làm baseline mới. Đây là vấn đề correctness/resilience hiện tại; thêm profile khác không thay thế việc sửa baseline.

## Điều kiện để kết quả mới có ý nghĩa

1. Giữ A01–A12 và protocol đã tạo evidence; thêm protocol phiên bản mới cho profile mới.
2. Giữ API nghiệp vụ, dataset và yêu cầu tồn kho/payment/idempotency tương đương. Khai báo rõ synchronous/asynchronous checkout và freshness policy.
3. Tính toàn bộ app, worker, broker, primary, replica và cache vào ngân sách 2 vCPU/4 GiB. Nếu nghiên cứu thêm ngân sách lớn hơn, chạy thành nhóm riêng có baseline tương ứng.
4. Bắt đầu bằng functional/recovery smoke; sau đó tăng tải để tìm vùng bão hòa, rồi chạy warmup/measurement đủ dài và lặp lại ít nhất ba lần cho pilot. So sánh P99 riêng theo operation, confirmed orders/second, lỗi, resource utilization và consistency lag.
5. Không dùng HTTP 202 acceptance hay một mẫu nhỏ đạt invariant để thay thế số đo completion/capacity dài hạn.

## Phần evaluator cần mở rộng khi triển khai

Không thể chỉ thêm YAML. Registry/candidate schema hiện chỉ có ba family và một số scaling/communication enum. Gateway nhận diện microservices bằng khoảng ID A05–A12; monolith nhận cache qua set ID A02/A03/A04; smoke script chỉ nhận A01–A12. Cần chuyển những quyết định này sang capability/profile metadata.

Read replica và data ownership còn cần mở rộng role/env, dataset restore/checksum, invariant oracle, readiness và cost/complexity catalog. Bộ năm loại bảng nghiệp vụ vẫn nên giữ tương đương; projection kỹ thuật và nhiều store phải được mô tả trong protocol mới để tránh so sánh sai.

Thứ tự triển khai đề xuất: sửa baseline 503 → A13 → A14 → A15 → A16 → cặp A17/A18. Độ khó và lợi ích nêu trên là đánh giá tương đối từ code hiện tại; chưa có cam kết thời gian hay số liệu hiệu năng cho các profile đề xuất.
