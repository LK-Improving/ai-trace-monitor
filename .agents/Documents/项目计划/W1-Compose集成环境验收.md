# Phase 1 W1：Compose 集成环境验收

> 状态：本地集成环境验收通过  
> 日期：2026-09-25  
> 范围：PostgreSQL、Kafka（含 `ai-spans` Topic）、ClickHouse；不包含 API → Kafka → Collector → ClickHouse 业务数据闭环

## 1. 静态检查与配置调整

- `docker compose config --quiet`：通过。默认 PostgreSQL 宿主机端口解析为 `5432`；用 `POSTGRES_HOST_PORT=55432` 覆盖时解析为 `55432`。
- Kafka 初次启动失败原因：日志报 `/tmp/kraft-combined-logs/bootstrap.checkpoint.tmp` 权限拒绝。镜像以 `appuser`（UID 1000）运行，而该目录挂载卷不可写。
- 将 `kafka-data` 同一命名卷挂载到镜像内由 `appuser` 拥有且可写的 `/var/lib/kafka/data`，并把 `KAFKA_LOG_DIRS` 同步改为该路径。重新启动后 Kafka 健康检查通过。
- 本机已有 PostgreSQL 进程（PID 7044）占用 5432，另有项目容器 `dt-postgres` 占用 5433；均未停止或改动。Compose 的 PostgreSQL 宿主端口现可由 `POSTGRES_HOST_PORT` 覆盖，默认仍为 5432。本次验收使用 55432。

## 2. 启动命令与结果

PowerShell 本次使用的命令：

```powershell
$env:POSTGRES_HOST_PORT = '55432'
docker compose config --quiet
docker compose up -d --wait --wait-timeout 180
docker compose ps -a
```

结果：

| 服务 | 本次结果 | 验证内容 |
| --- | --- | --- |
| PostgreSQL 18.6 | `Up (healthy)`，绑定 `127.0.0.1:55432 -> 5432` | `pg_isready` 返回 accepting connections；初始化得到 `projects`、`services`、`project_keys`、告警、成员、审计共 7 张表；`services.environment` CHECK 约束为 `dev / staging / prod` |
| Kafka 4.2.0 | `Up (healthy)`，绑定 `127.0.0.1:9092` | `ai-spans` 存在，3 partitions、replication factor 1 |
| Kafka Topic 初始化任务 | `Exited (0)` | 一次性创建 Topic 的命令成功退出，属预期状态 |
| ClickHouse 26.8.4.11 | `Up (healthy)`，绑定 `127.0.0.1:8123` | `observability.trace_spans` 存在；DDL 使用 UTC `DateTime64(3)`，按 `event_time` 日分区，默认 30 天 TTL |

服务级命令及结果：

```text
docker compose exec -T postgres pg_isready -U trace_ops -d trace_ops
/var/run/postgresql:5432 - accepting connections

docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic ai-spans
Topic: ai-spans  PartitionCount: 3  ReplicationFactor: 1

docker compose exec -T clickhouse ... --query "SHOW CREATE TABLE observability.trace_spans"
返回 trace_spans DDL；包含 PARTITION BY toDate(event_time) 及 TTL event_time + toIntervalDay(30)
```

本机 5432 / 5433 冲突只影响 PostgreSQL 宿主机端口，不影响容器健康。若本机运行 API 并要连接本次 Compose 实例，应让本地 `DATABASE_URL` 端口与当前 `POSTGRES_HOST_PORT` 一致（本次为 55432）；本次未改 `.env` / `.env.example`。其他 Compose 服务仍可通过服务名访问容器端口。

本次未执行 `docker compose down`、`docker volume rm` 或任何卷清理。三个命名数据卷保留；PostgreSQL、Kafka、ClickHouse 容器保持运行，Topic 初始化容器按一次性任务退出 0。

## 3. 迁移与测试约定

- `infra/postgres/init` 和 `infra/clickhouse/init` 仅用于首次初始化空卷；不得把 init 脚本当作已有数据库的版本迁移工具。
- PostgreSQL 后续使用 `infra/postgres/migrations/V0001__short_snake_case.sql` 顺序迁移；ClickHouse 使用 `infra/clickhouse/migrations/V0001__short_snake_case.sql` 前向迁移。已应用文件不可改写；PostgreSQL 迁移记录版本和校验和、持锁串行执行；ClickHouse 用幂等、向前兼容的分步 DDL，不假设事务回滚。
- W1 未引入迁移 runner，也未对已有数据执行 schema 变更；在接入已有持久卷的第一次迁移前，先确定执行器和恢复/备份办法。
- 契约单测在 `packages/contracts/tests/*.test.mjs`，调用 `pnpm --filter @trace-ops/contracts test`；类型检查调用 `pnpm --filter @trace-ops/contracts typecheck`。集成容器健康通过后，后续按 Phase 1 W4–W7 增加真实 Span 流转、失败重试及 ClickHouse 写入验收。

## 4. 范围外与后续项

- 本次没有实现 API 项目密钥校验、Span 上报、Kafka Producer、Collector 写入或任何 W2+ 鉴权逻辑。
- 本次没有插入合成 Span 到 ClickHouse；这属于真实链路联调，不以基础设施容器健康替代。
- API、SDK、Collector 的环境序列化必须使用 `dev / staging / prod`；契约细节见 [W1-Span接口契约.md](./W1-Span接口契约.md)。
