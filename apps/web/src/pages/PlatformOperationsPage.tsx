import { useEffect, useState, type ReactNode } from 'react';
import { Icon, PageIntro, PanelHeading, StatusPill } from '../components/ui';
import {
  fetchOpsHealth,
  opsHealthErrorMessage,
  type OpsHealthResponse,
  type OpsHealthStatus,
  type OpsProducerState,
  type OpsRuntimeStatus,
} from '../ops-health-api';

const REFRESH_INTERVAL_MS = 30_000;

type HealthViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: OpsHealthResponse; refreshing: boolean; stale: boolean; refreshError?: string };

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let scaled = value;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toLocaleString('zh-CN', { maximumFractionDigits: digits })} ${units[unitIndex]}`;
}

function formatLatency(value: number | null): string {
  if (value === null) return '未知';
  return value >= 1000
    ? `${(value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 秒`
    : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 毫秒`;
}

function formatDuration(value: number | null): string {
  if (value === null) return '未知';
  const seconds = Math.floor(value);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟 ${remainder} 秒`;
  return `${remainder} 秒`;
}

function formatTimestamp(value: string | null): string {
  if (value === null) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value));
}

function statusTone(status: OpsHealthStatus | OpsRuntimeStatus): 'ok' | 'warning' | 'error' {
  if (status === 'healthy' || status === 'running') return 'ok';
  return status === 'degraded' ? 'warning' : 'error';
}

function healthLabel(status: OpsHealthStatus | OpsRuntimeStatus): string {
  if (status === 'healthy') return '健康';
  if (status === 'running') return '运行中';
  if (status === 'degraded') return '降级';
  return '不可用';
}

function producerTone(state: OpsProducerState): 'ok' | 'warning' | 'error' | 'info' | 'muted' {
  if (state === 'ready') return 'ok';
  if (state === 'connecting') return 'info';
  if (state === 'closing') return 'warning';
  if (state === 'unavailable' || state === 'closed') return 'error';
  return 'muted';
}

function producerLabel(state: OpsProducerState): string {
  const labels: Record<OpsProducerState, string> = {
    idle: '空闲',
    connecting: '连接中',
    ready: '就绪',
    unavailable: '不可用',
    closing: '关闭中',
    closed: '已关闭',
  };
  return labels[state];
}

function HealthMetric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="ops-metric"><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}

function PlatformHealthPanel({
  title,
  status,
  children,
  className = '',
}: {
  title: string;
  status: { tone: 'ok' | 'warning' | 'error' | 'info' | 'muted'; label: string };
  children: ReactNode;
  className?: string;
}) {
  return <section className={`panel ops-panel ${className}`} aria-label={title}>
    <PanelHeading title={title} aside={<StatusPill status={status.tone}>{status.label}</StatusPill>} />
    {children}
  </section>;
}

function PartitionLag({ partitions }: { partitions: OpsHealthResponse['kafka']['partitions'] }) {
  const knownLags = partitions.flatMap((item) => item.lag === null ? [] : [item.lag]);
  const maxLag = Math.max(1, ...knownLags);
  return <div className="ops-partitions" aria-label="Kafka 各分区积压">
    <div className="ops-subheading"><strong>分区积压</strong><span>消息条数</span></div>
    {partitions.length === 0
      ? <p className="ops-empty-note">当前未返回分区样本。</p>
      : partitions.map(({ partition, lag }) => <div className="ops-partition" key={partition}>
        <span>分区 {partition}</span>
        <div className="ops-lag-track" aria-hidden="true"><i style={{ width: lag === null ? '0%' : `${Math.max(lag > 0 ? 2 : 0, (lag / maxLag) * 100)}%` }} /></div>
        <strong>{lag === null ? '未知' : formatCount(lag)}</strong>
      </div>)}
  </div>;
}

function CounterGrid({ counters }: { counters: Array<{ label: string; value: number | null }> }) {
  return <div className="ops-counter-grid">{counters.map(({ label, value }) => <HealthMetric
    key={label}
    label={label}
    value={value === null ? '未知' : formatCount(value)}
  />)}</div>;
}

function QueueCapacityMeter({
  label,
  current,
  maximum,
  format,
}: {
  label: string;
  current: number | null;
  maximum: number | null;
  format: (value: number) => string;
}) {
  return <div className="ops-queue-capacity">
    <div><span>{label}</span><strong>{current === null ? '未知' : format(current)} <small>/ {maximum === null ? '未知' : format(maximum)}</small></strong></div>
    {current !== null && maximum !== null
      ? <progress
        value={maximum === 0 ? 0 : Math.min(current, maximum)}
        max={maximum || 1}
        aria-label={`${label}容量占用`}
        aria-valuetext={`${format(current)} / ${format(maximum)}`}
      />
      : <p className="ops-queue-capacity-note">当前健康 API 尚未提供完整的字节容量指标。</p>}
  </div>;
}

export function PlatformOperationsPage() {
  const [view, setView] = useState<HealthViewState>({ kind: 'loading' });
  const [retrySequence, setRetrySequence] = useState(0);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: number | undefined;
    let controller: AbortController | undefined;

    const load = async () => {
      controller = new AbortController();
      setView((current) => current.kind === 'ready'
        ? { ...current, refreshing: true }
        : { kind: 'loading' });
      try {
        const data = await fetchOpsHealth(controller.signal);
        if (!disposed) setView({ kind: 'ready', data, refreshing: false, stale: false });
      } catch (error) {
        if (!disposed && !controller?.signal.aborted) {
          const message = opsHealthErrorMessage(error);
          setView((current) => current.kind === 'ready'
            ? { ...current, refreshing: false, stale: true, refreshError: message }
            : { kind: 'error', message });
        }
      } finally {
        if (!disposed) refreshTimer = window.setTimeout(() => void load(), REFRESH_INTERVAL_MS);
      }
    };

    void load();
    return () => {
      disposed = true;
      controller?.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [retrySequence]);

  const ready = view.kind === 'ready' ? view : undefined;
  const data = ready?.data;
  const refresh = () => setRetrySequence((value) => value + 1);
  const overallStatus = data?.status;

  return <section className="module-page ops-page">
    <PageIntro
      eyebrow="PLATFORM / OPERATIONS"
      title="平台运行状态"
      description="查看平台依赖与数据管道的健康快照。此页面为平台级视图，不受当前项目、环境或时间范围筛选。"
      actions={<div className="ops-page-actions">
        <span className="ops-scope-tag"><i />平台级 · 全局基础设施</span>
        <button className="button ops-refresh-button" type="button" onClick={refresh} disabled={ready?.refreshing}>
          <Icon name="clock" size={14} />{ready?.refreshing ? '正在更新' : '立即刷新'}
        </button>
      </div>}
    />

    {view.kind === 'loading' && <div className="ops-state-banner" role="status" aria-live="polite">
      <span className="ops-state-mark loading-mark" aria-hidden="true" />
      <div><strong>正在读取平台健康指标</strong><p>首次查询完成后，每 30 秒自动刷新。</p></div>
    </div>}
    {view.kind === 'error' && <div className="ops-state-banner error" role="alert">
      <span className="ops-state-mark error-mark" aria-hidden="true">!</span>
      <div><strong>平台健康快照暂不可用</strong><p>{view.message}</p></div>
      <button className="button ops-retry-button" type="button" onClick={refresh}>重试</button>
    </div>}
    {ready?.stale && <div className="ops-state-banner stale" role="status" aria-live="polite">
      <span className="ops-state-mark stale-mark" aria-hidden="true">!</span>
      <div><strong>显示最近一次成功检查</strong><p>{ready.refreshError} · 检查于 {formatTimestamp(ready.data.checkedAt)}</p></div>
    </div>}

    {data && <>
      <div className={`ops-health-summary ${overallStatus ? statusTone(overallStatus) : ''}`} role="status" aria-live="polite">
        <div className="ops-summary-state">
          <span className="ops-summary-kicker">平台总状态</span>
          {overallStatus && <StatusPill status={statusTone(overallStatus)}>{healthLabel(overallStatus)}</StatusPill>}
        </div>
        <div className="ops-summary-meta">
          <span>平台进程运行时长</span><strong>{formatDuration(data.processUptimeSeconds)}</strong>
        </div>
        <div className="ops-summary-meta">
          <span>最近检查</span><strong>{formatTimestamp(data.checkedAt)}</strong>
        </div>
        <span className="ops-refresh-cadence">{ready.refreshing ? '正在刷新…' : '每 30 秒刷新'}</span>
      </div>

      <div className="ops-grid">
        <PlatformHealthPanel title="PostgreSQL" status={{ tone: statusTone(data.postgres.status), label: healthLabel(data.postgres.status) }}>
          <div className="ops-panel-body">
            <HealthMetric label="连接探测延迟" value={formatLatency(data.postgres.latencyMs)} note={data.postgres.latencyMs === null ? '本次未取得测量值' : '单次健康检查耗时'} />
          </div>
        </PlatformHealthPanel>

        <PlatformHealthPanel title="Kafka 消息队列" status={{ tone: statusTone(data.kafka.status), label: healthLabel(data.kafka.status) }}>
          <div className="ops-panel-body">
            <div className="ops-identifiers"><span>Topic <code>{data.kafka.topic}</code></span><span>Consumer group <code>{data.kafka.consumerGroup}</code></span></div>
            <HealthMetric label="总消费积压" value={data.kafka.totalLag === null ? '未知' : formatCount(data.kafka.totalLag)} note="Topic 全分区当前 lag" />
            <PartitionLag partitions={data.kafka.partitions} />
          </div>
        </PlatformHealthPanel>

        <PlatformHealthPanel title="Collector 消费与写入" status={{ tone: statusTone(data.collector.status), label: healthLabel(data.collector.status) }} className="ops-panel-wide">
          <div className="ops-panel-body">
            <div className="ops-identifiers"><span>Topic <code>{data.collector.topic}</code></span><span>Consumer group <code>{data.collector.consumerGroup}</code></span><span>进程运行时长 <code>{formatDuration(data.collector.uptimeSeconds)}</code></span></div>
            <p className="ops-counters-note">以下计数为当前 Collector 进程生命周期累计值；进程重启后会重新计数。</p>
            <CounterGrid counters={[
              { label: '已处理消息', value: data.collector.processedMessages },
              { label: '已写入 Span', value: data.collector.insertedSpans },
              { label: '无效消息', value: data.collector.invalidMessages },
              { label: '失败批次', value: data.collector.failedBatches },
              { label: 'ClickHouse 写入失败', value: data.collector.clickhouseWriteFailures },
              { label: '已提交批次', value: data.collector.committedBatches },
            ]} />
            <div className="ops-last-activity"><span>最近提交：<strong>{formatTimestamp(data.collector.lastCommitAt)}</strong></span><span>最近 ClickHouse 写入：<strong>{formatTimestamp(data.collector.lastClickHouseWriteAt)}</strong></span></div>
          </div>
        </PlatformHealthPanel>

        <PlatformHealthPanel title="API Span 发布队列" status={{ tone: producerTone(data.spanQueue.producerState), label: producerLabel(data.spanQueue.producerState) }}>
          <div className="ops-panel-body">
            <div className="ops-queue-limits" role="group" aria-label="Span 发布队列双重容量">
              <QueueCapacityMeter
                label="Span 数占用"
                current={data.spanQueue.depth}
                maximum={data.spanQueue.capacity}
                format={formatCount}
              />
              <QueueCapacityMeter
                label="队列字节占用"
                current={data.spanQueue.queueBytes}
                maximum={data.spanQueue.maxQueueBytes}
                format={formatBytes}
              />
            </div>
            <p className="ops-counters-note">已接收、已发布、丢弃、发布错误与重试为当前 API 进程内存累计值；API 重启后归零。</p>
            <CounterGrid counters={[
              { label: '已接收', value: data.spanQueue.accepted },
              { label: '已发布', value: data.spanQueue.published },
              { label: '丢弃', value: data.spanQueue.dropped },
              { label: '发布错误', value: data.spanQueue.publishErrors },
              { label: '重试', value: data.spanQueue.retries },
            ]} />
          </div>
        </PlatformHealthPanel>

        <PlatformHealthPanel title="ClickHouse 查询延迟" status={{ tone: statusTone(data.clickhouse.status), label: healthLabel(data.clickhouse.status) }}>
          <div className="ops-panel-body">
            <HealthMetric label="Ping 延迟" value={formatLatency(data.clickhouse.pingLatencyMs)} />
            <div className="ops-subheading ops-percentile-heading"><strong>查询延迟分位数</strong><span>进程内滚动近 5 分钟 · 重启后清空 · 非生产 SLO</span></div>
            <div className="ops-percentiles">
              <HealthMetric label="P50" value={formatLatency(data.clickhouse.queryLatency.p50Ms)} />
              <HealthMetric label="P95" value={formatLatency(data.clickhouse.queryLatency.p95Ms)} />
              <HealthMetric label="P99" value={formatLatency(data.clickhouse.queryLatency.p99Ms)} />
            </div>
            <div className="ops-query-samples"><span>样本数 <strong>{formatCount(data.clickhouse.queryLatency.sampleCount)}</strong></span><span>错误数 <strong>{formatCount(data.clickhouse.queryLatency.errorCount)}</strong></span></div>
          </div>
        </PlatformHealthPanel>
      </div>
    </>}
  </section>;
}
