# Phase 1 完整链路复验报告

日期：2026-09-30。任务是检查与验收，不是功能开发；本轮未修改业务代码、用户 `.env`，未提交 Git，仅新增验收脚本与本报告。

## 结论

**核心 G1 数据闭环通过；开发模式启动验收仍有一项未通过。**

真实链路为浏览器 SDK → 同源本地 relay → Span ingest API → Kafka → 已构建 Collector → ClickHouse → Overview API → 页面。并未据此宣称完整 AI Trace、生产接入网关或全部 `pnpm dev` 服务通过。

对照原始架构图片及排期 Phase 1 W1–W8，检查了项目/服务/密钥、Trace Header、浏览器诊断采集、异步上报、有界降级、消费写入与提交顺序、基础总览、隐私、环境隔离和 30 天 TTL 表定义。

## 检查结果

| 检查项 | 实际结果 |
| --- | --- |
| Compose | PostgreSQL、Kafka、ClickHouse 健康；`kafka-topic-init` 正常退出，exit code 0 |
| 工程检查 | 全仓 `pnpm build` 与 `pnpm typecheck` 通过 |
| 单元回归 | API 37、contracts 9、Collector 10、Web 34、relay 14，共 104 项通过 |
| 浏览器无 Mock E2E | 默认关闭上报；显式开启后真实 HTTP 503、JS、Promise 事件与 Web Vitals 自动转换/上报；Trace Header、隐私与停止通过 |
| 实际入库及查询 | 四类 Browser operation 共 6 条 Span；请求数 1、错误数 1、错误率 100%、P95 9ms、Token 0；诊断事件未计入请求 KPI |
| 页面 | 项目选择、dev/prod 切换、1h/24h/7d 筛选、无数据状态通过；其他页面明确标注演示数据 |
| 页面网络中断 | Playwright 设置离线后显示 API 错误，不回退假指标；恢复网络后“重试”成功；无 pageerror |
| 窄屏 | 390px 视口截图检查，无页面横向溢出；这不是完整跨设备兼容测试 |
| 真实 API 检查 | 14 项通过：管理员鉴权、错误令牌、非法/不存在项目、非法 ingest、无效/撤销密钥、未注册服务/环境与无效 Trace Header |
| Kafka 不可达 | 独立 API 指向未监听的本机端口；1 条合法 Span 在 17ms 内获得 HTTP 202，不等待 Kafka；后续发布失败可观测、队列归零；published=0 |
| 队列容量 | 测试设置容量 1，2 条 Span 的整批请求返回 503；拒绝计数准确；总 dropped=3（容量拒绝 2 + 发布失败 1） |
| ClickHouse 故障恢复 | 使用隔离 Topic/消费组/表；表缺失导致写入失败时 offset 未提前提交；创建该临时表后 3 条合法 Span 全部写入、offset 到 3；无效 JSON 被安全分类并提交到 4，原文 canary 未进入日志/存储 |
| TTL | 实际 `trace_spans` 表定义为 30 天 TTL；未等待 30 天验证物理删除 |
| 开发模式 Collector | **失败**：`tsx watch src/main.ts`，Node v20.0.0 / tsx 4.23.15，等待约 30 秒未产生订阅日志或其他输出；进程能启动但未证明消费就绪 |

本轮不停止现有 Kafka/ClickHouse，也不删除共享 `ai-spans`、数据库或 Docker volume。故障演练使用不可达测试端口或本次临时表，不影响其他应用。

## 未通过项与范围边界

1. **开发启动未通过**：Collector 热更新入口没有在 30 秒内完成订阅，而相同基础服务上的构建版能完成真实写入。现有证据仅能定位到启动方式的差异，不能断言根因是凭证、Kafka 容器、Node 版本或 tsx 本身。建议作为 Phase 1 遗留项修复并复验，不能把“构建通过”替代“开发启动通过”。
2. 生产 BFF/用户权限、完整 Trace 树、RAG/LLM 埋点与告警中心在后续阶段，本次没有拿演示页面当真实功能验收。
3. 当前 API 队列是进程内 best-effort；HTTP 202 不保证持久化，进程退出或持续 Kafka 故障可能丢弃并计数。Collector 至少一次投递仍存在重复可能，未验证全局去重/DLQ。
4. 当前浏览器只记录失败网络请求；纯 SDK 项目的错误率不代表全站成功/失败流量比。服务表的 Span/事件数量与请求 KPI 有不同统计口径。

## 复验方法与证据

使用本机已安装的 Playwright 与系统 Chrome headless，无接口 response Mock；复用 W8 隔离会话和浏览器脚本。首次 shell 转发 Collector 集成测试失败于命令解析，未视作测试失败；改为 Node 私下加载 `.env` 再启动测试后，实际集成测试通过。

Kafka 故障脚本首次断言遗漏容量拒绝的 dropped 计数，经检查原有队列逻辑修正测试预期后再次通过；未修改业务队列实现。

脚本：

- `scripts/w8-acceptance-session.cjs`、`scripts/w8-browser-acceptance.cjs`：真实闭环和页面。
- `scripts/phase1-api-check.cjs`：真实 API 鉴权/输入检查。
- `scripts/phase1-browser-check.cjs`：离线、重试、7d、演示标识和窄屏检查。
- `scripts/phase1-kafka-outage-check.cjs`：Kafka 不可达及队列容量检查。
- `scripts/phase1-collector-dev-check.cjs`：隔离的开发入口诊断。
- `apps/collector/tests/kafka-clickhouse.integration.test.mjs`：实际写入失败、恢复和无效消息测试。

证据文件位于 `output/playwright/`：

- `w8-browser-result.json`、`w8-integration-result.json`、`w8-cleanup-result.json`。
- `phase1-api-result.json`、`phase1-ui-result.json`、`phase1-outage-result.json`、`phase1-dev-result.json`。
- `w8-sdk.png`、`w8-real-overview.png`、`phase1-offline.png`、`phase1-narrow.png`。

## 清理

真实闭环会话的临时项目、服务、密钥、该项目 ClickHouse Span、独立 Topic/消费组及进程清理检查通过。API 负向检查的密钥已撤销，并随临时项目删除。Kafka 不可达测试的独立 API、项目与关联配置已清理；没有向实际 Kafka 写入。开发入口诊断的本次进程树、Topic/消费组已清理。Collector 故障恢复测试执行并通过自身清理步骤。

凭证只在服务器进程环境或测试进程内存使用，不写入浏览器、截图或结果 JSON。
