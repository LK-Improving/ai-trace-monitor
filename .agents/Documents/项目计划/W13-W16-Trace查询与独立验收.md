# Phase 2 W13–W16：Trace 查询与独立验收

日期：2026-10-02。开始前已按用户要求提交 W7–W14 的未提交代码、脚本、文档及安全链路结果，提交 `8f825d2`；私有 `.env`、临时浏览器截图和诊断产物不在提交中，未推送。

## 范围与分工

对照开发排期 W13–W16、需求设计 6.1/6.2，以及用户图片的统一 Trace 查询与 parentSpanId 执行树：本轮提供列表与详情 API，不修改演示前端，不提前实现 W15–W18 聚合指标。沿用 parallel-implementation-review，两名 GPT-6-Luna Max 子代理分别负责列表服务及测试、详情服务/安全投影/执行树及测试。主代理负责查询契约、Controller/Module、公共查询预算、文档、真实链路验收和 code-review-expert 独立审查。

| 接口 | 参数 | 约束 |
| --- | --- | --- |
| `GET /api/v1/traces` | projectId、environment（默认 all）、from/to、可选 traceId/service/status、page/pageSize | UTC ISO Z 时间窗最多 30 天；页大小最多 100；offset 最多 10000 |
| `GET /api/v1/traces/:traceId` | projectId、具体 environment、可选成对 from/to、includeContent=false | 未传时间默认最近 30 天；最多 2000 Span；超出明确标记 truncated |

两个接口使用现有平台管理员令牌，不允许项目写入密钥访问。需求文档的项目成员 `trace:read` 及 `trace:content:read` RBAC 尚未实现，不把平台管理员凭证交给浏览器；本轮 `includeContent=true` 始终 403。详情新增 projectId/environment 是租户隔离的必要查询上下文，不仅凭路径 Trace ID 搜索全库。

列表先按项目/环境/Trace/Span 去重，再整链聚合。服务条件匹配“整链含该服务”，不能提前过滤掉其他 Span；任一 Span 出错时整链为 error；Token 只合计模型调用，不能将根 Span 的复制用量重复计算。执行树提供扁平节点与 children ID，明确孤儿、循环和多个根，不递归展开深链。原始 error、任意属性、Prompt/Response、向量和文档正文不返回；详情仅投影有类型和长度约束的安全元数据。

公共 ClickHouse 查询设置：10 秒客户端超时，5 秒执行预算，读取 100 万行/64 MiB，结果最多 2001 行/8 MiB，内存 128 MiB；超预算抛错映射为固定安全 503，不能将截断结果伪装成功。预算同时适用于 Overview。参考 [ClickHouse argMax](https://clickhouse.com/docs/reference/functions/aggregate-functions/argMax)、[查询复杂度限制](https://clickhouse.com/docs/concepts/features/configuration/settings/query-complexity)。

## 已知边界

查询只看所选 event_time 窗口，跨窗或仍在传输中的 Trace 可能不完整；from/to 半开区间。去重是读取层去重，不是修改 MergeTree 存储，也不改变旧 Overview 的计数实现。COUNT 与分页是两次读取，持续写入时没有数据库快照一致性保证；相同数据集排序稳定，offset 分页不保证并发写入期间无漂移。最多 2000 Span 的详情摘要只基于返回集合，不作为完整大 Trace 的计费统计。

Collector 原有 tsx watch 加载问题未在本轮修复；链路验收使用构建产物。真实模型/Qdrant 账号与检索质量不在本轮测试范围，链路调用沿用本地协议服务。

## 代码审查总结

已审查本轮 21 个实现、测试、配置、文档和验收文件（不包含原有临时截图/诊断目录）。整体结论：APPROVE。使用 code-review-expert 检查参数注入、管理员鉴权、项目/环境绑定、错误及属性隐私、去重与计费口径、查询资源预算、树构建复杂度和依赖复用。

问题发现：P0 无；发现并修复的 P1 为列表时间数值映射导致 503、聚合别名冲突、列表/详情重复版本选择和 Token 统计不一致，以及树修复覆写原始父 ID；P2 修正旧 Span ID 的兼容校验和测试中排序断言。修正后复查无阻塞本轮交付的问题。没有删除既有功能或用户文件。未验证项目成员 RBAC、浏览器页面联调、生产规模查询性能及数据库迁移（本轮无迁移）；上述边界留待后续，而非宣称已验收。

列表单项最多 120 个服务标识，超过时安全 503；详情按 2000 Span 上限处理。这些是当前有限读取边界，不表示平台在生产规模上的吞吐指标。

## 验收

主代理独立验收通过；最后源码修正后已重新构建 API，运行整套测试并重复链路验收：

| 检查 | 结果 |
| --- | --- |
| 全仓 build / typecheck | 通过；最后 API build / typecheck 再次通过 |
| API | 124 项通过（含本轮 18 项新测试） |
| Web / contracts / Collector / relay | 34 / 9 / 10 / 14 项通过 |
| 合计 | 191 项测试通过，未跳过 |
| 真实 HTTP → Kafka → Collector → ClickHouse | 六次普通/流式及失败调用，30 个 Span；列表/详情实际 SQL 执行通过 |
| 查询语义 | 重复五个 Span 后仍返回五条且 Token 30；子 Span 取消使整链 error；服务筛选保留整链 |
| 隔离与分页 | 两项目和 dev/prod 同 Trace ID 不混查；environment=all 返回独立项；两页无重叠 |
| 执行树与隐私 | 孤儿/环可识别；深 2000 层、2001 行截断单测通过；原文 canary 不进入读响应 |
| 鉴权与错误 | 无令牌 401、非法参数 400、内容读取 403、缺项目/Trace 404；依赖安全 503 单测通过 |
| Overview 回归 | 共享预算下实际查询通过；重复原始行按旧口径计入，不伪称已全局去重 |
| 清理 | 本次项目、ClickHouse 行、Topic、消费组与自有进程均清理通过 |

脚本 `scripts/w13-chain-acceptance.cjs` 创建两个隔离项目，真实调用 HTTP → Kafka → Collector → ClickHouse，再请求列表/详情。结果保存在 `output/acceptance/w13-chain-result.json`。本轮无 UI 改动，不运行浏览器/Playwright 验收；HTTP 实测不能替代后续页面联调。未进行生产规模性能压测，未验证 RBAC 或原文读取权限。

W13–W16 改动保持未提交，用户本次要求的 Git 提交已在开发开始前完成；没有自动追加提交或推送。下一步为 W15–W18 聚合查询与 AI 链路指标，前端真实数据接入按后续页面排期推进。
