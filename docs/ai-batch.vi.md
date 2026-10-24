# Chuẩn bị và thu dữ liệu AI hàng loạt

Bộ chạy dùng catalog thật A01–A52 để so sánh lựa chọn kiến trúc của AI, sau đó gửi lựa chọn hợp lệ đến evaluator hiện có. Campaign hiện tại nằm ở `experiments/ai-batch/apikey-fan-6-models.study.json` và kế thừa benchmark/catalog từ `study.json`; chạy các lệnh bên dưới từ thư mục `architecture-evaluation-backend`.

Pipeline evaluator đã có smoke evidence riêng tại `results/ai-batch/readiness-result-20261016.json`; đây chỉ là kiểm tra đường chạy, không phải dữ liệu hiệu năng nghiên cứu. Ngày 24/10/2026, manifest 6 model đã chuẩn bị thành công và cả sáu biến API key đều hiện diện. Quyền truy cập model chưa được xác minh bằng request thật; preflight evaluator yêu cầu API local đang chạy tại `http://localhost:8088`.

## Bộ thí nghiệm volume đã chuẩn bị

- 6 model qua một provider APIKEY.FAN: `claude-sonnet-5-5`, `gpt-6.1-sol`, `deepseek-flash`, `kimi-k2.6`, `jev-latest`, `glm-5.3-flash`.
- 1 prompt/ngữ cảnh e-commerce cố định cho cả sáu model để kiểm soát biến số; mỗi response chọn đúng một kiến trúc trong catalog.
- Mỗi model sinh **6 lần độc lập** cho mỗi prompt. Cùng một prompt đầy đủ (catalog + schema) được dùng cho mọi model và lần lặp. Kết quả trùng vẫn được giữ và tính vào phân bố lựa chọn.
- Mỗi kiến trúc hợp lệ được benchmark ở ba volume: **10.000, 100.000 và 500.000 business operations**, mỗi mức được lên lịch trong đúng 600 giây. Tải tương đương xấp xỉ 16,67; 166,67 và 833,33 operations/s.
- Raw HTTP requests được đo riêng vì một business operation có thể phát sinh polling hoặc nhiều HTTP call. Không dùng `total_http_requests` thay cho số business operations đã hoàn thành.
- Mỗi mức volume chạy 3 lần độc lập, dùng dataset `capacity`. Gate `GATE_OPERATION_VOLUME` chỉ pass khi hoàn thành đủ volume; các gate P99, error, dropped iterations, achieved rate, invariant, OOM/crash và measurement validity vẫn bắt buộc.
- Nhãn tổng hợp `Phù hợp` yêu cầu ít nhất 80% mẫu trong nhóm model × scenario × architecture × volume phải vượt toàn bộ hard gate. `COMPLETED` chỉ nói pipeline chạy xong, không đồng nghĩa kiến trúc phù hợp.
- Với 6 model, 1 scenario và 6 lần sinh, campaign gọi provider đúng **36 lần** (6 lần/model), tạo tối đa **36 experiment và 324 benchmark runs** ở 3 volume × 3 benchmark repetitions. Để giữ trần tuyệt đối 6 request/model, không chạy `probe` và không dùng `generate --retry-errors`. Mỗi lượt gồm warm-up 30 giây, đo 600 giây và cooldown 15 giây; tổng cửa sổ danh nghĩa tối đa **58,05 giờ** khi chạy tuần tự, chưa tính deploy, restore hoặc cleanup.
- Thứ tự lượt sinh được xáo trộn theo `orderSeed=20261016` và giữ cố định khi tiếp tục. Đây là seed thứ tự, không phải seed của model hoặc seed dataset. Snapshot dataset vẫn dùng seed `20261001`.

Các model ID trên là alias do người dùng cung cấp cho APIKEY.FAN và chưa được xác minh bằng request thật. Runner gọi giao diện OpenAI-compatible Chat Completions, đồng thời lưu `returnedModel`, timestamp, provider response và usage để đối chiếu model thực tế mà provider trả về.

## 1. Điền API key

`experiments/ai-batch/keys.env` là file riêng đã được Git ignore. Nếu chưa có, sao chép file mẫu; không ghi đè file chứa key:

```powershell
if (-not (Test-Path experiments/ai-batch/keys.env)) {
    Copy-Item experiments/ai-batch/keys.env.example experiments/ai-batch/keys.env
}
notepad experiments/ai-batch/keys.env
```

Điền sáu biến `APIKEY_FAN_*_KEY` liệt kê bên dưới và `EVALUATOR_API_URL=http://localhost:8088`. `npm run ai:batch` tự nạp file này; biến môi trường đã có của process được ưu tiên. Không đưa key vào study JSON hoặc phản hồi mẫu.

Nếu chỉ có một nhà cung cấp, sao chép study sang file mới, đặt `studyId` mới và giữ model bạn có trong `models`; thêm `--config đường-dẫn-file.json` vào mọi lệnh. Có thể thay model ID/base URL cho nhà cung cấp tương ứng. Adapter OpenAI dùng endpoint Chat Completions; mặc định gửi `max_completion_tokens`, nhưng có thể tắt trường này cho proxy chỉ công bố request tối giản như template APIKEY.FAN bên dưới.

### Sáu model và sáu APIKEY.FAN key

Template `experiments/ai-batch/apikey-fan-6-models.study.json` kế thừa toàn bộ scenario và benchmark từ study chính. Sáu model dùng chung endpoint `https://api.apikey.fan/v1/chat/completions`, nhưng mỗi model tham chiếu một biến API key riêng. Request dùng OpenAI Chat Completions không streaming và chỉ gửi các trường được tài liệu provider mô tả (`model`, `messages`, `stream`); response vẫn được lưu nguyên bản để audit.

Model ID đã được điền trong template. Thêm từng key vào file riêng đã Git ignore:

```dotenv
APIKEY_FAN_CLAUDE_KEY=...
APIKEY_FAN_CODEX_KEY=...
APIKEY_FAN_DEEPSEEK_KEY=...
APIKEY_FAN_KIMI_KEY=...
APIKEY_FAN_JEV_KEY=...
APIKEY_FAN_GLM_KEY=...
```

Sau đó dùng cùng workflow với lệnh riêng:

```powershell
npm run ai:batch:apikey-fan -- prepare
npm run ai:batch:apikey-fan -- preflight
npm run ai:batch:apikey-fan -- generate --limit 6
npm run ai:batch:apikey-fan -- submit --limit 6
npm run ai:batch:apikey-fan -- collect
```

6 model × 1 scenario × 6 lần sinh tạo đúng 36 generation. Chạy `generate --limit 6` chỉ xử lý 6 job kế tiếp theo thứ tự đã randomize. Tăng limit chỉ sau khi kiểm tra response/provider usage và credit.

Không chạy `probe` trong campaign này: lệnh đó thực hiện thêm một request cho từng model (6 request tính phí), khiến tổng số vượt giới hạn 6 request/model. `preflight` chỉ kiểm tra cấu hình/key và evaluator, không gọi provider.

## 2. Kiểm tra và khởi động evaluator

Yêu cầu Node 22.19+, dependencies đã cài (`npm ci` trên máy mới), Docker Desktop chạy Linux containers. Có sẵn pilot dump và manifest; không cần seed lại để dùng cấu hình mặc định.

```powershell
./scripts/start-local.ps1
npm run ai:batch -- prepare
npm run ai:batch -- preflight
```

`start-local.ps1` build backend/frontend, khởi động API + worker + quan sát tại [localhost:8088](http://localhost:8088). Dùng `-SkipBuild` chỉ khi các image khớp checkout hiện tại. Xem [deployment](deployment.md) nếu dùng Ubuntu/SSH hoặc triển khai riêng. Không chạy nhiều worker benchmark đồng thời trên cùng máy; giữ `MAX_CONCURRENT_EXPERIMENTS=1` để hạn chế nhiễu.

`prepare` không gọi API, không phát sinh phí. Nó xuất manifest, prompt, schema, catalog và CSV rỗng. `preflight` kiểm tra sự hiện diện của key, API readiness và contract local/remote; **không xác thực credit hoặc quyền gọi model**. Lượt sinh thử bên dưới mới kiểm tra truy cập thực tế. API từ chối submit nếu snapshot hoặc catalog/score bounds không có.

## 3. Chạy thử nhỏ trước

```powershell
npm run ai:batch -- generate --limit 1
npm run ai:batch -- submit --limit 1
npm run ai:batch -- collect
```

Mặc định `generate` và `submit` chỉ xử lý tối đa **1** mục mỗi lần. Do thứ tự đã xáo trộn, phản hồi đầu tiên có thể là một yêu cầu ngoài phạm vi; `submit` chỉ gửi khi đã có candidate `VALID`. Xem dòng log và `generations.csv`. Chạy thêm `generate --limit 3` nếu cần lấy candidate hỗ trợ. Khi cần kiểm tra riêng từng model, tạo study nhỏ chỉ có model đó và kịch bản `small-team`, một lần sinh; dùng `studyId` riêng.

`collect` lấy trạng thái hiện tại, không chờ hết queue. Chạy lại sau khi experiment kết thúc; có thể theo dõi chi tiết trên trang `/experiments`. Không lấy CSV lần đầu làm kết quả cuối nếu experiment còn PENDING/RUNNING.

Sau khi ghi CSV/JSON local, `collect` tự publish snapshot tổng hợp vào evaluator API. Nhờ vậy trang `/ai-results` vẫn đọc được dữ liệu khi API/worker dùng Docker volume còn CLI chạy trên host. Raw provider response, prompt đầy đủ và evidence chi tiết không được upload qua endpoint snapshot.

## 4. Chạy lấy dữ liệu hàng loạt

Sau khi xác nhận lượt nhỏ hoạt động:

```powershell
npm run ai:batch:apikey-fan -- generate --limit 36
npm run ai:batch:apikey-fan -- submit --limit 36
npm run ai:batch:apikey-fan -- collect
```

Gọi lại các lệnh sẽ tiếp tục các job còn thiếu. Lượt sinh có kết quả rồi được bỏ qua; submit dùng idempotency key dựa trên manifest + job + request để chống trùng khi mất kết nối. Các lần sinh cùng chọn A01 vẫn là các experiment riêng nhằm giữ quan hệ model/prompt/lần sinh. Mỗi lần chạy `collect` cập nhật JSON trạng thái và hai CSV.

Lỗi HTTP, timeout hoặc envelope provider sai được lưu là `API_ERROR`. Mặc định không tự gửi lại (timeout có thể đã bị tính phí). Campaign giới hạn 6 request/model này không được dùng `--retry-errors`, vì mỗi retry là một request provider bổ sung. Với một campaign khác không có giới hạn cứng, có thể thử lại bằng:

```powershell
npm run ai:batch -- generate --retry-errors --limit 3
```

Mỗi attempt và provider response cũ vẫn được giữ. JSON sai, sai yêu cầu hoặc `INCOMPLETE` không được tự sinh lại. Muốn nghiên cứu repair hoặc thay token cap, tạo study khác để giữ dữ liệu gốc. Nếu một process bị kill, nó có thể để lại thư mục `.lock`; chỉ xóa thư mục rỗng đó sau khi xác nhận process cũ đã dừng. File `.tmp` chưa rename không được xem là evidence hoàn thành; crash trong lúc gọi provider có thể cần đối soát billing trước khi tiếp tục.

Không sửa study/model/catalog giữa campaign: công cụ so fingerprint và yêu cầu `studyId` hoặc `--out` mới. Chuẩn bị và submit phải dùng cùng contract với evaluator.

## 5. Dùng AI trên web khi chưa có API key

Mở prompt trong `results/ai-batch/ai-selection-pilot-v1/prompts/`, gửi nguyên nội dung trong một cuộc hội thoại mới. Xem `manifest.json` để lấy `job.id` đúng model, kịch bản và repetition. Lưu nguyên phản hồi AI vào `manual/<job.id>.txt`, rồi chạy:

```powershell
npm run ai:batch -- import --limit 108
npm run ai:batch -- submit --limit 81
```

Import không gọi model và không cần key. Nguồn được ghi `manual`; `requestedModel` là nhãn khai báo, không xác minh được model/snapshot hoặc usage của ứng dụng web. Không trộn kết quả API và web khi so sánh mà không nêu nguồn. Import chỉ xử lý job chưa có kết quả (hoặc API_ERROR khi dùng `--retry-errors`).

## 6. File dữ liệu để phân tích

Mặc định tất cả ở `results/ai-batch/ai-selection-pilot-v1/` (được Git ignore):

| File/thư mục         | Nội dung                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`      | Study đóng băng, job order, hash, prompt, catalog, schema                                                                               |
| `prompts/*.txt`      | Prompt hoàn chỉnh để copy hoặc lưu phụ lục                                                                                              |
| `provider/*.json`    | Response nguyên bản từ API, gồm usage, model trả về, lý do dừng                                                                         |
| `attempts/*.json`    | Tất cả lần gọi, gồm lần retry lỗi                                                                                                       |
| `generations/*.json` | Kết quả hiện tại của mỗi job: text gốc, validation, nguồn, thời gian                                                                    |
| `submissions/*.json` | Request benchmark, URL evaluator, idempotency key, experiment ID                                                                        |
| `benchmarks/*.json`  | Toàn bộ run và transition, kể cả run lỗi và retry                                                                                       |
| `generations.csv`    | Một dòng/job, trạng thái, model/prompt/lần sinh, architecture, usage, lỗi                                                               |
| `runs.csv`           | Một dòng/benchmark attempt, load, repetition, state, metrics, cost, gates, scores                                                       |
| `results.csv`        | Một dòng/kết quả cuối, gồm target operations, completed operations, raw HTTP requests, volume completion, hiệu năng, tài nguyên, chi phí, gate và score |
| `comparison.csv`     | Median và pass-rate theo model × scenario × architecture × volume; luôn kèm số mẫu hoàn thành/thất bại                                   |
| `summary.json`       | Counts, accuracy, lỗi API, phân bố kiến trúc, selection stability                                                                       |

`responseAccuracy = correctCount / responseCount` (loại API_ERROR, vẫn tính phản hồi sai/cắt ngắn). `endToEndSuccessRate = correctCount / measured` (tính cả API_ERROR). `selectionStability` là tỷ lệ kiến trúc phổ biến nhất trong các phản hồi VALID cùng model và scenario, null khi có dưới 2 mẫu VALID. Đọc counts và số mẫu đi kèm, tránh chỉ báo cáo tỷ lệ.

`runs.csv` giữ tất cả attempt để audit. `results.csv` tự chọn attempt cuối cùng cho mỗi `(jobId, load_rps, run_number)` và để trống metric khi lượt cuối thất bại; không che giấu lỗi bằng cách lấy attempt cũ đã hoàn thành. Khi tính thống kê hiệu năng, chỉ gộp các lượt đo hoàn thành có metrics đúng phiên bản, đồng thời báo số thất bại. Đừng gộp các lần lặp AI và benchmark thành các mẫu độc lập cùng một cấp. Phân biệt P99 HTTP với thời gian hoàn tất đơn trong async checkout.

Không tự ước lượng chi phí API hoặc tuyên bố model chọn kiến trúc tối ưu. Benchmark hiện tại đo lựa chọn AI; muốn chứng minh optimality phải đo các baseline đáp ứng cùng ràng buộc ở cùng workload/load/hardware. Publication cần freeze image digest, hardware, measurement settings, catalog giá thật và score bounds từ pilot theo [protocol](phase10-protocol.md). Sao lưu cả thư mục campaign và artifacts evaluator trước khi chuyển máy hoặc dọn Docker volumes.
