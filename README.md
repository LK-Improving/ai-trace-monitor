# AI 全链路监控平台

基于需求设计文档 MVP 范围初始化的 TypeScript 工作区。控制台已用独立 mock 数据搭建总览、Trace 检索与执行树、AI 链路（模型 / RAG / Agent）、告警中心、项目与隐私设置、接入文档等页面；同时包含 NestJS API 健康检查、共享 Trace/Span 契约、Kafka → Collector → ClickHouse 消费骨架，以及 PostgreSQL 配置库初始化结构。现有 `prototype/` 交互原型保留不动。

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

控制台当前为交互式 mock：筛选、告警确认/关闭、设置开关和代码示例切换仅改变本地演示状态，不会请求后端或持久化。除 API 与 PostgreSQL 连通检查、Collector 消费/批量写入骨架外，项目管理、凭证鉴权、SDK 上报、Trace/指标查询、告警规则和通知尚未实现。Collector 期望 Kafka 消息为带 `projectId`、`environment`、`schemaVersion: 1` 的单条 Span 事件；正式接入前需先完成带项目密钥校验的 API 上报端点。当前无效 Span 会跳过并写进程日志，持久化 DLQ 与 Collector 自监控指标尚未实现。Prompt、Response、用户输入等敏感属性在进入 ClickHouse 前会从 Span attributes 中剔除，原文采集默认关闭。

Compose 中的凭证仅供绑定到 localhost 的个人开发环境使用；不要复用到共享环境或生产环境。
