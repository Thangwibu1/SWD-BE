# Ma trận cấu hình kiến trúc

13 topology × 4 chế độ Redis = 52 cấu hình. Tài liệu sinh bằng `npm run registry:expand-matrix`.

| Family | Broker | Scaling | Không Redis | Product | Cart | Product + cart |
|---|---|---|---|---|---|---|
| MODULAR_MONOLITH | NONE | SINGLE_INSTANCE | A01 | A17 | A18 | A02 |
| MODULAR_MONOLITH | NONE | DUAL_APP_PROXY | A19 | A20 | A21 | A03 |
| MODULAR_MONOLITH | NONE | DUAL_APP_PROXY_ASYNC | A22 | A23 | A24 | A04 |
| REST_MICROSERVICES | NONE | ONE_PER_SERVICE | A05 | A25 | A26 | A06 |
| REST_MICROSERVICES | NONE | CATALOG_SCALED | A27 | A28 | A29 | A07 |
| REST_MICROSERVICES | NONE | ORDER_SCALED | A30 | A31 | A32 | A08 |
| EVENT_DRIVEN_MICROSERVICES | RABBITMQ | ONE_PER_SERVICE | A09 | A33 | A34 | A10 |
| EVENT_DRIVEN_MICROSERVICES | RABBITMQ | CATALOG_SCALED | A35 | A36 | A37 | A11 |
| EVENT_DRIVEN_MICROSERVICES | RABBITMQ | ORDER_SCALED | A38 | A39 | A40 | A12 |
| MODULAR_MONOLITH | POSTGRES | QUEUE_SINGLE_API | A13 | A41 | A42 | A43 |
| MODULAR_MONOLITH | POSTGRES | QUEUE_DUAL_API | A14 | A15 | A44 | A45 |
| MODULAR_MONOLITH | POSTGRES | QUEUE_DUAL_WORKER | A46 | A16 | A47 | A48 |
| MODULAR_MONOLITH | POSTGRES | QUEUE_SINGLE_API_DUAL_WORKER | A49 | A50 | A51 | A52 |

Không Redis cho cart thì giỏ hàng lưu chung trong PostgreSQL. Cart trong Redis là kho dữ liệu, không phải queue. Chỉ dùng đúng ID và decisions từ [catalog](ai-contract/catalog.json); yêu cầu vượt phạm vi phải trả lỗi thay vì chọn gần đúng. Xem [phạm vi và lưu ý nghiên cứu](supported-architectures.md).
