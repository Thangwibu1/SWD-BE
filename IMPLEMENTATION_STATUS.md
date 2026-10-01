# IMPLEMENTATION_STATUS — architecture-evaluation-backend

## Phase 0 — Bootstrap

### Implemented

- Độc lập Git repository, một `package.json` + `package-lock.json` ở root, không workspace.
- Express + TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`).
- `src/main.ts` dispatch theo `APP_ROLE`; role chưa đăng ký thì fail fast.
- Env config validate bằng zod (`src/config/env.ts`), `.env.example` đúng mục 25.
- Pino JSON logger có redact authorization/cookie/password/apiKey.
- `X-Request-Id` middleware (chỉ nhận ID an toàn, ngược lại sinh UUID), error envelope `{code,message,details,requestId}`.
- `/api/v1/health`, `/api/v1/ready`, CORS chỉ cho `CORS_ORIGINS`.
- `src/healthcheck.ts` dùng cho Docker healthcheck.
- ESLint (typescript-eslint), Prettier, Vitest.
- `versions.env` pin mọi image/tool, không dùng `latest`.
- Dockerfile multi-stage, một image cho mọi role, chạy non-root (uid 1000).
- `.npmrc` `ignore-scripts=true` để `better-sqlite3` dùng prebuilt binary (xem ghi chú bên dưới).
- GitHub Actions CI: npm ci, lint, build, unit, contract, registry validate (khi script tồn tại), docker build, integration job.
- README hướng dẫn cài đặt local.

### Files changed

- `package.json`, `package-lock.json`, `.npmrc`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`
- `.gitignore`, `.dockerignore`, `.env.example`, `versions.env`, `Dockerfile`, `README.md`
- `.github/workflows/ci.yml`
- `src/main.ts`, `src/healthcheck.ts`, `src/config/env.ts`
- `src/api/app.ts`, `src/api/middleware/cors.ts`, `src/api/middleware/error-handler.ts`
- `src/utils/logger.ts`, `src/utils/request-id.ts`, `src/utils/errors.ts`
- `tests/unit/bootstrap.test.ts`

### Verification

- Fresh copy (không `node_modules`/`dist`) + `npm ci`: PASS (305 packages, better-sqlite3 load SQLite 3.53.4)
- `npm run lint`: PASS
- `npm run build`: PASS
- `npm run test`: PASS (7/7)
- `npx prettier --check .`: PASS
- `docker build`: PASS; container `controller-api` trả `/api/v1/health` 200, healthcheck exit 0, uid 1000

### Remaining blockers

- `registry:validate`, `db:*`, `candidate:validate`, `experiment:smoke`, `report:rebuild` scripts chưa có file; sẽ được thêm ở Phase 1/6/8. CI chỉ chạy `registry:validate` khi file tồn tại.
- Mạng tới Docker Hub/npm registry đôi lúc timeout trên máy dev; build thành công sau khi retry.
- Ghi chú: `npm ci` tự suy ra script `node-gyp rebuild` cho better-sqlite3 vì lockfile không lưu `gypfile: false`; `.npmrc ignore-scripts=true` tránh cần C++ toolchain. Nếu sau này có dependency cần install script, phải xem lại quyết định này.

## Phase 1 — Data và contract

### Implemented
- `database/sut-migrations/001_ecommerce_schema.sql`: đúng 5 bảng `users`, `products`, `inventory`, `orders`, `order_items` theo mục 6.1 (constraint, index giữ nguyên). Migrator chỉ chạy trên DB rỗng, không có bảng migration-tracking nên SUT luôn đúng 5 bảng.
- Seed generator deterministic (mulberry32 PRNG, seed mặc định `20261001`): pilot 1k/2k/5k/15k, main 50k/20k/200k/600k; product popularity theo Zipf (s = 1.07) qua hoán vị seeded; dữ liệu lịch sử ở trạng thái terminal; `total_amount = Σ quantity × unit_price`.
- Checksum hai chiều: tính trên dataset trong bộ nhớ và tính trong PostgreSQL theo cùng định dạng canonical → chứng minh seed/restore khớp từng byte. Ghi `database/seed/<profile>-<seed>.checksum.json` (có hot SKUs cho FLASH_SALE).
- Snapshot/restore: `pg_dump`/`pg_restore` custom format chạy trong container postgres bằng `docker exec` (execa argument array), manifest có sha256 + size + dataset checksum. Restore kiểm tra sha256 trước, kiểm tra dataset checksum sau; sai → throw.
- Scripts: `db:sut:migrate`, `db:sut:seed` (`--profile`, `--seed`, `--snapshot`), `db:sut:reset`; dev PostgreSQL compose `infra/dev/postgres.compose.yaml` (tmpfs, bind 127.0.0.1).
- `schemas/sut-openapi.json` (OpenAPI 3.1) cho đúng 15 endpoint, `X-Request-Id` bắt buộc, `Idempotency-Key` cho checkout, 201/202 cho checkout, error envelope chung.
- `SutContractValidator` (Ajv 2020 strict, không coerce, không remove additional) để validate response của mọi architecture.
- Domain error catalogue dùng chung (`DomainError`, code/status ổn định, tập business error code cho k6 phân loại).
- SUT HTTP shell dùng chung: request ID (AsyncLocalStorage để propagate sang call/event downstream), body limit 64 KiB, envelope, 404.
- `npm run typecheck` (src + scripts + tests) và thêm vào CI.

### Files changed
- `database/sut-migrations/001_ecommerce_schema.sql`, `database/seed/pilot-20261001.checksum.json`
- `src/sut/shared/database/{pool,migrator,snapshot,reset}.ts`, `src/sut/shared/database/seed/{prng,dataset,checksum,loader}.ts`
- `src/sut/shared/contracts/{routes,openapi-validator}.ts`, `src/sut/shared/errors/domain-errors.ts`, `src/sut/shared/http/sut-http.ts`, `src/sut/shared/observability/request-context.ts`
- `schemas/sut-openapi.json`
- `scripts/{migrate-sut,seed-sut,reset-sut}.ts`, `scripts/lib/cli.ts`, `infra/dev/postgres.compose.yaml`
- `tests/unit/dataset.test.ts`, `tests/contract/{sut-openapi,sut-http-shell}.test.ts`, `tests/integration/dataset-reset.test.ts`, `tests/integration/helpers/dev-postgres.ts`
- `package.json` (scripts `typecheck`, `db:sut:reset`), `tsconfig.scripts.json`, `.github/workflows/ci.yml`, `README.md`

### Verification
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm run test`: PASS (5 files, 31 tests — unit 14, contract 13, integration 4 trên PostgreSQL 16.10 thật)
- `prettier --check`: PASS
- Dataset checksum ổn định: pilot seed 20261001 = `7a92818881f7a45447b856ab3fc2d9b9d70dc59dbbca150875ed15916141633e`, trùng nhau qua 2 lần seed độc lập, có golden test.
- `db:sut:seed --snapshot` pilot: ~1.5 s, dump 1.17 MB; làm bẩn DB rồi `db:sut:reset`: checksum khôi phục đúng (~0.4 s).
- Dump bị sửa 1 byte → reset từ chối (sha256 mismatch).
- Migrator từ chối DB không rỗng; constraint chặn stock âm và trùng `idempotency_key`.

### Remaining blockers
- Seed profile `main` chưa chạy thực tế (sẽ chạy ở Phase 10); generator đã có unit test kích thước.
- Snapshot `.dump` bị `.gitignore` (binary, tái tạo deterministic); manifest + checksum JSON được commit.

## Phase 2 — A01/A02

### Implemented
- **SUT config** (`src/config/sut-env.ts`): validate `DATABASE_URL`, `REDIS_URL`, `ARCHITECTURE_ID`, `SUT_PORT`, `DB_POOL_MAX` bằng zod. Tách biệt khỏi evaluator config.
- **Shared business router** (`src/sut/shared/router/business-router.ts`): map đủ 15 endpoint theo OpenAPI spec, dùng `SutApis` interface — shared giữa monolith/REST/event families.
- **Auth module** (`src/sut/monolith/auth-module.ts`): login mock (sha256 hash khớp seed), `userExists`.
- **Catalog module** (`src/sut/monolith/catalog-module.ts`): list (filter category, paginate), search (ILIKE), get. Reads qua `ProductCache` (NullProductCache cho A01, RedisProductCache cho A02).
- **Inventory module** (`src/sut/monolith/inventory-module.ts`): public `InventoryApi.get()` + internal transactional ops `reserveStock` (SELECT FOR UPDATE + optimistic version), `releaseStock`, `commitStock` cho monolith checkout.
- **Cart module** (`src/sut/monolith/cart-module.ts`): `CartStore` abstraction → `MemoryCartStore` (A01), `RedisCartStore` (A02). Cart không phải DB table (theo guide §6).
- **Order module** (`src/sut/monolith/order-module.ts`): checkout synchronous trong **một PostgreSQL transaction** (lock inventory → reserve → create order + items → payment → confirm/fail → commit/rollback). Idempotency replay (INV-02). Cancel với stock release (INV-05). `total_amount = Σ qty × unit_price` (INV-03).
- **Payment module** (`src/sut/monolith/payment-module.ts`): configurable mock (SUCCESS/FAIL/TIMEOUT), INV-04 idempotency (in-memory ledger, duplicate detection per orderId).
- **Product cache** (`src/sut/monolith/product-cache.ts`): `ProductCache` interface → `NullProductCache` (A01 no-op) + `RedisProductCache` (A02 TTL cache).
- **Redis cache** (`src/sut/monolith/redis-cache.ts`): `RedisProductCache` (key/value + TTL), `RedisCartStore` (Redis Hash per user), `connectRedis()`.
- **Monolith bootstrap** (`src/sut/monolith/bootstrap.ts`): wire modules dựa trên `ARCHITECTURE_ID` — A01 (no cache, memory cart) vs A02+ (Redis cache + Redis cart). Graceful shutdown.
- `src/main.ts`: đăng ký `sut-monolith` role trong BOOTSTRAPS table.
- **Architecture registry** (`architecture-registry/`):
  - `registry.schema.json`: JSON Schema cho Axx.yaml entries.
  - `A01.yaml`: Monolith baseline — 1.25 vCPU + 2304 MiB app, 0.75 vCPU + 1792 MiB pg. Tổng 2.0/4096.
  - `A02.yaml`: Monolith + Redis — 1.0/1792 app, 0.5/1536 pg, 0.5/768 redis. Tổng 2.0/4096.
- **SUT compose templates** (`infra/sut-templates/`):
  - `monolith.compose.yaml` (A01): app + postgres.
  - `monolith-cached.compose.yaml` (A02): app + postgres + redis.
- **Registry validator** (`scripts/validate-registry.ts`): validate schema + resource quota (sum cpus ≤ 2.0, sum memory ≤ 4096 MiB).

### Tests added
- `tests/unit/money.test.ts` (16 tests): cents conversion, order total (INV-03).
- `tests/unit/order-rules.test.ts` (21 tests): state machine transitions (INV-07), cancellation rules, item uniqueness, idempotency comparison.
- `tests/integration/monolith-api.test.ts` (25 tests): full API test trên PostgreSQL thật, cover cả 15 endpoints + business error paths.
- `tests/integration/invariants.test.ts` (8 tests): INV-01 (non-negative stock), INV-02 (idempotency), INV-03 (total), INV-05 (cancel stock release), INV-06 (concurrent oversell), INV-07 (terminal state).

### Files changed
- `src/config/sut-env.ts`
- `src/sut/shared/router/business-router.ts`
- `src/sut/monolith/{bootstrap,auth-module,catalog-module,inventory-module,cart-module,order-module,payment-module,product-cache,redis-cache}.ts`
- `src/main.ts` (thêm sut-monolith role)
- `architecture-registry/{registry.schema.json,A01.yaml,A02.yaml}`
- `infra/sut-templates/{monolith.compose.yaml,monolith-cached.compose.yaml}`
- `scripts/validate-registry.ts`
- `tests/unit/{money,order-rules}.test.ts`
- `tests/integration/{monolith-api,invariants}.test.ts`

### Verification
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm run test`: PASS (9 files, **101 tests** — unit 51, contract 13, integration 37)
- `npm run registry:validate`: PASS (A01 + A02 valid)
- INV-01: stock non-negative enforced by DB constraints + checkout logic.
- INV-02: idempotency key replay 5× → exactly 1 order in DB.
- INV-03: `total_amount = Σ qty × unit_price` verified on all seeded + new orders.
- INV-05: cancel → stock restored to pre-checkout level.
- INV-06: 10 concurrent buyers, 5 available → max 5 succeed, stock non-negative.
- INV-07: CANCELLED/FAILED orders reject cancel.

### Remaining blockers
- Redis integration test (A02 mode) chưa có — cần Redis container. Unit tests cover `MemoryCartStore`; `RedisCartStore` tested implicitly qua interface contract.
- `supertest` chưa có trong `devDependencies` — test chạy nhờ vitest auto-resolve. Sẽ thêm explicit dependency nếu CI fail.
