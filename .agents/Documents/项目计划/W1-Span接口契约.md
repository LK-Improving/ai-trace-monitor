# Phase 1 W1：Span 接口契约

> 状态：W1 定稿（契约层，不包含 API / SDK / Collector 鉴权实现）  
> 日期：2026-09-25  
> 依据：AI 全链路监控平台需求文档、架构图及开发排期 W1；实现位置：`packages/contracts`

## 1. 约定摘要

- Span 状态为 `ok | error`。时间戳为 Unix epoch 毫秒；`endTime` 可省略，提供时不能早于 `startTime`。
- 环境在线路和存储中的唯一规范值为 `dev | staging | prod`。展示层的 “Development / Staging / Production” 必须映射为规范值，不能把 `development` 或 `production` 当作上报值。
- Kafka 内部事件版本为 `schemaVersion: 1`。生产者显式写入 `1`；消费者兼容无版本字段的既有 v1 消息，并拒绝不支持的版本。
- `x-trace-id` 是 Trace ID 的 HTTP 请求上下文来源；有效的入站 Header 优先，否则生成新 ID。成功与失败响应均回传最终 ID。可选的 `x-parent-span-id` 只能补充父 Span 上下文，不能决定或替代 Trace ID。
- 项目密钥只授予单项目 `spans:write` 权限。鉴权后由服务端解析项目身份；明文密钥不得进入 Span、Kafka、ClickHouse 或日志。

## 2. Span 与事件模型

接入方提交的 `TraceSpan` 字段如下；字段名及类型与 `packages/contracts/src/index.ts` 中的 `TraceSpanSchema` 一致。

| 字段 | 类型 | 语义 / 约束 |
| --- | --- | --- |
| `traceId` | string | 全链路 ID；最大 128 字符，限安全可打印字符 |
| `spanId` | string | 当前操作 ID；1–128 字符 |
| `parentSpanId` | string? | 父 Span ID；根 Span 省略 |
| `service` | string | 服务名；1–120 字符 |
| `operation` | string | 操作名，如 `http.server`、`rag.retrieve`、`llm.generate` |
| `startTime` | integer | 开始时间，Unix epoch 毫秒，非负 |
| `endTime` | integer? | 结束时间，Unix epoch 毫秒，非负且不早于开始时间 |
| `status` | `ok \| error` | 操作结果 |
| `attributes` | object | 扩展属性，默认 `{}`；内容字段和凭证类属性会递归过滤 |
| `tokenUsage` | object? | `input`、`output`、`total` 均为非负整数 |
| `error` | string? | 错误摘要，最多 8,000 字符；不得放入密钥或敏感原文 |

Kafka / Collector 消费的 `SpanEvent` 在 Span 基础上增加：

| 字段 | 语义 |
| --- | --- |
| `schemaVersion` | 固定为 `1`；生产者必须显式填写，解析无版本的旧消息时补成 `1` |
| `projectId` | UUID；从已验证的项目密钥上下文注入，不接受调用方决定项目归属 |
| `environment` | `dev | staging | prod`；必须通过环境枚举校验 |

上报请求按需求文档采用 JSON `{ projectKey, environment, spans }`；一次最多 500 个 Span。`projectKey` 必须符合 `tr_` + 32 个随机字节的 Base64URL 表示（43 字符）。请求外层严格校验，不接受调用方提供 `projectId`。服务端验证密钥后剥离 `projectKey`，再将密钥所绑定的 `projectId` 和已授权环境写入内部事件。API 上报实现尚未在 W1 编写。

## 3. Trace ID 规则

1. 浏览器 SDK 在业务请求前检查调用方提供的 `x-trace-id`；符合契约的单一值原样复用，否则生成 `trace_web_${crypto.randomUUID()}`。若环境不支持 `randomUUID()`，可用 Web Crypto `getRandomValues()` 生成 UUID；没有安全随机源时必须失败，不得退回 `Math.random()` 或时间戳。
2. API 接收请求时以一个有效的 `x-trace-id` 为准。Header 缺失、格式不合规或出现歧义的重复 Header 时，API 生成新的 `trace_v1_${crypto.randomUUID()}`；不得从请求 Body 的同名字段回退。
3. 服务端后续内部调用、RAG / LLM 调用及记录的 Span 透传同一 Trace ID；不同 Span 用 `spanId / parentSpanId` 构成执行树。
4. API 成功或失败响应都设置 `x-trace-id` 为最终解析值；浏览器跨域场景同时通过 `Access-Control-Expose-Headers: x-trace-id` 暴露该 Header。不能把无效的入站值回显给客户端。
5. `resolveTraceId` 和 `traceIdResponseHeaders` 仅提供共享契约工具；具体 HTTP 中间件、异常处理器和 SDK 注入安排在后续周次实现。

可选的 `x-parent-span-id` 只用于 HTTP 入站请求的父 Span 关联：仅当请求同时带有唯一、有效的 `x-trace-id` 时，API 才接受唯一的 32 位小写十六进制 parent ID，并将其写为 `http.server` Span 的 `parentSpanId`，不写入 attributes。Trace ID 缺失、无效或歧义时 API 仍按上述规则生成新 ID，同时忽略 parent，避免把新 Trace 错挂到其他 Trace 的孤儿父节点。它不能来自请求 Body，也不携带身份或权限。反向代理/BFF 如需支持跨服务关联，只能显式白名单透传这两个 Header；浏览器 SDK 不向跨域请求自动传播。

允许的 ID 正则为 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`。`trace_web_` 和 `trace_v1_` 分别是浏览器与服务端生成 ID 的推荐前缀，并非拒绝有效调用方 ID 的硬性前缀；两个前缀均通过同一 Trace ID 格式校验。

## 4. schemaVersion 与兼容策略

- v1 生产者写出 `schemaVersion: 1`；`SpanEventSchema` 对旧消息缺失版本的情形补默认值 `1`。
- 显式版本不是 `1` 时拒绝该事件，不猜测解析方式；不支持的版本不得写入 Kafka 消费成功路径或 ClickHouse。
- v1 中新增可选字段可向后兼容；现有字段改名、删除、改单位或改变语义均属破坏性变更，必须升至 v2，并在升级期提供能同时读取 v1/v2 的消费者，再切换生产者。
- 现有对象 Schema 会忽略未知顶层字段；新增内容应进入 `attributes`，并同时补契约测试。上报请求外层严格校验，避免额外传入项目身份或凭证字段。
- ClickHouse 当前表不保存 `schemaVersion` 列：它用于消费边界校验，解析后按 v1 规范化；若后续需要查询版本，须另行评估显式加列和迁移。

## 5. 项目密钥信任边界

- 密钥是高熵、一次性展示的接入凭证，单个密钥只绑定一个 `projectId`；W1 规范权限为 `spans:write`，不能读 Trace、读指标、管理项目或授予其他密钥。
- 依需求接口示例，密钥位于上报 JSON 的 `projectKey` 字段。API 必须在鉴权后立即丢弃明文；请求体日志、错误报告和平台自身 Trace 必须过滤该字段。禁止把完整请求体直接写日志。
- PostgreSQL `project_keys.key_hash` 仅存不可逆 Hash，`key_prefix` 只供控制台识别；明文不能写 PostgreSQL、Kafka、ClickHouse、Span 属性或返回的业务响应。校验还须检查撤销状态、项目绑定和 `spans:write` Scope，并采用固定时间比较。
- 上报请求不能自行指定 `projectId`；服务端按密钥查出的项目身份注入内部 `SpanEvent.projectId`。环境限定为该项目已登记且授权的 `dev / staging / prod` 环境。
- 共享契约中的敏感属性过滤会递归删除 Prompt / Response / 用户输入 / 文档正文及常见凭证字段；它是纵深防御，不替代鉴权前日志脱敏和服务端密钥隔离。
- 本文固化信任边界，不代表 W1 已实现 API 鉴权、密钥生成、哈希存储、轮换或撤销流程。

## 6. ClickHouse 字段映射

映射以 `infra/clickhouse/init/001-trace-spans.sql` 的 `observability.trace_spans` 为准。时间输出为 UTC `DateTime64(3)` 格式，数值单位为毫秒。

| Span / Event 源字段 | ClickHouse 列 | 转换规则 |
| --- | --- | --- |
| `startTime` | `event_time` | 按 UTC 毫秒转时间；事件时间按 Span 开始时间 |
| 服务端密钥上下文 `projectId` | `project_id` | UUID 转字符串；不从调用方值推断 |
| `environment` | `environment` | 只写规范枚举值 |
| `traceId` | `trace_id` | 原样 |
| `spanId` | `span_id` | 原样 |
| `parentSpanId` | `parent_span_id` | 根 Span 写空字符串 |
| `service` | `service` | 原样 |
| `operation` | `operation` | 原样 |
| `status` | `status` | `ok` 或 `error` |
| `startTime` | `start_time` | UTC `DateTime64(3)` |
| `endTime` | `end_time` | 未提供时取 `startTime` |
| `startTime / endTime` | `duration_ms` | `max(0, end-start)`，毫秒 Float64 |
| `tokenUsage.input` | `input_tokens` | 缺失时写 0 |
| `tokenUsage.output` | `output_tokens` | 缺失时写 0 |
| `tokenUsage.total` | `total_tokens` | 缺失时写 0 |
| `attributes.model` | `model` | 仅当其为字符串时写入，否则空字符串 |
| `attributes` | `attributes` | 过滤敏感键后 JSON 序列化 |
| `error` | `error` | 缺失时写空字符串 |
| `schemaVersion` | — | 校验并规范化，不在当前 DDL 持久化 |
| `projectKey` | — | 鉴权后丢弃，严禁入库 |

## 7. 迁移与测试约定

### 数据库迁移

- 现有 `infra/postgres/init/*.sql` 和 `infra/clickhouse/init/*.sql` 是空白开发卷的初始化脚本，不是对已有卷自动重放的迁移机制。
- 后续 PostgreSQL 变更约定使用 `infra/postgres/migrations/V0001__short_snake_case.sql` 形式；已应用迁移不可改写，版本号连续，单个迁移尽量在事务中执行。迁移执行器需记录版本及校验和、串行加锁，并在执行前后核对状态。数据回滚应提供经评审的补偿迁移，不默认自动执行破坏性 down migration。
- 后续 ClickHouse 变更约定使用 `infra/clickhouse/migrations/V0001__short_snake_case.sql`；文件不可改写，DDL 尽量幂等并向前兼容。ClickHouse 不具备通用事务回滚保证，采用新增列 / 回填 / 切读 / 清理的分步前向迁移；删除或改类型必须单独评审。
- W1 只确立目录、命名和执行约束；迁移 runner、版本历史表及真实 schema migration 不在本次范围。第一次改动已有持久卷前，必须先实现/选择迁移执行方式，不能依赖重新创建卷。

### 契约测试

- 合同测试放在 `packages/contracts/tests/*.test.mjs`，使用 Node 内置 `node:test` / `node:assert`，不额外引入测试依赖；`pnpm --filter @trace-ops/contracts test` 会先编译，再运行测试。
- 所有 Span 字段、版本、环境、ID、密钥边界、脱敏规则和 ClickHouse 映射改动都必须增加正向与拒绝路径测试；测试数据使用合成密钥和固定时间戳。
- 运行 `pnpm --filter @trace-ops/contracts typecheck` 检查公共 TypeScript 类型。变更必须同时通过测试和 typecheck。

## 8. W1 验证结果

- `pnpm --filter @trace-ops/contracts test`：通过，9/9。
- `pnpm --filter @trace-ops/contracts typecheck`：通过。
- `docker compose config --quiet`：通过；PostgreSQL 默认端口和本次临时端口覆盖均通过静态解析。
- PostgreSQL / Kafka / ClickHouse 容器健康与初始化验收记录见 [W1-Compose集成环境验收.md](./W1-Compose集成环境验收.md)。
