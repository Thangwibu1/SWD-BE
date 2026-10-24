# AI architecture selections

Study: `apikey-fan-6-models-6x-volume-v1`

Mỗi dòng là một trong sáu lần gọi của model. `VALID` có thể benchmark; các trạng thái khác được giữ nguyên để đối chiếu và không tự retry.

| Model | Requested model | Returned model | Lần | Trạng thái | Architecture | Family | Broker | Cache | Scaling | Lỗi/validation | Evidence |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| kimi | kimi-k2.6 | kimi-k2.6 | 2 | INVALID_SCHEMA |  |  |  |  |  | [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object] | generations/kimi__ecommerce-volume__2.json |
| claude | claude-sonnet-5-5 | claude-sonnet-5-5 | 5 | VALID | A03 | MODULAR_MONOLITH | NONE | product, cart | DUAL_APP_PROXY |  | generations/claude__ecommerce-volume__5.json |
| deepseek | deepseek-flash |  | 1 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/deepseek__ecommerce-volume__1-1792853874729.json | generations/deepseek__ecommerce-volume__1.json |
| deepseek | deepseek-flash |  | 6 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/deepseek__ecommerce-volume__6-1792853876462.json | generations/deepseek__ecommerce-volume__6.json |
| codex | gpt-6.1-sol | gpt-6.1-sol | 2 | VALID | A43 | MODULAR_MONOLITH | POSTGRES | product, cart | QUEUE_SINGLE_API |  | generations/codex__ecommerce-volume__2.json |
| kimi | kimi-k2.6 | kimi-k2.6 | 3 | VALID | A20 | MODULAR_MONOLITH | NONE | product | DUAL_APP_PROXY |  | generations/kimi__ecommerce-volume__3.json |
| claude | claude-sonnet-5-5 |  | 4 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/claude__ecommerce-volume__4-1792853935424.json | generations/claude__ecommerce-volume__4.json |
| claude | claude-sonnet-5-5 |  | 6 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/claude__ecommerce-volume__6-1792853937152.json | generations/claude__ecommerce-volume__6.json |
| claude | claude-sonnet-5-5 |  | 1 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/claude__ecommerce-volume__1-1792853938893.json | generations/claude__ecommerce-volume__1.json |
| glm | glm-5.3-flash | zai-org/GLM-5.3-Flash | 5 | VALID | A16 | MODULAR_MONOLITH | POSTGRES | product | QUEUE_DUAL_WORKER |  | generations/glm__ecommerce-volume__5.json |
| codex | gpt-6.1-sol | gpt-6.1-sol | 3 | VALID | A52 | MODULAR_MONOLITH | POSTGRES | product, cart | QUEUE_SINGLE_API_DUAL_WORKER |  | generations/codex__ecommerce-volume__3.json |
| kimi | kimi-k2.6 | kimi-k2.6 | 6 | VALID | A20 | MODULAR_MONOLITH | NONE | product | DUAL_APP_PROXY |  | generations/kimi__ecommerce-volume__6.json |
| kimi | kimi-k2.6 | kimi-k2.6 | 4 | VALID | A03 | MODULAR_MONOLITH | NONE | product, cart | DUAL_APP_PROXY |  | generations/kimi__ecommerce-volume__4.json |
| glm | glm-5.3-flash | zai-org/GLM-5.3-Flash | 1 | VALID | A20 | MODULAR_MONOLITH | NONE | product | DUAL_APP_PROXY |  | generations/glm__ecommerce-volume__1.json |
| codex | gpt-6.1-sol | gpt-6.1-sol | 4 | VALID | A43 | MODULAR_MONOLITH | POSTGRES | product, cart | QUEUE_SINGLE_API |  | generations/codex__ecommerce-volume__4.json |
| glm | glm-5.3-flash | zai-org/GLM-5.3-Flash | 6 | VALID | A03 | MODULAR_MONOLITH | NONE | product, cart | DUAL_APP_PROXY |  | generations/glm__ecommerce-volume__6.json |
| glm | glm-5.3-flash | zai-org/GLM-5.3-Flash | 4 | VALID | A02 | MODULAR_MONOLITH | NONE | product, cart | SINGLE_INSTANCE |  | generations/glm__ecommerce-volume__4.json |
| jev | jev-latest |  | 6 | API_ERROR |  |  |  |  |  | Provider HTTP 404; see provider/jev__ecommerce-volume__6-1792854373411.json | generations/jev__ecommerce-volume__6.json |
| jev | jev-latest |  | 1 | API_ERROR |  |  |  |  |  | Provider HTTP 404; see provider/jev__ecommerce-volume__1-1792854375150.json | generations/jev__ecommerce-volume__1.json |
| glm | glm-5.3-flash | zai-org/GLM-5.3-Flash | 2 | VALID | A17 | MODULAR_MONOLITH | NONE | product | SINGLE_INSTANCE |  | generations/glm__ecommerce-volume__2.json |
| codex | gpt-6.1-sol | gpt-6.1-sol | 1 | VALID | A43 | MODULAR_MONOLITH | POSTGRES | product, cart | QUEUE_SINGLE_API |  | generations/codex__ecommerce-volume__1.json |
| jev | jev-latest |  | 3 | API_ERROR |  |  |  |  |  | Provider HTTP 404; see provider/jev__ecommerce-volume__3-1792854512245.json | generations/jev__ecommerce-volume__3.json |
| kimi | kimi-k2.6 | kimi-k2.6 | 5 | VALID | A20 | MODULAR_MONOLITH | NONE | product | DUAL_APP_PROXY |  | generations/kimi__ecommerce-volume__5.json |
| kimi | kimi-k2.6 | kimi-k2.6 | 1 | VALID | A20 | MODULAR_MONOLITH | NONE | product | DUAL_APP_PROXY |  | generations/kimi__ecommerce-volume__1.json |
| claude | claude-sonnet-5-5 |  | 2 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/claude__ecommerce-volume__2-1792854528436.json | generations/claude__ecommerce-volume__2.json |
| codex | gpt-6.1-sol | gpt-6.1-sol | 5 | VALID | A48 | MODULAR_MONOLITH | POSTGRES | product, cart | QUEUE_DUAL_WORKER |  | generations/codex__ecommerce-volume__5.json |
| codex | gpt-6.1-sol | gpt-6.1-sol | 6 | VALID | A43 | MODULAR_MONOLITH | POSTGRES | product, cart | QUEUE_SINGLE_API |  | generations/codex__ecommerce-volume__6.json |
| jev | jev-latest |  | 4 | API_ERROR |  |  |  |  |  | Provider HTTP 404; see provider/jev__ecommerce-volume__4-1792854613568.json | generations/jev__ecommerce-volume__4.json |
| deepseek | deepseek-flash |  | 2 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/deepseek__ecommerce-volume__2-1792854615296.json | generations/deepseek__ecommerce-volume__2.json |
| deepseek | deepseek-flash |  | 5 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/deepseek__ecommerce-volume__5-1792854617042.json | generations/deepseek__ecommerce-volume__5.json |
| deepseek | deepseek-flash |  | 3 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/deepseek__ecommerce-volume__3-1792854618776.json | generations/deepseek__ecommerce-volume__3.json |
| glm | glm-5.3-flash | glm-5.3-flash | 3 | INVALID_SCHEMA |  |  |  |  |  | [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object]; [object Object] | generations/glm__ecommerce-volume__3.json |
| jev | jev-latest |  | 5 | API_ERROR |  |  |  |  |  | Provider HTTP 404; see provider/jev__ecommerce-volume__5-1792854755263.json | generations/jev__ecommerce-volume__5.json |
| claude | claude-sonnet-5-5 |  | 3 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/claude__ecommerce-volume__3-1792854756998.json | generations/claude__ecommerce-volume__3.json |
| jev | jev-latest |  | 2 | API_ERROR |  |  |  |  |  | Provider HTTP 404; see provider/jev__ecommerce-volume__2-1792854758730.json | generations/jev__ecommerce-volume__2.json |
| deepseek | deepseek-flash |  | 4 | API_ERROR |  |  |  |  |  | Provider HTTP 401; see provider/deepseek__ecommerce-volume__4-1792854760478.json | generations/deepseek__ecommerce-volume__4.json |
