# API 服务

NestJS API 监听 `API_PORT`（默认 `3001`），路由前缀为 `/api/v1`。当前包含公开健康检查、项目管理最小 API，以及每个请求的 `x-trace-id` 解析和响应回传。

## 本地配置

1. 复制仓库根目录 `.env.example` 为本地 `.env`，配置 PostgreSQL `DATABASE_URL`。
2. 为 `PLATFORM_ADMIN_TOKEN` 设置本机生成的高熵随机值；该变量留空或未配置时，管理 API 会拒绝所有请求（fail closed）。不要把它放进 Web 环境变量、浏览器代码、请求 URL 或日志，也不要提交真实值。
3. 启动 API：`pnpm --filter @trace-ops/api dev`。

`GET /api/v1/health` 不要求管理员令牌。管理路由使用 `Authorization: Bearer <PLATFORM_ADMIN_TOKEN>`。响应统一使用 `{ "statusCode": number, "error": string, "message": string | string[] }` 错误结构；预期状态包括 400（输入无效）、401（令牌缺失/错误）、404（项目或密钥不存在）、409（唯一键冲突）和 503（PostgreSQL 不可用）。

## Span 接入

`POST /api/v1/spans` 使用 W1 请求契约 `{ "projectKey": "tr_…", "environment": "dev|staging|prod", "spans": [...] }`，每批接受 1–500 个 Span，JSON 请求体上限为 4 MiB。API 校验项目密钥、项目状态、Scope 及该项目已注册的服务/环境；`projectId`、`environment` 和 `schemaVersion: 1` 由服务端写入 Kafka 事件，客户端不能指定 `projectId`。敏感属性按 `@trace-ops/contracts` 的 `redactSpanAttributes` 过滤，密钥不会进入事件。契约中的 `Span.error` 是不透明自由文本，可能带有 Prompt、用户原文或凭据；W4 上报端因此会无条件丢弃该字段（保留 `status`），不会写入 Kafka、日志或错误响应。若后续需要错误诊断，应新增经过定义的安全错误码/分类，而不是直接开放原始错误文本。非法 JSON 与超大请求只返回固定通用错误文案。

HTTP 202 的 `delivery: "queued_in_memory"` 仅表示数据进入有界内存队列，不代表已写入 Kafka，也不具备重启持久性；消费者收到 Kafka 确认后才计入 `publishedSpans`。队列满时整批拒绝并返回 503。Kafka 失败会在有限次数内重试，仍失败则丢弃并增加计数。Kafka topic 由 `KAFKA_TOPIC` 配置（默认 `ai-spans`），消息 key 为 `traceId`。可通过管理员保护的 `GET /api/v1/spans/status` 查看队列深度、连接状态、发布错误和丢弃计数。队列容量可用 `SPAN_QUEUE_MAX_SPANS`、`SPAN_QUEUE_MAX_BYTES`、`SPAN_QUEUE_BATCH_SIZE`、`SPAN_QUEUE_MAX_RETRIES` 调整。

`GET /api/v1/spans/status` 同时返回进程内的 `rejectedInvalidBatchCount` 与 `lastInvalidBatchRejection`。外层请求 Schema 无效时记录固定 reason code `invalid_request_schema`；服务或环境未注册时记录 `service_environment_unregistered`。最近一次记录仅含 reason code、由 Trace ID middleware 解析/生成的 `requestTraceId` 和 ISO 时间戳，不保留请求 body、projectKey、Zod 错误详情或 `Span.error`。该计数与最近记录只存在当前 API 进程内，重启会重置；排查时可用 `requestTraceId` 与响应 `x-trace-id` 关联。

## 管理 API

所有项目、服务、环境和密钥路由均要求管理员令牌。

该令牌是平台级管理凭证，只能由可信服务端持有。当前 Web 不应直接调用这些受保护路由，也不能把令牌放进 `VITE_*` 配置；控制台联调前需确定服务端代理/BFF 或正式的用户身份与权限方案。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/projects` | 项目列表 |
| `POST` | `/api/v1/projects` | 创建项目：`{ "name": "客服智能体", "slug": "support-agent" }`；`retentionDays` 可选，默认 30 |
| `GET` | `/api/v1/projects/:projectId/services` | 项目服务列表 |
| `POST` | `/api/v1/projects/:projectId/services` | 注册服务：`{ "name": "api", "environment": "dev", "sdkVersion": "1.0.0" }` |
| `GET` | `/api/v1/projects/:projectId/environments` | 返回该项目已注册服务中的去重环境数组 |
| `GET` | `/api/v1/projects/:projectId/keys` | 项目密钥元数据列表，不返回明文或 Hash |
| `POST` | `/api/v1/projects/:projectId/keys` | 创建项目密钥：`{ "name": "local-sdk" }`；响应中的 `key` 只展示一次 |
| `DELETE` | `/api/v1/projects/:projectId/keys/:keyId` | 撤销密钥（设置 `revokedAt`，重复撤销幂等） |

环境只接受 `dev`、`staging`、`prod`。项目/服务/密钥创建严格拒绝未声明字段；项目 slug 唯一，服务按现有表约束以项目、名称、环境组合唯一。项目密钥格式为 `tr_` + 32 字节 Base64URL；数据库只保存 SHA-256 Hash 与用于识别的前缀，Scope 固定为 `spans:write`。

## Trace ID

API 接收单个符合 W1 格式的 `x-trace-id` 时沿用该值；缺失、格式无效或重复/歧义时生成 `trace_v1_<UUID>`。请求 Body 不参与 Trace ID 解析。中间件会在路由执行前设置响应头，因此成功和异常响应都会带 `x-trace-id`；CORS 同时暴露该响应头。

## 测试

运行 `pnpm --filter @trace-ops/api test`。测试使用 Node 内置 `node:test`，管理逻辑通过 mock 数据库覆盖，不连接或修改 PostgreSQL。
