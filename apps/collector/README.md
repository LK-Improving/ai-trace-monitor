# Collector

Collector 从 Kafka 的 Span topic 批量消费消息，校验统一 Span 契约，将有效 Span 转为 ClickHouse 行并批量写入。它是独立进程；API 的请求路径不等待 Collector 或 ClickHouse。

## 本地运行

先在仓库根目录启动依赖服务并构建 contracts，再构建和启动 Collector：

```bash
pnpm infra:up
pnpm --filter @trace-ops/contracts build
pnpm --filter @trace-ops/collector build
pnpm --filter @trace-ops/collector start
```

默认配置适用于本机启动 Collector、Kafka 与 ClickHouse 均由仓库的 Compose 服务提供。可通过环境变量调整：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker 地址，多个地址以逗号分隔 |
| `KAFKA_TOPIC` | `ai-spans` | 输入 topic |
| `KAFKA_GROUP_ID` | `trace-ops-collector` | Consumer group |
| `COLLECTOR_OPS_HEALTH_PORT` | `3011` | 仅绑定 `127.0.0.1` 的健康端口；隔离集成测试可指定临时端口 |
| `CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_USER` | `trace_ops` | ClickHouse 用户 |
| `CLICKHOUSE_PASSWORD` | `trace_ops_dev_only` | 本地开发默认密码；不要在生产环境复用 |
| `CLICKHOUSE_DATABASE` | `observability` | ClickHouse 数据库 |
| `CLICKHOUSE_TABLE` | `trace_spans` | Span 表名 |

构建并运行 Collector 测试：

```bash
pnpm --filter @trace-ops/contracts build
pnpm --filter @trace-ops/collector build
pnpm --filter @trace-ops/collector exec node --test
```

## 投递与 offset 语义

Collector 采用 at-least-once 消费语义：只有 ClickHouse 批量写入成功后才提交对应 Kafka offset。写入失败时批次不应被确认，Kafka 可在重试或进程恢复后重新投递；如果 ClickHouse 已完成写入、但 offset 提交未成功，重投可能产生重复行。因此不要把当前链路描述为 exactly-once；下游查询需要考虑重复投递。

无法解析或不符合 Span schema 的消息会被归类为固定原因码 `empty_payload`、`invalid_json` 或 `invalid_schema`，不记录原始消息、校验异常正文或敏感属性。无效消息按丢弃策略处理：仅将原因码和 offset 交给安全诊断回调/指标，不写入 ClickHouse；在该批次有效数据已持久化（或整批均无有效数据）后推进 offset，避免 poison message 让分区持续阻塞。有效行若写入失败则不推进 offset，因此同批次内的有效消息不会因为先遇到无效消息而被跳过。

## 核查 30 天 TTL

表的保留期由 [`infra/clickhouse/init/001-trace-spans.sql`](../../infra/clickhouse/init/001-trace-spans.sql) 中 `TTL event_time + INTERVAL 30 DAY` 定义。初始化 SQL 只会在 ClickHouse 初始化数据目录时自动执行；已有数据卷不会因为修改初始化文件而自动重建表。

先检查当前运行实例的实际表定义，而不只看仓库里的 SQL：

```sql
SHOW CREATE TABLE observability.trace_spans;
```

确认输出包含 `TTL event_time + toIntervalDay(30)` 或等价的 30 天 TTL 表达式。再检查当前仍存在的过期行：

```sql
SELECT countIf(event_time < now() - INTERVAL 30 DAY) AS expired_rows
FROM observability.trace_spans;
```

ClickHouse TTL 删除由后台 merge 执行，并非到期瞬间同步删除；`expired_rows` 暂时非零可能表示相关 part 尚未完成 TTL merge。若要验证物理清理行为，请在隔离的本地/测试表中插入一条早于 30 天的合成记录，触发该测试表的 TTL merge（测试环境可执行 `OPTIMIZE TABLE <test_table> FINAL`），然后重复查询并确认过期记录数归零。`OPTIMIZE ... FINAL` 可能触发大规模合并，不要在生产大表上为验收而直接执行。

目前此文档描述核查步骤；实际 Kafka 到 ClickHouse 集成、失败重投和 TTL 清理结果应以对应环境中的运行记录为准，不因存在本地测试或 TTL DDL 就视为已通过验收。

## W6 子任务 B：真实 Kafka → Collector → ClickHouse 集成验收

验收脚本位于 `tests/kafka-clickhouse.integration.test.mjs`，默认跳过，不会连接服务或创建资源。它只允许连接 loopback 地址（`localhost` / `127.0.0.0/8` / `::1`），不会启动、停止或重建 Docker Compose 服务，也不会删除任何 volume。

运行前置条件：

- 本机 Kafka 与 ClickHouse 已运行且可访问；默认地址为 `localhost:9092` 和 `http://localhost:8123`。
- 使用的 ClickHouse 数据库已存在，当前用户有权在其中创建、查询和删除临时表；默认用户配置沿用 Collector 本地开发默认值，也可通过 `CLICKHOUSE_USER`、`CLICKHOUSE_PASSWORD` 等环境变量覆盖。
- contracts 与 Collector 已构建。脚本直接启动 `apps/collector/dist/main.js`，不会代替用户启动基础设施。
- 本地 Node.js 与 pnpm 已安装。

显式开启后，脚本会使用本次运行专属的随机 Kafka topic、consumer group、ClickHouse 表和合成 Span。先在目标表不存在时投递同分区的多条有效 Span，等待 Collector 明确记录可重试的 ClickHouse 写入失败，并确认该分区的已提交 offset 未推进；随后创建目标表，验证多条 Span 最终入库且 offset 推进；最后投递含合成 canary 的 poison message，验证只出现固定 `invalid_json` 分类、没有原始 payload，且 offset 可继续推进。整个 Collector stdout/stderr 都会扫描 canary；断言失败时不会回显日志或 canary 内容。

脚本有总测试超时、Kafka 请求超时、ClickHouse 请求超时和各阶段等待期限。无论成功或失败，`finally` 都会停止本次启动的 Collector，并仅删除本次随机命名且经预检查确认未存在的 topic、consumer group 和临时表；它不会执行 `docker compose down`、删除数据库、触碰正式 `trace_spans` 表或操作 Compose volume。验收需要访问本机 Kafka/ClickHouse 并创建、删除临时对象，请只在本地或专用测试环境显式运行：

```powershell
pnpm --filter @trace-ops/contracts build
pnpm --filter @trace-ops/collector build
$env:TRACE_OPS_RUN_INTEGRATION = '1'
pnpm --filter @trace-ops/collector test:integration
Remove-Item Env:TRACE_OPS_RUN_INTEGRATION
```

未设置 `TRACE_OPS_RUN_INTEGRATION=1` 时，即使通过该脚本入口运行也只会报告 skipped。可按 Collector 本地运行表配置 `KAFKA_BROKERS`、`CLICKHOUSE_URL`、`CLICKHOUSE_DATABASE`、`CLICKHOUSE_USER` 和 `CLICKHOUSE_PASSWORD`；远程地址会被脚本拒绝。

## W5 本地验收记录

验证日期：2026-09-25。验证环境为仓库 Compose 中的 Kafka 与 ClickHouse；测试使用合成 Span、独立 topic、独立 consumer group 和临时 ClickHouse 表，结束后已清理这些测试资源。

- 自动检查：`pnpm build`、`pnpm typecheck` 通过；Collector 批次处理测试 6/6 通过。
- 真实投递与失败恢复：先将 Collector 指向尚不存在的临时表，ClickHouse 写入失败后没有提交 offset；创建表并等待 KafkaJS 重启后，同一条消息成功入库。查询到 1 行，consumer group 的 `CURRENT-OFFSET=1`、`LOG-END-OFFSET=1`、`LAG=0`。
- 隐私：入库的 `attributes` 只包含非敏感模型字段；prompt canary 未落库，`Span.error` 为空。再次模拟写入失败时，ClickHouse 客户端原始错误日志已关闭，Kafka 日志只包含固定错误消息与调用栈，不含 payload 或底层错误 cause。
- TTL：运行中正式表的 `SHOW CREATE TABLE` 显示 30 天 TTL。隔离测试表先核对 2 条合成过期记录，应用相同的 30 天 TTL 并执行 `OPTIMIZE ... FINAL` 后记录数为 0；该表随后已删除。
- Kafka Compose 健康检查原 5 秒超时低于本机管理命令启动耗时，造成错误的 `unhealthy` 状态。将超时调至 30 秒并仅重建 Kafka 容器（保留数据卷）后，`docker compose up --wait` 返回 `Healthy`。

## W6 本地验收记录

验证日期：2026-09-26。验证环境为仓库 Compose 中健康的 Kafka 与 ClickHouse；真实集成测试使用随机命名的临时 topic、consumer group 和 ClickHouse 表，验收后已全部清理。

- 自动检查：`pnpm build`、`pnpm typecheck` 通过；Collector 单测 10/10 通过；集成测试默认跳过，需显式设置 `TRACE_OPS_RUN_INTEGRATION=1`。
- 故障恢复：目标表不存在时，Collector 将 ClickHouse 写入失败转成不含原始错误/cause 的 Kafka 可重试错误，offset 未推进；创建表后，同批 3 条 Span 全部入库且 offset 到 3。
- poison message：随后投递含 canary 的非法 JSON，日志只记录 `invalid_json` 计数，没有输出原文；offset 从 3 推进到 4，分区继续消费。
- 隐私与清理：入库行的 `error` 为空、`attributes` 不含 canary；验收脚本扫描 Collector stdout/stderr。最终未发现 `trace-ops-w6b-*` topic/group 或 `trace_spans_w6b_*` 表残留；Compose 服务及数据卷保持运行。
- 投递语义仍为 at-least-once：如果 ClickHouse 实际持久化成功但客户端未收到成功响应，Kafka 重放仍可能产生重复行；本周没有引入去重机制。
