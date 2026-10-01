# AI 全链路监控平台

基于需求设计文档的 TypeScript 工作区。Phase 1 已实现项目/服务/密钥 API、浏览器 SDK 基础采集、Span 上报、Kafka → Collector → ClickHouse 与真实总览。Trace 检索与执行树、AI 链路、告警和配置页面仍为明确标记的 mock，不代表完整 MVP 已交付。现有 `prototype/` 交互原型保留不动。

项目开发阶段、相对周计划和里程碑见 [AI 全链路监控平台开发排期计划](.agents/Documents/项目计划/AI全链路监控平台-开发排期计划.md)。排期依据需求优先级与架构路线图编制，具体日历日期待项目启动和资源确认后锁定。

## 技术结构

```text
apps/
  web/        React + Vite 控制台
  api/        NestJS API 与 PostgreSQL 连接/健康检查
  collector/  Kafka Consumer 与 ClickHouse 批量写入
packages/
  contracts/  共享 Span schema、校验与敏感属性过滤
infra/
  postgres/   项目、服务、密钥、告警和审计表
  clickhouse/ trace_spans 明细表（30 天 TTL）
compose.yaml  PostgreSQL + Kafka + ClickHouse 本地依赖
prototype/    评审用静态原型，独立保留
```

Qdrant 和 OpenAI 兼容模型服务属于接入方应用依赖，本平台只接收对应的 RAG/LLM Span，不由这份 Compose 托管。

## 本地运行

需要 Node.js 20+、pnpm 10+ 和 Docker Desktop（Docker Compose v2）。在仓库根目录执行：

```powershell
Copy-Item .env.example .env
pnpm install
pnpm infra:up
pnpm dev
```

- 控制台：<http://localhost:5173>
- API 健康检查：<http://localhost:3001/api/v1/health>
- PostgreSQL：`localhost:5432`
- Kafka（本机进程连接）：`localhost:9092`
- ClickHouse HTTP：<http://localhost:8123>

启动前请配置本地 `.env` 中的 `PLATFORM_ADMIN_TOKEN`。若 PostgreSQL 使用 `POSTGRES_HOST_PORT=55432`，`DATABASE_URL` 的宿主机端口也应为 55432。若 3001 被其他应用占用，将 `API_PORT` 改为未占用的端口；Vite 代理跟随该配置。建议浏览器访问 `http://127.0.0.1:5173/`，避免其他应用占用 IPv6 localhost 地址。

Compose 只负责本地第三方依赖；API、Collector 和 Web 通过 `pnpm dev` 在宿主机启动。`pnpm infra:up` 会等待 PostgreSQL、Kafka、ClickHouse 的健康检查通过后返回。容器数据保存在 Compose 命名卷中。`pnpm infra:down` 会停止并移除容器，但保留数据卷。

PostgreSQL 与 ClickHouse 初始化 SQL 只会在各自数据卷首次为空时执行。后续表结构变更应使用版本化迁移，不要依赖重建数据库来应用迁移。

## 常用命令

```powershell
pnpm dev          # 并行启动 Web、API、Collector
pnpm build        # 构建所有工作区
pnpm typecheck    # TypeScript 类型检查
pnpm infra:up     # 启动 PostgreSQL、Kafka、ClickHouse
pnpm infra:down   # 停止并移除容器（保留数据卷）
```

## 当前边界

总览从 API 读取项目、请求指标、服务状态和最近错误，不在 API 出错时回退成假实时数据。其他演示页面的筛选、告警确认/关闭、设置开关仅改变本地状态。项目密钥仅保存 Hash；Span API 认证后写入项目/环境/schema 元数据。Collector 写库成功后才提交 offset，无效消息仅保留固定安全分类；当前为至少一次投递，尚无跨重投的全局去重保证，也未实现持久化 DLQ。Prompt、Response、用户原文默认不采集。

浏览器 SDK 默认无网络 sink；`sdk-test.html` 的“上报到本地平台”也默认关闭。显式开启时，浏览器将脱敏事件转换为 Span，再由同源本地 relay 严格校验并转发。`SDK_TEST_PROJECT_KEY` 只配置在 Vite 服务端进程，不使用 `VITE_*` 或浏览器存储；relay 仅允许本机同源请求、固定服务 `web-sdk-demo` 与环境 `dev`，缺少密钥时关闭转发。该验收 relay 不是生产接入网关，生产应由接入应用自己的可信 BFF 完成认证、限流和服务绑定。

请求指标排除 Web Vitals、JS 和 Promise 诊断事件，仅按请求根 Span 聚合。SDK 当前只记录失败网络请求，不采成功请求，纯浏览器项目的请求错误率不是全站流量错误率。服务表计数覆盖服务所有 Span/事件。

Compose 中的凭证仅供绑定到 localhost 的个人开发环境使用；不要复用到共享环境或生产环境。

## Phase 2 W9–W11

服务端记录器和 NestJS 根 Span 接入已实现，默认关闭。按项目已注册服务设置 `SERVER_TRACE_ENABLED`、`SERVER_TRACE_PROJECT_ID`、`SERVER_TRACE_SERVICE`、`SERVER_TRACE_ENVIRONMENT` 后重启 API；健康检查的 `tracing.state` 可确认启用状态。详细接入、关闭时的业务回退和采集边界见 `apps/api/README.md`。本轮不改变前端演示页面，也不把测试用的 RAG/LLM Span 当作真实模型适配。

显式本地验收：`pnpm build` 后设置 `$env:TRACE_OPS_RUN_INTEGRATION = '1'`，运行 `node scripts/w9-chain-acceptance.cjs`。脚本创建隔离资源，检查真实 HTTP → Kafka → Collector → ClickHouse，并清理本次数据和进程。Collector 使用构建产物，不代表 `tsx watch` 热更新问题已解决。

## Phase 2 W11–W14

已加入真实 HTTP 的 OpenAI 兼容普通/流式客户端及 Qdrant 检索/重排埋点，按需配置、默认不采集内容。模型、usage、TTFT、错误分类和检索属性复用现有 Span 管道。接入与边界见 `apps/api/README.md`；本轮仍不包含 Trace 列表/详情查询或执行树页面。

`pnpm build` 后设置 `$env:TRACE_OPS_RUN_INTEGRATION = '1'`，运行 `node scripts/w11-chain-acceptance.cjs`。本地协议服务模拟模型/Qdrant 响应，真实 Kafka、Collector 和 ClickHouse 检查 50 个 Span、并发父子关系和 Overview 统计，结束后清理本次资源。不调用付费模型，不声称真实 Qdrant 引擎召回质量已验收。证据在 `output/acceptance/w11-chain-result.json`。

## Phase 2 W13–W16

新增管理员保护的 Trace 列表及详情 API，支持项目/环境/时间/服务/状态过滤、分页、读取侧去重和安全执行树数据；详情必须携带 projectId 与具体环境。内容读取暂不开放，前端 Trace 页仍使用演示数据。接入和查询预算见 `apps/api/README.md`。

本地构建后设置 `$env:TRACE_OPS_RUN_INTEGRATION = '1'`，执行 `node scripts/w13-chain-acceptance.cjs`。脚本验证真实管道与读接口、重复投递、父子树、项目/环境隔离和安全属性投影，清理本次隔离资源；结果在 `output/acceptance/w13-chain-result.json`。

## W8 本地真实链路验收

先配置本地 `.env`、启动 Compose 并运行 `pnpm build`。以下操作会创建隔离测试项目、项目密钥和 Kafka Topic/消费组，结束时只清理本次资源。

```powershell
pnpm test:w8:relay
$env:TRACE_OPS_RUN_INTEGRATION = '1'
pnpm acceptance:w8
```

脚本启动独立 API、Collector 和 `http://127.0.0.1:5188/sdk-test.html`，占用端口时直接失败，不停止其他应用。浏览器勾选“上报到本地平台”，启动 SDK 并触发 HTTP、JS、Promise 场景，保持 Web Vitals 开启；点击“立即上报”。回到终端输入 `verify` 验证实际 ClickHouse 行、Overview、环境隔离和 30 天 TTL，再输入 `finish` 停止本次进程并清理资源。安全结果保存在 `output/playwright/w8-*-result.json`，不包含凭证。HTTP 202 只表示 API 内存排队，只有真实查询验收能确认入库。
