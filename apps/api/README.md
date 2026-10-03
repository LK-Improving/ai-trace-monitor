# API 服务

NestJS API 监听 `API_PORT`（默认 `3001`），路由前缀为 `/api/v1`。当前包含健康检查、项目/服务/密钥与 Span 接入 API、Trace 查询、去重总览及 AI 指标，并提供服务端/RAG/LLM 埋点、告警处理和告警通知渠道。通知地址加密存储，持久投递 worker 与 Collector 解耦。生产登录/RBAC、设置写操作和前端事件完整联查仍待 Phase 3 后续工作。

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

所有项目、服务、环境、密钥和 Overview 路由均要求管理员令牌。Overview 当前只读 ClickHouse 与项目/服务元数据；它不返回错误原文或 Span `attributes`。

该令牌是平台级管理凭证，只能由可信服务端持有。Web 浏览器不得直接持有该令牌，也不能把令牌放进 `VITE_*` 配置。当前本地 Vite 服务端代理按路径、方法、查询与 JSON 字段白名单转发管理请求：允许项目/Overview/指标/Trace/告警读取，以及告警状态更新和告警通知渠道/重试操作；不代理项目、服务或密钥写操作。生产部署仍需可信反向代理/BFF 或正式的用户身份与权限方案。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/projects` | 项目列表 |
| `GET` | `/api/v1/overview?projectId=<uuid>&environment=all&range=24h` | 总览指标、趋势、服务健康和最近错误；环境可选 `dev` / `staging` / `prod` / `all`，时间范围可选 `1h` / `24h` / `7d` |
| `POST` | `/api/v1/projects` | 创建项目：`{ "name": "客服智能体", "slug": "support-agent" }`；`retentionDays` 可选，默认 30 |
| `GET` | `/api/v1/projects/:projectId/services` | 项目服务列表 |
| `POST` | `/api/v1/projects/:projectId/services` | 注册服务：`{ "name": "api", "environment": "dev", "sdkVersion": "1.0.0" }` |
| `GET` | `/api/v1/projects/:projectId/environments` | 返回该项目已注册服务中的去重环境数组 |
| `GET` | `/api/v1/projects/:projectId/keys` | 项目密钥元数据列表，不返回明文或 Hash |
| `POST` | `/api/v1/projects/:projectId/keys` | 创建项目密钥：`{ "name": "local-sdk" }`；响应中的 `key` 只展示一次 |
| `DELETE` | `/api/v1/projects/:projectId/keys/:keyId` | 撤销密钥（设置 `revokedAt`，重复撤销幂等） |

环境只接受 `dev`、`staging`、`prod`。项目/服务/密钥创建严格拒绝未声明字段；项目 slug 唯一，服务按现有表约束以项目、名称、环境组合唯一。项目密钥格式为 `tr_` + 32 字节 Base64URL；数据库只保存 SHA-256 Hash 与用于识别的前缀。密钥 scope 为单项 `spans:write` 或 `trace:read`，具体行为见 W26–W29 小节。

Overview 的全局请求量、错误数、P95 与趋势按根 Span（`parent_span_id = ''`）统计，排除 `browser.web_vital`、`browser.javascript_error`、`browser.unhandled_rejection` 这些非请求诊断事件，避免把性能事件或同一 Trace 的 RAG/LLM 子 Span 重复算成多次请求。`browser.network_error` 记录失败的网络请求，参与该指标；当前 SDK 不采集成功网络请求，因此仅有浏览器事件的项目不应把该错误率视为全站请求错误率。Token 合计只统计带模型标识或 `llm.generate` 操作的 Span，避免根 Span 复制 Token 用量造成双计。服务状态按全部服务 Span/事件聚合：错误率达到 1% 为 `degraded`，窗口内没有 Span 为 `no_data`。该阈值用于当前 MVP 展示，后续规则配置化另行排期。

## Trace ID

API 接收单个符合 W1 格式的 `x-trace-id` 时沿用该值；缺失、格式无效或重复/歧义时生成 `trace_v1_<UUID>`。请求 Body 不参与 Trace ID 解析。中间件会在路由执行前设置响应头，因此成功和异常响应都会带 `x-trace-id`；CORS 同时暴露该响应头。

## W9–W11 服务端链路记录

下列周阶段小节保留开发时点说明；当前查询能力和页面状态以本文开头及 W18–W20 控制台文档为准。

已加入框架独立的 `src/observability/trace-recorder.ts` 和 NestJS `ObservabilityModule`。平台 API 默认关闭服务端埋点，避免未绑定租户就写入监控数据。先在项目中注册服务和环境，再设置服务端配置并重启 API：

```dotenv
SERVER_TRACE_ENABLED=true
SERVER_TRACE_PROJECT_ID=<已注册项目 UUID>
SERVER_TRACE_SERVICE=<已注册服务名>
SERVER_TRACE_ENVIRONMENT=dev
```

这些值只能来自可信服务端配置，不能从请求 body、租户 header 或浏览器 `VITE_*` 配置取得。启动时进行一次限时注册校验；配置错误、未注册或 PostgreSQL 不可用时停用埋点，不阻止 API 启动。`GET /api/v1/health` 的 `tracing.state` 显示 `disabled / ready / invalid_configuration / unregistered_binding / dependency_unavailable`；修复配置或注册后需要重启。运行期注册状态变更暂不热更新，正式多租户接入需在可信网关实时鉴权，此静态绑定不是客户端上报鉴权的替代。

启用后，经过 NestJS 拦截器的请求产生 `http.server` 根 Span，继承 middleware 解析的 `x-trace-id`，在响应 `finish` 或提前 `close` 时结束并写入现有有界队列。不等待 Kafka 连接、发送或 ClickHouse 写入。健康检查与整个 `/spans` 接入/状态路径排除，避免监控自己的上报造成递归。Nest Guard 拒绝、找不到路由、body parser 提前拒绝发生在拦截器之前，当前只返回 Trace ID，不产生根 Span；此边界不应被误解为覆盖所有入口失败。

业务模块导入 `ObservabilityModule` 并注入 `TraceContext`，可自动继承上下文：

```typescript
await this.traceContext.withSpan('rag.retrieve', async span => {
  const documents = await this.retriever.retrieve(question);
  span.set('topK', documents.length);
  return documents;
});
```

`withSpan` 仅在有效上下文中使用；监控关闭时可先判断 `this.traceContext.current()` 并直接执行原业务。独立调用 `new TraceRecorder(binding, sink)` 支持 `start(operation, traceId, parentSpanId?)`、`set`、`setUsage`、同步幂等 `end(error?)`。Sink 应只同步排队，不能在回调中做同步 I/O；异步 sink 的 rejection 与同步抛错会被隔离，调用方仍应使用有界队列。属性会脱敏、限制大小并生成不可共享的快照；`set` 和 `setUsage` 的无效开发参数会抛错。异常只保留固定安全分类和状态，不记录原始 message、stack、Prompt 或 Response。属性过滤不能识别所有伪装在普通字段中的用户原文，调用方必须只写安全元数据。

W9–W11 交付记录器与接入基础；后续 W11–W14 调用适配见下节。模型定价、Trace 查询和执行树页面仍按后续排期实现。隔离验收控制器只位于 `scripts/`，不会被生产 API 引入。

运行全工作区构建后，可显式执行真实链路验收：

```powershell
$env:TRACE_OPS_RUN_INTEGRATION = '1'
node scripts/w9-chain-acceptance.cjs
```

脚本仅连接本机依赖，创建并清理独立项目、Topic、消费组和本次进程；安全结果在 `output/acceptance/w9-chain-result.json`。该脚本使用构建入口。2026-10-02 独立开发模式检查确认 Node v24.0.0 / tsx 4.23.15 下 Collector `tsx watch src/main.ts` 成功订阅；历史 Node20 加载失败仍保留，不等于整套 `pnpm dev` 验收已通过。

## W11–W14：模型与 RAG 调用适配

业务模块导入 `ObservabilityModule` 并注入 `AiAdaptersService`，通过 `llm().complete({ model, messages, signal? })`、`llm().stream(...)` 或 `rag().retrieve({ vector, topK, signal?, rerank? })` 发起真实 HTTP 调用。客户端按需创建；没有 Trace 上下文或关闭监控时仍执行原业务。平台不新增公开模型代理接口，测试控制器只在 `scripts/w11-fixture-server.cjs`。

根目录 `.env.example` 中的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_TIMEOUT_MS` 与 `RAG_QDRANT_URL`、`RAG_QDRANT_COLLECTION`、`RAG_QDRANT_API_KEY`、`RAG_TIMEOUT_MS` 只用于可信服务端。缺少配置只在使用该客户端时失败，不阻止 API 启动。不要使用 `VITE_*` 或提交真实凭证。远程端点必须 HTTPS；纯 HTTP 仅允许 loopback，容器内部明文域名暂不接受。禁止 URL 内嵌凭证、查询参数和重定向，不自动重试付费调用。默认总超时 30 秒，允许整数 100–120000 毫秒。

LLM 产生 `llm.generate`，记录请求/返回模型、安全结束原因、总耗时、usage 可用标记及 Token。流式 TTFT 从首个非空内容 delta 计算，不把角色或响应头当首 Token；普通调用不伪造 TTFT。缺失 usage 保持未知，输入输出为非负安全整数，提供的总数必须等于两者之和。流中途关闭、超时和协议不完整为失败；已收到的 usage 是部分可用数据，不表示调用成功。消费方应使用 `for await` 或显式 `return()` 关闭迭代器，不能遗弃未关闭的迭代器。

RAG 使用 Qdrant Query Points API；`rag.retrieve` 下包含 `rag.recall` 和可选 `rag.rerank`。记录 topK、召回数量、空召回、SHA-256 文档 ID 标识及召回/重排耗时。排名快照最多各 20 条，保留总数和截断标记，业务 topK 上限仍为 100。重排回调只允许已有文档重排、调整分数或取子集，不能引入新 ID；接收 AbortSignal，总超时不因回调忽略取消而无限等待。超时不能强制停止回调内部副作用，回调实现仍需协作取消。向量生成和重排模型不在该适配器内实现。

未提供 `rerank` 回调时不产生重排 Span 或 `rag.rerank_ms`，聚合样本数为零；真实执行且耗时为零的重排仍是有效样本。页面需结合样本数区分“未观测”和“耗时为零”。

Prompt、回答、向量、文档正文/URL、原始异常和密钥不写入监控；业务返回仍包含模型内容和 Qdrant payload。哈希是关联标识，不是加密或不可逆匿名化承诺。错误分类固定为限流、超时、认证、内容过滤、提供方、网络、协议、取消或输入无效。

协议参考：[OpenAI Chat](https://developers.openai.com/api/reference/resources/chat)、[Qdrant Query Points](https://api.qdrant.tech/api-reference/search/query-points)。运行构建后，可用 `$env:TRACE_OPS_RUN_INTEGRATION = '1'` 和 `node scripts/w11-chain-acceptance.cjs` 验证本地协议服务 → API → Kafka → Collector → ClickHouse。该验收不调用付费模型，也不证明真实 Qdrant 引擎召回质量；结果和清理记录在 `output/acceptance/w11-chain-result.json`。

## W13–W16：Trace 查询

`GET /api/v1/traces` 和 `GET /api/v1/traces/:traceId` 使用现有 `AdminTokenGuard`。仅可信服务端持有平台管理员令牌；项目写入密钥不能读取。需求中的项目成员 `trace:read` RBAC 尚未实现。当前前端仍是演示 Trace 页面，本轮不增加浏览器持有令牌或开放任意读代理。

列表参数：`projectId` 必填 UUID；`environment=all|dev|staging|prod` 默认 all；`from`、`to` 必填 UTC ISO Z 字符串（秒或三位毫秒），半开窗口最多 30 天；可选 `traceId`、`service`、`status=ok|error`；`page` 默认 1，`pageSize` 默认 20、最大 100，offset 最大 10000。未知字段、数组参数、非法时间与分页均 400。

详情参数：`projectId` 和具体 `environment=dev|staging|prod` 必填；可选成对 `from/to`，默认最近 30 天；`includeContent=false` 可省略，true 一律 403。额外的项目/环境上下文用于隔离同名 Trace，不能仅凭路径 ID 读取全库。

列表以环境/Trace 为单位聚合，按 Span ID 去重后统计；服务筛选匹配整链中的服务，任一 Span 出错时 Trace 为 error。耗时取最早开始到最晚结束，不累加并行耗时；Token 只统计模型调用，根 Span 的复制 usage 不计。详情返回安全 Span 字段、摘要、错误分类和扁平执行树；孤儿、环和多个根显式标记。原始 error 与任意属性不返回，属性只保留严格类型约束的监控元数据。缺资源 404、依赖/查询预算/坏存储结果 503，错误响应不附带 SQL 或原文。

详情最多返回 2000 Span，超出以 truncated 标记；摘要只基于返回集合。Span 明细保留原始 parentSpanId，tree.nodes 的连接单独修复孤儿/环。列表单项最多 120 个服务标识，超过时安全 503。跨时间窗、丢失或异步未入库的 Span 会造成不完整链路。列表 COUNT 和分页读取无事务快照，持续写入时 offset 分页可能漂移。查询侧去重不改变旧 Overview 或 ClickHouse 原始存储。

共享 ClickHouse 查询有 10 秒客户端超时、5 秒执行预算、100 万行/64 MiB 读取预算、2001 行/8 MiB 结果预算和 128 MiB 内存预算，超限抛错，不返回假完整数据；Overview 同样受此保护。性能目标需后续 W15–W18 在代表性数据集测量，不能从小型功能验收推断 P95 达标。

本地验收：构建后设置 `$env:TRACE_OPS_RUN_INTEGRATION = '1'`，执行 `node scripts/w13-chain-acceptance.cjs`。脚本使用隔离项目和 Topic，真实 HTTP、Kafka、已构建 Collector、ClickHouse，再验证列表和详情接口，最终清理本次资源。结果在 `output/acceptance/w13-chain-result.json`。

## W15–W18：聚合指标

新增 `GET /api/v1/metrics/overview` 与 `GET /api/v1/metrics/ai`，均要求可信服务端的管理员令牌。`projectId` 必填；环境默认 all；可选 `service`。时间使用 `range=1h|24h|7d`（默认 24h），或成对 `from/to` UTC ISO Z 半开窗口（最多 30 天），不能同时使用两种模式。`groupBy` 当前仅支持 service；模型分组由 topModels 和 AI 接口提供。未知/数组参数、非法窗口返回 400，缺项目 404，依赖故障、坏存储结果或查询预算超限返回固定 503。

总览按项目/环境/Trace/Span 去重后聚合：每条存在请求根节点的 Trace 计一次请求，任一子节点失败计为失败请求；单独的浏览器诊断和无根链路不计请求。延迟取整链最早开始至最晚结束，P50/P95/P99 使用精确分位数。Token 只合计 `llm.generate`，即使根节点复制 usage/model 也不重复计费。无根链路中的模型调用仍计 Token。服务筛选匹配整条链路；服务健康表本身是去重后 Span 级计数，不能与请求总数相加。

总览响应包含需求 6.4 的 `summary`、`timeseries`、`services`、`topModels`；同时保留同值 `metrics` / `series` 作为现有总览形状的兼容字段。包含零填充趋势及安全最近错误摘要。AI 接口返回 `llm`、`rag`，LLM 统计调用量、输入/输出/总 Token、总延迟与首 Token 延迟及模型分组；RAG 只统计 `rag.retrieve`，不重复计算 recall/rerank 子节点。AI 的服务筛选是调用 Span 级筛选。

成功率为成功 RAG 调用数/全部 RAG 调用数；空召回率为成功且数量可观测的空召回数/可观测成功调用数，无可观测数量时为空值 null。TTFT、召回、重排耗时只接受有效 JSON 中有限的非负数值，缺失/非法数据不当作零样本。样本数显式返回；零样本时耗时指标为零，不代表真实耗时为零。其他比例取值为 0–1。模型名只允许有限长度的标识字符，其他值合并为 `(unknown)`；模型分组最多 100 个，超出返回安全 503，不伪装完整结果。不会返回 Prompt、回答、文档原文/URL、原始 error 或任意 attributes。

旧 `/overview` 为首屏兼容暂时保留旧统计口径；W18–W20 页面切换时再迁移。新接口使用有预算的读取侧去重和聚合，没有新增物化视图或持久化长周期指标。直接对至少一次投递的原始块做累加物化视图会重复计数，因此持久化预聚合必须先设计跨批幂等与迟到更新策略，不能从本轮查询推断 30 天 TTL 后仍有历史指标。所有统计只基于所选窗口内已入库的数据，跨窗或缺失 Span 可能造成不完整。

本地验收：`pnpm build` 后设置 `$env:TRACE_OPS_RUN_INTEGRATION = '1'`，运行 `node scripts/w15-metrics-acceptance.cjs`。复用隔离真实管道，另生成 10,000 条请求、50,000 个唯一 Span 和 1,000 行重投递数据；对 1h/24h/7d 的列表、指标总览和 AI 查询测量 HTTP P95。结果写入 `output/acceptance/w15-metrics-result.json`，测试结束清理自有项目、行、Topic/消费组及进程。该本地合成基线不是生产并发或容量承诺。

## 单元测试

运行 `pnpm --filter @trace-ops/api test`。测试使用 Node 内置 `node:test`，管理逻辑通过 mock 数据库覆盖，不连接或修改 PostgreSQL。

## W21–W24：内置告警与处理 API

Collector 对每个通过 Span Schema 校验的消息执行四条固定规则：

| 规则 | 触发条件 | 默认级别 |
| --- | --- | --- |
| `span_error` | Span `status=error`，每个唯一 Span 触发一次 | critical |
| `span_latency` | 有结束时间且单 Span 耗时严格大于 2,000ms | warning |
| `llm_token_threshold` | `llm.generate` 的单次 `tokenUsage.total` 严格大于 5,000 | warning |
| `rag_empty_recall` | 成功的 `rag.retrieve` 且明确报告零召回：`rag.recalled_count=0`、`retrievedCount=0` 或空 `sources` 数组 | warning |

阈值为 MVP 固定默认值，不支持控制台编辑；Token 规则按单次模型 Span 判断，不跨请求累计。Span error 的告警消息不带原始异常正文。规则匹配结果按 `projectId/environment/service/rule` 分开聚合；每个当前未解决事件记录首次/最近触发时间与唯一触发 Span 数。重复 Kafka 投递先写入 occurrence 唯一键账本，同一项目、环境、服务、规则、Trace 和 Span 只计一次。事件已确认时，后续新 Span 增加触发数但保持 acknowledged；事件 resolved 后的新 Span 建立新事件。API 显式重开已 resolved 事件时，如果相同规则范围已有 active/acknowledged 事件，返回 409。

所有接口均由 `AdminTokenGuard` 保护，需要服务端 `Authorization: Bearer <PLATFORM_ADMIN_TOKEN>`：

- `GET /api/v1/alerts?projectId=<uuid>&environment=<dev|staging|prod|all>&state=<active|acknowledged|resolved|all>&level=<info|warning|critical|all>&page=1&pageSize=20`：返回 `{items,total,page,pageSize}`；默认 environment/state/level 为 `all`，page/pageSize 为 `1/20`，pageSize 上限 100，最大 offset 为 1,000,000。条目字段为 `id,title,message,rule,service,environment,level,state,traceId,spanId,firstSeenAt,lastSeenAt,triggerCount`。
- `GET /api/v1/alerts/summary?projectId=<uuid>&environment=<dev|staging|prod|all>`：返回 `total,active,acknowledged,resolved,criticalActive`，按告警事件数统计，criticalActive 只计 active 状态。
- `PATCH /api/v1/alerts/:id/state`，body 为 `{ "state": "acknowledged" | "resolved" | "active" }`：由 API 更新状态；active 可确认或解决，acknowledged 可解决或重开，resolved 只可重开；相同状态重复写入幂等。目标不存在返回 404，非法过滤/状态转换返回 400，重开与已有未解决事件冲突返回 409。

告警 schema 位于 `infra/postgres/init/002-alerts.sql`。PostgreSQL 的 initdb SQL 只会在空 volume 执行，因此 API 与 Collector 启动时也会在 PG advisory lock 下幂等应用该迁移，兼容已存在的 Compose volume。Collector 先在 PostgreSQL 事务中写入告警 occurrence，再插入 ClickHouse，最后提交 Kafka offset。PostgreSQL 失败时不会写 ClickHouse 或提交 offset；ClickHouse 失败时 PostgreSQL occurrence 已提交，但未提交的 Kafka 批次重放会被唯一键吸收，不重复增加告警触发数。ClickHouse 使用 topic/partition/offset 批次生成去重 token，并在现有 MergeTree 表启用有限去重窗口，避免相同批次的写入重试重复落行。该去重 token 针对相同 Kafka 批次，不代表跨不同 offset 的相同业务 Span 会在 ClickHouse 合并；查询侧仍按 Span ID 去重。

旧版 `alert_items.status='muted'` 不迁移到新告警 API：旧记录缺少 environment/service/built-in rule 等字段，且 muted 表示静默通知而非 resolved。旧 `alert_items` 数据原样保留，新接口只读取具备完整范围字段的 `alert_incidents`，避免把静默状态伪装为已解决。

## W24–W27：告警通知渠道与持久投递

所有下列接口同样由 `AdminTokenGuard` 保护。渠道和投递记录均按项目隔离；渠道查询只返回掩码后的 `destinationHint` 与 `hasSecret`，不回传加密值或明文目标。渠道名称在同一项目内不区分大小写且不可重复。

- `GET /api/v1/alerts/channels?projectId=<uuid>`：返回 `{items}`，包含 Webhook/Email 类型、环境范围、最低级别、启用状态和目标摘要。
- `POST /api/v1/alerts/channels`：创建渠道。Webhook body 使用 `type=webhook,webhookUrl`；Email 使用 `type=email,recipient`；共同字段为 `projectId,name,environment,minLevel,enabled`。目标在 API 内使用 `ALERT_NOTIFICATION_ENCRYPTION_KEY`（32 字节 Base64）经 AES-256-GCM 加密后写入 PostgreSQL。密钥缺失/格式错误时创建和修改操作失败关闭。
- `PATCH /api/v1/alerts/channels/:id`：只更新提供的字段；渠道类型固定，Webhook URL 或 Email 地址留空表示保留现有值。
- `DELETE /api/v1/alerts/channels/:id?projectId=<uuid>`：软删除渠道并取消尚未完成的投递，保留历史记录。已在外部网络发送中的任务无法撤销。
- `POST /api/v1/alerts/channels/:id/test`，body `{projectId}`：只把测试任务入队，返回 `{queued:true}`，不等待网络发送。
- `GET /api/v1/alerts/deliveries?projectId=<uuid>&status=<all|queued|sending|retrying|sent|failed|canceled>&page=1&pageSize=20`：分页查看送达状态与固定错误码，不回显目标和 SMTP/Webhook 响应正文。
- `POST /api/v1/alerts/deliveries/:id/retry`，body `{projectId}`：仅可人工重试最终失败记录，每条记录最多人工重试 3 次。

Collector 在创建新的告警事件的同一 PostgreSQL 事务内，为当前匹配渠道写入通知 outbox；已有未解决事件只增加触发数，不重复入队。Collector 不访问邮件或 Webhook。API worker 使用 `FOR UPDATE SKIP LOCKED` 抢占待发送记录、维护 30 秒租约、回收过期任务；自动尝试最多 5 次，退避为 15 秒、1 分钟、5 分钟、15 分钟、30 分钟。Worker 崩溃或数据库确认前崩溃可由租约恢复；外部服务已接受而本地未记录成功时可能重复投递，因此 Webhook 请求同时附带稳定 `Idempotency-Key` 和 `X-Trace-Ops-Delivery-ID`，接收端应按该 ID 去重。

Webhook 默认限定 HTTPS，API 对 DNS 解析结果校验公网地址并固定本次连接 IP，不跟随 3xx；私有地址拒绝投递。`ALERT_NOTIFICATIONS_ALLOW_PRIVATE_TARGETS=true` 只在 `NODE_ENV=development` 或 `test` 时生效，用于隔离的本地 HTTP receiver 验收；生产环境即使误配置为 true 也会忽略。Email 使用 `SMTP_HOST/PORT/SECURE/FROM/USER/PASSWORD` 服务端配置；本地 Compose 提供 Mailpit，SMTP 绑定 `127.0.0.1:1025`，网页界面绑定 `127.0.0.1:8025`。邮件和 Webhook 只含告警 ID、标题、规则、级别、服务、环境、Trace ID 等元数据，不含 Prompt/Response、原始异常或任意 Span attributes。错误详情统一收敛成固定分类码，禁止记录外部响应体、收件地址和目标 URL。

版本迁移 `infra/postgres/init/003-alert-notifications.sql` 与 `002-alerts.sql` 一样，会在 API 与 Collector 启动时持同一个 PostgreSQL advisory lock 幂等执行，因此已有 Compose 数据卷无需删除或重建。

回归验证：`pnpm --filter @trace-ops/api test` 和 `node --test apps/collector/tests/*.test.mjs`。PostgreSQL 端到端幂等/状态测试默认跳过；PowerShell 中可从仓库根目录设置 `$env:TRACE_OPS_RUN_ALERTS_INTEGRATION='1'` 后运行 `node --env-file=.env --test apps/api/tests/alerts-postgres.integration.test.mjs`，完成后用 `Remove-Item Env:TRACE_OPS_RUN_ALERTS_INTEGRATION` 清除本次开关。该用例创建随机命名临时项目，并在结束时验证删除本次项目及级联数据。

W24–W27 本机通知验收需要先启动 Compose Mailpit，再执行 `pnpm build`；PowerShell 中设置 `$env:TRACE_OPS_RUN_NOTIFICATIONS_INTEGRATION='1'` 并运行 `node --env-file=.env scripts/w24-27-notifications-acceptance.cjs`。脚本只接受 loopback PostgreSQL 与 `127.0.0.1:8025` Mailpit，使用临时加密密钥和独立项目/收件人，测试完成后清理；它会启动隔离 API/Web 并等待浏览器验收，在浏览器测完后向该命令输入 `finish` 触发清理。JSON 验收摘要写入 `output/acceptance/w24-27-notifications-result.json`，临时浏览器入口写入 `w24-27-notifications-session.json`。不要启用或提交 `.env` 中的真实 SMTP 凭证。

## W26–W29：项目访问控制、隐私策略与审计

本阶段用 project API key 实现机器身份的最小读写隔离；没有用户登录/身份提供方，因此项目管理接口仍只接受服务端 `PLATFORM_ADMIN_TOKEN`，`members` 表不作为已生效的用户 RBAC，也不会接受请求体自报 actor。新审计记录统一使用 `actorId=platform_admin`。

- API key scope 只允许 `spans:write` 和 `trace:read`，每把 key 必须且只能有一个 scope；需要读写能力时创建两把独立凭证。`POST /api/v1/projects/:projectId/keys` 接受 `{ "name": "api-prod", "scopes": ["spans:write"] }`；省略 `scopes` 时默认 `spans:write`。列表只返回 `keyPrefix` 与 `scopes` 等非秘密元数据；创建和轮换响应中的 `key` 仅展示一次，服务端只持久化 SHA-256 hash。迁移会撤销并规范化此前可能创建的组合/非法 scope key，需为对应用途分别重新创建凭证。
- `POST /api/v1/projects/:projectId/keys/:keyId/rotate` 原子撤销旧 key、生成继承原 scope 的新 key，并返回新明文一次。`DELETE /api/v1/projects/:projectId/keys/:keyId` 为幂等撤销。密钥管理路由仍只由平台管理员保护。
- Trace list/detail 可继续用管理员 Bearer 凭证，也可用 `Authorization: Bearer <project-key>`。项目 key 必须有 `trace:read`，并且请求必须显式指定 `projectId`；key 与查询项目不一致返回 403，无效或已撤销 key 返回 401。该授权只覆盖 Trace 读接口，不扩展到项目、密钥、服务、隐私策略或其他写 API。Span ingest 仍必须有 `spans:write`。
- `GET /api/v1/projects/:projectId/privacy` 与 `PATCH` 读取/更新 `{ "additionalRedactedFields": ["customer_email", "tenant_id"], "capturePromptResponse": false }`。字段名递归匹配，最多 64 项、每项 1–64 个 ASCII 字母/数字/下划线/连字符，按大小写不敏感去重。`capturePromptResponse` 只能为 `false`；尝试开启返回 403。Span 入队前读取项目策略并在默认脱敏规则之外递归过滤这些字段；策略缺失、损坏或 Postgres 不可用时失败关闭，不会绕过脱敏。
- 关键变更（服务创建、key 创建/轮换/撤销、隐私策略变更）与业务写入在同一 SQL 语句提交审计。审计不写 key/hash、Prompt/Response、用户原文或字段值；`GET /api/v1/projects/:projectId/audit-logs?page=1&pageSize=20` 仅接受 `page`、`pageSize` 两个正整数字符串参数（不接受 `limit` 等别名或重复数组值），page 默认 1、pageSize 默认 50/上限 100，最大 offset 10,000。响应条目安全投影为 `{ id, actorId, action, resource, createdAt }`：`id` 是 bigint 的十进制字符串，不含 `projectId`、`details` 或其他审计载荷。删除项目时 `project_id` 按既有 `ON DELETE SET NULL` 置空，审计行及其安全上下文保留；trigger 禁止直接 UPDATE、DELETE 和 TRUNCATE。
- 服务接入 API 已由管理员凭证保护：`POST /api/v1/projects/:projectId/services` body 为 `{ "name": "api", "environment": "prod", "sdkVersion": "1.2.3" }`，环境只允许 `dev|staging|prod`；服务名在同一项目/环境内唯一。新建服务会同步写入安全审计元数据。`GET /api/v1/projects/:projectId/services` 查询接入配置。

迁移 `infra/postgres/init/004-project-access-privacy-audit.sql` 有版本号且可重复应用；新建项目由数据库触发器自动获得默认隐私策略（不采集原文），已有项目在迁移时补齐默认策略。API 启动时会在与告警迁移相同的 PostgreSQL advisory lock 下应用 002–004，因此现有 Compose volume 不需删除或重建。测试：`pnpm --filter @trace-ops/api test` 与 `pnpm --filter @trace-ops/api typecheck`。可选 PostgreSQL migration 实测只允许 loopback：PowerShell 中设置 `$env:TRACE_OPS_RUN_PROJECT_SECURITY_INTEGRATION='1'` 后运行 `node --env-file=.env --test apps/api/tests/project-security.integration.test.mjs`；测试事务回滚临时数据，不会清理共享数据。
