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

## W5 本地验收记录

验证日期：2026-09-25。验证环境为仓库 Compose 中的 Kafka 与 ClickHouse；测试使用合成 Span、独立 topic、独立 consumer group 和临时 ClickHouse 表，结束后已清理这些测试资源。

- 自动检查：`pnpm build`、`pnpm typecheck` 通过；Collector 批次处理测试 6/6 通过。
- 真实投递与失败恢复：先将 Collector 指向尚不存在的临时表，ClickHouse 写入失败后没有提交 offset；创建表并等待 KafkaJS 重启后，同一条消息成功入库。查询到 1 行，consumer group 的 `CURRENT-OFFSET=1`、`LOG-END-OFFSET=1`、`LAG=0`。
- 隐私：入库的 `attributes` 只包含非敏感模型字段；prompt canary 未落库，`Span.error` 为空。再次模拟写入失败时，ClickHouse 客户端原始错误日志已关闭，Kafka 日志只包含固定错误消息与调用栈，不含 payload 或底层错误 cause。
- TTL：运行中正式表的 `SHOW CREATE TABLE` 显示 30 天 TTL。隔离测试表先核对 2 条合成过期记录，应用相同的 30 天 TTL 并执行 `OPTIMIZE ... FINAL` 后记录数为 0；该表随后已删除。
- Kafka Compose 健康检查原 5 秒超时低于本机管理命令启动耗时，造成错误的 `unhealthy` 状态。将超时调至 30 秒并仅重建 Kafka 容器（保留数据卷）后，`docker compose up --wait` 返回 `Healthy`。
