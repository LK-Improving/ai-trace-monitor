# AI 全链路监控平台

基于需求设计文档的 TypeScript 工作区。已实现项目/服务/密钥 API、浏览器采集基础、服务端/RAG/LLM Span、Kafka → Collector → ClickHouse、真实总览/Trace/AI 指标、告警处理，以及项目级 Webhook/Email 通知渠道和持久投递重试。通知渠道使用本机生成的服务端加密密钥；生产登录/RBAC、可编辑规则和多渠道通知增强仍未纳入 MVP。现有 `prototype/` 交互原型保留不动。

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
compose.yaml  PostgreSQL + Kafka + ClickHouse + Mailpit 本地依赖
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
- Mailpit 邮件箱：<http://127.0.0.1:8025>（仅本机访问）

启动前请配置本地 `.env` 中的 `PLATFORM_ADMIN_TOKEN`。若 PostgreSQL 使用 `POSTGRES_HOST_PORT=55432`，`DATABASE_URL` 的宿主机端口也应为 55432。若 3001 被其他应用占用，将 `API_PORT` 改为未占用的端口；Vite 代理跟随该配置。建议浏览器访问 `http://127.0.0.1:5173/`，避免其他应用占用 IPv6 localhost 地址。

要启用告警通知渠道，还需在本机 `.env` 里为 `ALERT_NOTIFICATION_ENCRYPTION_KEY` 配置独立的 32 字节 Base64 随机值（可运行 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` 生成），并保持在服务端环境、不要提交。Email 默认连本地 Mailpit SMTP；SMTP 主机、端口和发件地址可通过 `.env` 的 `SMTP_*` 配置覆盖。修改 `.env` 后重启 API。

Compose 只负责本地第三方依赖；API、Collector 和 Web 通过 `pnpm dev` 在宿主机启动。`pnpm infra:up` 会等待 PostgreSQL、Kafka、ClickHouse 的健康检查通过后返回。Mailpit 捕获本机测试邮件；SMTP `127.0.0.1:1025` 和界面 `127.0.0.1:8025` 均只绑定 loopback。容器数据保存在 Compose 命名卷中。`pnpm infra:down` 会停止并移除容器，但保留数据卷。

PostgreSQL 与 ClickHouse 初始化 SQL 只会在各自数据卷首次为空时执行。后续表结构变更应使用版本化迁移，不要依赖重建数据库来应用迁移。

## 常用命令

```powershell
pnpm dev          # 并行启动 Web、API、Collector
pnpm build        # 构建所有工作区
pnpm typecheck    # TypeScript 类型检查
pnpm infra:up     # 启动 PostgreSQL、Kafka、ClickHouse、Mailpit
pnpm infra:down   # 停止并移除容器（保留数据卷）
```

## 当前边界

总览、Trace、AI 指标、告警中心及告警通知渠道从 API 读取；渠道 Webhook 目标和 Email 地址使用 AES-256-GCM 加密后保存，SMTP 密码只在服务端进程环境中配置。告警新事件与匹配通知任务在同一 PostgreSQL 事务内落库，由 API worker 异步投递，Collector 不连接外部目标；投递提供有限自动退避与失败后人工重试。外部投递为至少一次语义，接收方可使用稳定投递 ID 去重。Webhook 默认只允许 HTTPS 且拒绝解析到私有/保留地址的目标；仅隔离本地验收可临时启用私有目标。生产登录/RBAC、可编辑规则与上线容量目标仍待后续 Phase 3 工作。项目密钥仅保存 Hash；Prompt、Response、用户原文默认不采集。

浏览器 SDK 默认无网络 sink；`sdk-test.html` 的“上报到本地平台”也默认关闭。显式开启时，浏览器将脱敏事件转换为 Span，再由同源本地 relay 严格校验并转发。`SDK_TEST_PROJECT_KEY` 只配置在 Vite 服务端进程，不使用 `VITE_*` 或浏览器存储；relay 仅允许本机同源请求、固定服务 `web-sdk-demo` 与环境 `dev`，缺少密钥时关闭转发。该验收 relay 不是生产接入网关，生产应由接入应用自己的可信 BFF 完成认证、限流和服务绑定。

请求指标排除 Web Vitals、JS 和 Promise 诊断事件，仅按请求根 Span 聚合。SDK 当前只记录失败网络请求，不采成功请求，纯浏览器项目的请求错误率不是全站流量错误率。服务表计数覆盖服务所有 Span/事件。

Compose 中的凭证仅供绑定到 localhost 的个人开发环境使用；不要复用到共享环境或生产环境。

## Phase 2 W9–W11

下列 W9–W18 小节为对应开发时点的记录；当前页面状态以本页开头和 W18–W20 小节为准。

服务端记录器和 NestJS 根 Span 接入已实现，默认关闭。按项目已注册服务设置 `SERVER_TRACE_ENABLED`、`SERVER_TRACE_PROJECT_ID`、`SERVER_TRACE_SERVICE`、`SERVER_TRACE_ENVIRONMENT` 后重启 API；健康检查的 `tracing.state` 可确认启用状态。详细接入、关闭时的业务回退和采集边界见 `apps/api/README.md`。本轮不改变前端演示页面，也不把测试用的 RAG/LLM Span 当作真实模型适配。

显式本地验收：`pnpm build` 后设置 `$env:TRACE_OPS_RUN_INTEGRATION = '1'`，运行 `node scripts/w9-chain-acceptance.cjs`。脚本创建隔离资源，检查真实 HTTP → Kafka → Collector → ClickHouse，并清理本次数据和进程。Collector 使用构建产物；2026-10-02 的独立复验已确认 Node v24.0.0 / tsx 4.23.15 下 `tsx watch src/main.ts` 成功订阅 Kafka，历史 Node20 失败记录保留，不据此声明整套 `pnpm dev` 已通过。

## Phase 2 W11–W14

已加入真实 HTTP 的 OpenAI 兼容普通/流式客户端及 Qdrant 检索/重排埋点，按需配置、默认不采集内容。模型、usage、TTFT、错误分类和检索属性复用现有 Span 管道。接入与边界见 `apps/api/README.md`；本轮仍不包含 Trace 列表/详情查询或执行树页面。

`pnpm build` 后设置 `$env:TRACE_OPS_RUN_INTEGRATION = '1'`，运行 `node scripts/w11-chain-acceptance.cjs`。本地协议服务模拟模型/Qdrant 响应，真实 Kafka、Collector 和 ClickHouse 检查 50 个 Span、并发父子关系和 Overview 统计，结束后清理本次资源。不调用付费模型，不声称真实 Qdrant 引擎召回质量已验收。证据在 `output/acceptance/w11-chain-result.json`。

## Phase 2 W13–W16

新增管理员保护的 Trace 列表及详情 API，支持项目/环境/时间/服务/状态过滤、分页、读取侧去重和安全执行树数据；详情必须携带 projectId 与具体环境。内容读取暂不开放，前端 Trace 页仍使用演示数据。接入和查询预算见 `apps/api/README.md`。

本地构建后设置 `$env:TRACE_OPS_RUN_INTEGRATION = '1'`，执行 `node scripts/w13-chain-acceptance.cjs`。脚本验证真实管道与读接口、重复投递、父子树、项目/环境隔离和安全属性投影，清理本次隔离资源；结果在 `output/acceptance/w13-chain-result.json`。

## Phase 2 W15–W18

新增管理员保护的 `/api/v1/metrics/overview`、`/api/v1/metrics/ai`：去重后的请求/失败量、P50/P95/P99、Token、按模型的延迟/TTFT，以及 RAG 成功/空召回和召回/重排耗时。支持项目、环境、服务、常用范围及明确 UTC 窗口；敏感内容仍默认屏蔽。前端真实 Trace/AI 页面切换在 W18–W20，本轮不修改 mock 页面；旧 `/overview` 暂留兼容。

本地构建后设置 `$env:TRACE_OPS_RUN_INTEGRATION = '1'`，运行 `node scripts/w15-metrics-acceptance.cjs`。真实管道验证聚合语义，隔离的 10,000 请求 / 51,000 存储行基线测量 1h/24h/7d HTTP 查询 P95，清理本次资源；证据在 `output/acceptance/w15-metrics-result.json`。指标口径和有限读取边界见 `apps/api/README.md`。

## Phase 2 W18–W20

总览、最新 Trace、Trace 检索/详情执行树、模型用量和 RAG 指标已接真实接口。全局项目、环境和时间范围切换会取消旧请求；空数据、加载和失败重试明确显示，不回退成演示数据。详情提示查询窗口、孤儿/环、多根及 2,000 Span 截断；未观测到的 usage/TTFT 显示“—”。保持原有浅暖白页面样式。

本地 Web 通过 Vite 服务端读取 `PLATFORM_ADMIN_TOKEN`，仅转发严格白名单中的同源、loopback 管理查询、项目创建/配置和告警通知操作；不要放入 `VITE_*`、URL 或浏览器存储。修改 `.env` 后重启 Web。该代理不用于 preview/生产，也不替代正式登录和项目成员 RBAC。控制台可创建项目并引导服务注册、写入凭证和首条 Trace 接入；告警列表与统计按最近发生时间匹配顶部 1h/24h/7d 范围，窗口为左闭右开，切换范围或手动刷新时重新计算。告警通知及投递历史已接真实 API；其余演示设置、价格、评估与生产权限仍需后续实现。

本地端到端验收先运行 `pnpm build`，启动 Compose，然后设置 `$env:TRACE_OPS_RUN_INTEGRATION='1'` 并运行 `node scripts/w18-page-acceptance-session.cjs`（保持终端开启）。脚本输出随机 `webUrl`；另一个终端使用 Playwright CLI 打开该 URL，再运行 `scripts/w18-browser-acceptance.js`。将 CLI 返回的 Result JSON 保存为 `output/acceptance/w18-browser-result.json`，回到验收终端输入 `verify`，继续回查入库结果并自动清理。未完成时输入 `finish`，报告失败并清理；30 分钟超时也会清理。请串行运行，不同时启动多个 W18 验收会话。

可继续运行 `scripts/w18-browser-state-acceptance.js` 检查总览、Trace 列表和详情的空态/失败重试，并将它返回的 checks 合并到相同 run 的浏览器报告。CLI 命令形式为 `npx --yes --package @playwright/cli playwright-cli -s=w18-review open <webUrl>` 和 `npx --yes --package @playwright/cli playwright-cli -s=w18-review run-code --filename <脚本路径>`。

浏览器成功读取均来自真实 API；只在加载/错误/竞态测试时注入网络故障。独立本地协议服务替代付费模型/Qdrant 响应，Kafka、已构建 Collector、ClickHouse 为真实实例。结果在 `output/acceptance/w18-page-result.json`，详细检查与限制见 `.agents/Documents/项目计划/W18-W20-页面真实链路与独立验收.md`。

G2 验收分清两条边界：已经验证浏览器生成的 Trace ID 与服务端/RAG/LLM 树关联；尚未验证 Web 性能/异常事件与服务端的完整联合执行树或跨服务 parent 上下文，该项属于 Phase 3/G3。控制台接入文档提供原生 HTTP 上报示例，不要求安装尚未发布的 SDK；密钥只由可信服务端持有。项目创建与服务注册可由本地控制台通过管理 API 完成，创建的项目写入凭证仅在创建响应时显示一次。

## W8 本地真实链路验收

先配置本地 `.env`、启动 Compose 并运行 `pnpm build`。以下操作会创建隔离测试项目、项目密钥和 Kafka Topic/消费组，结束时只清理本次资源。

```powershell
pnpm test:w8:relay
$env:TRACE_OPS_RUN_INTEGRATION = '1'
pnpm acceptance:w8
```

脚本启动独立 API、Collector 和 `http://127.0.0.1:5188/sdk-test.html`，占用端口时直接失败，不停止其他应用。浏览器勾选“上报到本地平台”，启动 SDK 并触发 HTTP、JS、Promise 场景，保持 Web Vitals 开启；点击“立即上报”。回到终端输入 `verify` 验证实际 ClickHouse 行、Overview、环境隔离和 30 天 TTL，再输入 `finish` 停止本次进程并清理资源。安全结果保存在 `output/playwright/w8-*-result.json`，不包含凭证。HTTP 202 只表示 API 内存排队，只有真实查询验收能确认入库。
