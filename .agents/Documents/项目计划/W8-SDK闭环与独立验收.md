# W8 SDK 闭环与独立验收

日期：2026-09-30。对照原始架构图片与开发排期 Phase 1 W7–W8。

## 结论

本地 G1 基础采集闭环通过：浏览器 SDK → 同源本地 relay → Span API → Kafka → 已构建 Collector → ClickHouse → Overview 页面。

W8 功能与真实链路已交付，但不代表完整 MVP 或开发启动模式全部验收。Collector 源码/热更新启动问题仍待解决，见剩余限制。

## 分工及范围

- 前端：GPT-6-Luna Max 子代理负责事件转换、有界 transport、SDK 验收页、递归保护、测试及说明。
- 后端：GPT-6-Luna Max 子代理负责本机同源 relay、安全校验及测试。
- 主代理：维护跨端契约、Vite 集成、请求统计口径、隔离验收工具；独立读代码、复跑测试、浏览器实测、修复审查发现并验证清理。
- 保留 W7 未提交改动与用户本地 `.env`。未提交或推送 Git。

本轮不提前开发 Phase 2/3 的 Trace 执行树、RAG/LLM 集成、Token 价格、Prompt 管理和告警规则。Qdrant 与模型仍属于接入应用，不增加平台第三方容器。

## 交付

- 默认不上报；只有用户显式开启后才创建 Browser Span transport。
- 固定验收服务 `web-sdk-demo`、环境 `dev`，支持 Web Vitals、JS、Promise、网络失败四类 Span。
- 队列最多 100 条，单批最多 20 条，超时 3 秒；失败不重试，不递归捕获上报失败，停止时取消请求与清理队列。
- 浏览器不持有项目密钥或管理员令牌，不带 Authorization/Cookie；原文 message、metricId、请求响应 body 等不进入上报 Span。
- relay 只允许 loopback、正确 Host 与同源 Origin；固定本机 API 目标、不跟随重定向；64 KiB 请求上限、并发/速率上限与严格字段白名单。密钥缺失时失败关闭。
- HTTP 202 只表示 API 内存队列接收，不表示持久化。
- 请求 KPI 排除 Web Vitals / JS / Promise；服务表仍统计全部 Span，表头明确为“Span / 事件数”和“异常占比”。当前只采失败网络请求，因此纯 SDK 项目的错误率不是全站流量错误率。
- `pnpm acceptance:w8` 创建临时项目、密钥、Topic、消费组及独立进程，支持 `verify` / `finish`。只删除本次隔离资源。

## 独立审查结果

审查覆盖前后端完整契约、采集默认值、字段隐私、来源/凭证边界、超时/队列/停止、查询计数、前端渲染与隔离资源清理。W7 的既有改动保持原样并复核相关联逻辑。

发现并已修复：

1. **高优先级**：后端初稿接收原始事件，而前端发送 TraceSpan。改为严格 TraceSpan，保留 ID/时间；新增直接使用前端转换器实际输出的跨端测试。
2. **中优先级**：Web Vitals delta 的前后端边界不同。允许有限负 delta，统一数值、时间戳、行列范围。
3. **中优先级**：真实浏览器 checkbox 点击被装饰层遮挡。修复装饰层 pointer-events，未使用强制点击绕过。
4. **中优先级**：浏览器诊断事件混入请求 KPI。分离请求口径，服务表标明事件计数。
5. 本机 Vite 监听与只读管理员令牌代理限制为 loopback；纠正文档路径与本机访问地址。

修复后，上述 W8 新增功能未发现未解决的阻断性问题。独立运行以下检查，而非仅依据子代理报告。

## 验收证据

| 检查 | 实际结果 |
| --- | --- |
| 全仓 `pnpm build` / `pnpm typecheck` | 通过；最终前端小修后再次构建通过 |
| API 单元测试 | 37 项通过 |
| contracts 测试 | 9 项通过 |
| Collector 批处理与写入测试 | 10 项通过 |
| Web trace / transport / Overview 测试 | 34 项通过 |
| relay 与跨端契约测试 | 14 项通过 |
| Playwright 无 Mock 实测 | 默认不上报、四类事件上报、Trace Header、停止、总览与环境/时间切换通过 |
| ClickHouse 与 Overview 实查 | 最终隔离回归四类 operation；6 条 Span，1 条网络失败请求，错误率 100%，Token 0 |
| 隐私、环境隔离、TTL | 固定原文 canary 未入库，prod 不含 dev 请求；实际表定义 TTL 30 天 |
| 清理 | 临时项目/服务/密钥、项目 Span、Topic/消费组、本次子进程清理通过；未删除共享数据或卷 |

最终完整浏览器流程一次成功上报 6 条事件，包含实际 Web Vitals observer 的指标与三类错误。SDK 自动转换并发送，未手动向 ingest 注入验收 Span。之前的多次浏览器尝试使用其他隔离项目，已全部清理。

Playwright CLI 会话反复断开，未把中断视作通过。主代理使用已安装 Playwright 与系统 Chrome 的 headless 模式直接完成同一场景，没有新增 `@playwright/test` 依赖。

证据：`output/playwright/w8-browser-result.json`、`w8-integration-result.json`、`w8-cleanup-result.json`、`w8-sdk.png`、`w8-real-overview.png`。截图与结果来自最终隔离回归。

## 剩余限制

- Node v20.0.0 环境下，Collector 源码启动探测未完成订阅；`tsx watch` 仍未验收通过。已构建 `dist/main.js` 的订阅和实际写入通过。没有据此修改 Collector 消费逻辑，也不宣称根 `pnpm dev` 全服务通过。
- 本机 relay 是显式开启的验收接入，不是生产网关；生产接入方的可信 BFF、用户权限、认证部署仍需后续设计。
- 既有至少一次投递可能重复，尚无跨重投全局去重/DLQ。30 天 TTL 本轮验证表定义，未等待 30 天验证物理删除。
- “最新 Traces”、AI 链路和告警页仍标注演示数据；本轮真实区域是 KPI、趋势、服务与最近错误。
