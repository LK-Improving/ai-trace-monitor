export type TraceStatus = 'ok' | 'error';
export type AlertLevel = 'critical' | 'warning' | 'info';
export type AlertState = 'active' | 'acknowledged' | 'resolved';

export interface TraceRecord {
  id: string;
  operation: string;
  service: string;
  status: TraceStatus;
  duration: string;
  durationMs: number;
  spans: number;
  tokens: number;
  time: string;
  environment: string;
  error?: string;
}

export interface SpanRecord {
  id: string;
  parentId?: string;
  operation: string;
  service: string;
  startMs: number;
  durationMs: number;
  status: TraceStatus;
  summary: string;
  attributes: Record<string, string | number | boolean | string[]>;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

export interface AlertRecord {
  id: string;
  title: string;
  description: string;
  service: string;
  level: AlertLevel;
  state: AlertState;
  rule: string;
  time: string;
  environment: string;
  traceId?: string;
}

export const mockTraces: TraceRecord[] = [
  { id: 'a3f9c7e2d1b4', operation: 'POST /api/chat', service: 'llm-proxy', status: 'error', duration: '2.31s', durationMs: 2310, spans: 5, tokens: 2860, time: '14:26:08', environment: 'production', error: '上游模型请求超时，等待响应超过 1s' },
  { id: 'b7d2e4c1a895', operation: 'POST /api/chat', service: 'rag-retriever', status: 'ok', duration: '1.08s', durationMs: 1080, spans: 4, tokens: 1740, time: '14:26:02', environment: 'production' },
  { id: '9c1a8f3d72e0', operation: 'POST /api/chat', service: 'api-gateway', status: 'ok', duration: '612ms', durationMs: 612, spans: 3, tokens: 820, time: '14:25:47', environment: 'production' },
  { id: 'f4e2b9a7c316', operation: 'POST /api/agent/run', service: 'llm-proxy', status: 'ok', duration: '1.76s', durationMs: 1760, spans: 7, tokens: 4120, time: '14:25:18', environment: 'production' },
  { id: 'd8c3f5e1a629', operation: 'POST /api/chat', service: 'rag-retriever', status: 'ok', duration: '934ms', durationMs: 934, spans: 4, tokens: 1260, time: '14:24:52', environment: 'production' },
  { id: 'c2a7d18e4a52', operation: 'POST /api/chat', service: 'api-gateway', status: 'error', duration: '3.04s', durationMs: 3040, spans: 6, tokens: 0, time: '14:23:31', environment: 'staging', error: '模型服务返回 429：请求频率超限' },
  { id: 'e91b4a0c7d63', operation: 'POST /api/agent/run', service: 'tool-runner', status: 'ok', duration: '2.68s', durationMs: 2680, spans: 8, tokens: 3540, time: '14:21:16', environment: 'production' },
  { id: '17bd9e3c5a40', operation: 'POST /api/chat', service: 'llm-proxy', status: 'ok', duration: '1.42s', durationMs: 1420, spans: 5, tokens: 2210, time: '14:18:05', environment: 'staging' },
];

export const mockServices = [
  { name: 'api-gateway', requests: '24,381', errors: '0.52%', latency: '482ms', status: '正常', tone: 'ok' },
  { name: 'rag-retriever', requests: '12,907', errors: '1.21%', latency: '1.36s', status: '需关注', tone: 'warning' },
  { name: 'llm-proxy', requests: '11,003', errors: '0.91%', latency: '2.14s', status: '正常', tone: 'ok' },
  { name: 'tool-runner', requests: '3,185', errors: '0.18%', latency: '624ms', status: '正常', tone: 'ok' },
];

export const mockAlerts: AlertRecord[] = [
  { id: 'alt-1048', title: 'LLM 调用错误率上升', description: '过去 5 分钟错误率 6.2%，高于阈值 5%', service: 'llm-proxy', level: 'critical', state: 'active', rule: 'error_rate_5m', time: '5 分钟前', environment: 'production', traceId: mockTraces[0].id },
  { id: 'alt-1047', title: '检索延迟超过阈值', description: 'P95 延迟 1.36s，高于阈值 1s', service: 'rag-retriever', level: 'warning', state: 'active', rule: 'rag_latency_p95', time: '12 分钟前', environment: 'production', traceId: mockTraces[1].id },
  { id: 'alt-1046', title: 'API 网关 5xx 增加', description: '过去 10 分钟共出现 37 次 5xx 响应', service: 'api-gateway', level: 'warning', state: 'acknowledged', rule: 'api_5xx_rate', time: '28 分钟前', environment: 'production', traceId: mockTraces[2].id },
  { id: 'alt-1045', title: '月度 Token 预算达到 80%', description: '客服智能体本月已使用预算的 82%', service: '客服智能体', level: 'info', state: 'active', rule: 'monthly_token_budget', time: '36 分钟前', environment: 'production', traceId: mockTraces[3].id },
  { id: 'alt-1044', title: '模型服务触发频率限制', description: '上游返回 429，最近 10 分钟出现 14 次重试', service: 'llm-proxy', level: 'critical', state: 'active', rule: 'model_rate_limit', time: '31 分钟前', environment: 'staging', traceId: mockTraces[5].id },
  { id: 'alt-1042', title: 'Collector 消费延迟已恢复', description: '消费积压曾达到 1,240 条，目前已回到正常范围', service: 'trace-collector', level: 'info', state: 'resolved', rule: 'collector_lag', time: '42 分钟前', environment: 'staging' },
];

export const traceSpans: SpanRecord[] = [
  { id: 'sp-01', operation: 'http.server', service: 'api-gateway', startMs: 0, durationMs: 2310, status: 'ok', summary: 'POST /api/chat', attributes: { 'http.method': 'POST', 'http.route': '/api/chat', 'http.status_code': 200, environment: 'production' } },
  { id: 'sp-02', parentId: 'sp-01', operation: 'rag.retrieve', service: 'rag-retriever', startMs: 96, durationMs: 812, status: 'ok', summary: 'Qdrant search · topK 5', attributes: { topK: 5, sources: ['faq-1024', 'faq-2048', 'policy-031'], reranked: true } },
  { id: 'sp-03', parentId: 'sp-02', operation: 'rerank', service: 'rag-retriever', startMs: 908, durationMs: 246, status: 'ok', summary: 'cross-encoder rerank', attributes: { model: 'bge-reranker-v2', candidates: 12, selected: 5 } },
  { id: 'sp-04', parentId: 'sp-01', operation: 'llm.generate', service: 'llm-proxy', startMs: 1182, durationMs: 1012, status: 'error', summary: 'gpt-4o · 2,860 tokens', attributes: { model: 'gpt-4o-2024-08-06', promptVersion: 'support-v12', finishReason: 'timeout' }, inputTokens: 1920, outputTokens: 940, error: '上游模型请求超时，等待响应超过 1s' },
  { id: 'sp-05', parentId: 'sp-01', operation: 'response.serialize', service: 'api-gateway', startMs: 2200, durationMs: 94, status: 'ok', summary: 'serialize response', attributes: { responseBytes: 1840, redaction: 'enabled' } },
];

export const modelUsage = [
  { model: 'gpt-4o', provider: 'OpenAI 兼容接口', calls: '12,842', tokens: '1.82M', cost: '$128.40', share: 88, latency: '1.42s', errorRate: '0.9%' },
  { model: 'gpt-4o-mini', provider: 'OpenAI 兼容接口', calls: '9,221', tokens: '620K', cost: '$31.80', share: 42, latency: '684ms', errorRate: '0.3%' },
  { model: 'text-embedding-3-small', provider: '向量化服务', calls: '21,302', tokens: '200K', cost: '$4.20', share: 18, latency: '126ms', errorRate: '0.1%' },
];

export const ragRequests = [
  { traceId: mockTraces[1].id, query: '如何修改企业账号的开票信息？', topK: 5, sources: 5, latency: '812ms', hit: '命中', score: '0.91' },
  { traceId: mockTraces[4].id, query: '客服服务时间是几点到几点？', topK: 5, sources: 4, latency: '534ms', hit: '命中', score: '0.86' },
  { traceId: mockTraces[0].id, query: '退款申请需要哪些材料？', topK: 5, sources: 0, latency: '1.36s', hit: '无召回', score: '—' },
  { traceId: mockTraces[7].id, query: '如何重置员工登录密码？', topK: 8, sources: 6, latency: '728ms', hit: '命中', score: '0.78' },
];

export const agentRuns = [
  { traceId: mockTraces[3].id, agent: 'support-assistant', task: '查询订单并生成退款说明', steps: 7, tools: 'order.lookup · refund.policy', duration: '1.76s', status: '成功' },
  { traceId: mockTraces[6].id, agent: 'support-assistant', task: '核对物流状态并回复用户', steps: 8, tools: 'shipment.track · answer.compose', duration: '2.68s', status: '成功' },
  { traceId: mockTraces[0].id, agent: 'support-assistant', task: '整理退换货政策', steps: 5, tools: 'knowledge.search', duration: '2.31s', status: '失败' },
];
