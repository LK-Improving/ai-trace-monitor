# Phase 2 W11–W14：模型与 RAG 适配及独立验收

日期：2026-10-02。范围对照排期 W11–W14 及用户架构图的服务端 TraceRecorder、LLM 追踪、RAG 追踪章节。没有提前实现 Trace 查询 API、执行树页面、Prompt 管理、评估集或模型价格表。

## 分工与交付

沿用 parallel-implementation-review：两个 GPT-6-Luna Max 子代理分别实现 OpenAI 兼容客户端及测试、Qdrant 检索/重排客户端及测试。此轮没有前端功能变动，不安排前端子代理。主代理负责共享埋点工具、NestJS 配置与导出、隔离验收脚本、文档、独立审查和回归测试。

| 图片要求 | 本轮实现 | 边界 |
| --- | --- | --- |
| `http.server → rag.retrieve / llm.generate` | 继承现有 ALS 和根 Span；RAG 下再细分 recall/rerank | 不新增公开模型代理接口 |
| 模型、Token、总延迟、TTFT | 普通 JSON 与 SSE 调用；模型落入现有 ClickHouse model 列 | 非流式不伪造 TTFT；usage 缺失仍未知 |
| 限流、超时、过滤等错误分类 | 固定安全码，不保留提供方原文或 cause | 协议失败与网络失败独立；不自动重试付费调用 |
| topK、召回数、sources、重排顺序/得分 | Query Points 请求及回调重排，来源哈希、前后排名快照 | 快照各最多 20 条，保留总数/截断标记；不实现向量化模型 |
| 敏感内容默认不记录 | 内容仅返回业务；监控只写安全元数据 | 本轮不开放内容采集开关；ID 哈希不等于加密匿名化 |
| 监控不阻塞业务、关闭后可运行 | 复用异步有界队列；缺失上下文仍调用提供方 | 适配器不改变既有队列的尽力交付语义 |

新模块位于 `apps/api/src/observability/`：`ai-observation.ts`、`ai-adapters.service.ts`、`openai-compatible.client.ts`、`rag.client.ts`。只修改 `.env.example`，不修改私有 `.env`。配置和使用方式见 `apps/api/README.md`。

协议来源：[OpenAI Chat](https://developers.openai.com/api/reference/resources/chat)、[Qdrant Query Points](https://api.qdrant.tech/api-reference/search/query-points)。端点必须可信服务端配置，HTTPS 或本机 loopback HTTP，不跟随重定向。JSON 最多 1 MiB，SSE 总计最多 8 MiB、单帧最多 64 KiB，总超时覆盖读取与重排。

## 主代理审查

使用 code-review-expert 的安全、可靠性和质量检查表审查本轮文件，而非仅复述子代理测试结果。已要求修正：模型属性兼容现有 ClickHouse 映射；RAG topK/sources 命名一致；输入输出 Token 总数一致性；流式消费者暂停后仍检查超时且首个取消原因不被覆盖；排名快照限制以免挤掉必需属性；构造器与配置服务超时校验一致。主代理还补上空 payload 的处理，以及拒绝负数、非整数、超过 JavaScript 安全整数的数值文档 ID，防止 ID 精度丢失；超大 uint64 ID 暂不支持，应使用 UUID。

## 验收记录

主代理验收通过，修正后再次运行 API 全套测试与链路脚本：

| 检查 | 结果 |
| --- | --- |
| 全工作区 build / typecheck | 通过；最后修正后 API build / typecheck 再次通过 |
| API 单元与本地 HTTP 测试 | 106/106 通过 |
| Web 回归 | 34/34 通过，未修改本轮前端 |
| contracts / Collector / relay 回归 | 9 / 10 / 14 项通过 |
| 合计 | 173 项测试通过，无跳过 |
| 真实消息/存储链路 | 10 次请求、50 个 Span、10 次检索及 10 次模型协议 HTTP 调用 |
| Overview 统计 | 请求 10、错误 2、Token 180；根 Span 未重复计费 |
| 并发、流式与失败场景 | 六个并发普通/流式请求；usage 缺失、限流、超时和取消通过 |
| 安全 | 内容 canary 不进入存储/子进程日志，凭证日志检查通过 |
| 清理 | 独立项目、ClickHouse 行、Topic、消费组和自有进程清理通过 |

复查未发现阻塞本轮交付的未解决问题。既有工作树改动均保留；未 Git 提交或推送。未进行浏览器实测：本轮无 UI 修改，验证重点是提供方协议与后端管道。

验收脚本 `scripts/w11-chain-acceptance.cjs` 使用本地 OpenAI/Qdrant 协议服务，真实 PostgreSQL、Kafka、Collector 和 ClickHouse；不调用远程收费模型，也不代表真实 Qdrant 引擎及检索质量已经验证。

脚本创建独立 UUID 项目、Topic 和消费组，运行六个并发普通/流式调用及 usage 缺失、限流、超时、提前取消场景；检查模型、Token、TTFT、来源哈希、父子关系、Overview 计数及内容/凭证不进入日志和存储。结束时只清理本次资源与进程，结果在 `output/acceptance/w11-chain-result.json`。

已知边界：Collector 的旧 `tsx watch` 开发加载问题仍未修改；本轮使用已构建 Collector。重排回调超时可结束等待，但无法强制停止不协作的回调副作用。消费方必须关闭流式迭代器。没有真实提供方账号/引擎验收，不声称完整外部集成已验证。

下一步按 W13–W16 实现 Trace 列表/详情查询，再联调执行树页面。本轮不执行 Git 提交或推送。
