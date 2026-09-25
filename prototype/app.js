const pageRoot = document.querySelector('#pageRoot');
const pageTitle = document.querySelector('#pageTitle');
const navItems = [...document.querySelectorAll('.nav-item')];
const toast = document.querySelector('#toast');

const state = { page: 'overview', selectedTrace: null };

const traces = [
  { id: 'a3f9c7e2d1b4', displayId: 'a3f9c7e2...', operation: 'POST /api/chat', service: 'llm-proxy', status: 'error', duration: '2.31s', time: '14:26', spans: 8, tokens: '2,860' },
  { id: 'b7d2e4c1a895', displayId: 'b7d2e4c1...', operation: 'POST /api/retrieve', service: 'rag-retriever', status: 'ok', duration: '1.08s', time: '14:26', spans: 5, tokens: '—' },
  { id: '9c1a8f3d72e0', displayId: '9c1a8f3d...', operation: 'POST /api/chat', service: 'api-gateway', status: 'ok', duration: '612ms', time: '14:25', spans: 6, tokens: '1,840' },
  { id: 'f4e2b9a7c316', displayId: 'f4e2b9a7...', operation: 'POST /api/chat', service: 'llm-proxy', status: 'ok', duration: '1.76s', time: '14:25', spans: 7, tokens: '3,022' },
  { id: 'd8c3f5e1a629', displayId: 'd8c3f5e...', operation: 'POST /api/retrieve', service: 'rag-retriever', status: 'ok', duration: '934ms', time: '14:24', spans: 4, tokens: '—' },
  { id: 'c2a7d18e4a52', displayId: 'c2a7d18e...', operation: 'POST /api/chat', service: 'api-gateway', status: 'ok', duration: '846ms', time: '14:23', spans: 6, tokens: '1,506' },
];

function chartSvg() {
  const samples = 72;
  const requestAnchors = [[0, 1080], [.08, 980], [.18, 910], [.28, 1030], [.36, 1320], [.43, 1080], [.52, 1260], [.58, 1370], [.64, 1760], [.68, 1940], [.72, 1640], [.78, 1500], [.86, 1290], [.93, 1230], [1, 980]];
  const errorAnchors = [[0, .62], [.1, .58], [.22, .48], [.32, .45], [.44, .38], [.54, .48], [.62, .55], [.65, 1.08], [.68, .57], [.78, .48], [.92, .55], [1, .92]];
  const sampleSeries = (anchors, amplitude) => Array.from({ length: samples }, (_, index) => {
    const position = index / (samples - 1);
    const next = anchors.findIndex(([at]) => at >= position);
    const left = anchors[Math.max(0, next - 1)];
    const right = anchors[next < 0 ? anchors.length - 1 : next];
    const ratio = right[0] === left[0] ? 0 : (position - left[0]) / (right[0] - left[0]);
    const base = left[1] + (right[1] - left[1]) * ratio;
    const noise = Math.sin(index * 2.73) * amplitude * .56 + Math.cos(index * 1.61) * amplitude * .31 + Math.sin(index * .83) * amplitude * .18;
    return Math.max(0, base + noise);
  });
  const plotLeft = 58;
  const plotRight = 748;
  const plotWidth = plotRight - plotLeft;
  const linePath = (values, max) => values.map((value, index) => {
    const x = plotLeft + index / (values.length - 1) * plotWidth;
    const y = 218 - Math.min(value, max) / max * 200;
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const requests = sampleSeries(requestAnchors, 135);
  const errors = sampleSeries(errorAnchors, .09);
  const horizontal = [18, 58, 98, 138, 178, 218].map(y => `<line class="chart-grid-line" x1="0" y1="${y}" x2="800" y2="${y}"/>`).join('');
  const tickPositions = Array.from({ length: 6 }, (_, index) => plotLeft + plotWidth * index / 5);
  const vertical = tickPositions.map(x => `<line class="chart-grid-line vertical" x1="${x}" y1="18" x2="${x}" y2="218"/>`).join('');
  const labelY = [21, 61, 101, 141, 181, 221];
  const leftLabels = ['2,500', '2,000', '1,500', '1,000', '500', '0'].map((label, index) => `<text class="chart-label chart-label-left" x="${plotLeft - 10}" y="${labelY[index]}">${label}</text>`).join('');
  const rightLabels = ['5%', '4%', '3%', '2%', '1%', '0%'].map((label, index) => `<text class="chart-label chart-label-right" x="${plotRight + 10}" y="${labelY[index]}">${label}</text>`).join('');
  const times = ['04:00', '08:00', '12:00', '16:00', '20:00', '00:00'].map((label, index) => `<text class="chart-label chart-time" x="${tickPositions[index]}" y="250">${label}</text>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 800 255" preserveAspectRatio="none" role="img" aria-label="最近 24 小时请求量与错误率趋势图">
    ${horizontal}${vertical}${leftLabels}${rightLabels}${times}
    <path class="chart-line" d="${linePath(requests, 2500)}"/>
    <path class="chart-line secondary" d="${linePath(errors, 5)}"/>
  </svg>`;
}

function metricCard(label, value, unit, delta, direction, points) {
  const arrow = direction === 'down' ? 'bi-arrow-down-short' : 'bi-arrow-up-short';
  const spark = points.map(([x, y]) => `${x},${y}`).join(' ');
  return `<article class="metric-card reveal"><div class="metric-label">${label}</div><div class="metric-bottom"><div class="metric-value">${value}<span>${unit}</span></div><div class="metric-change"><strong class="delta-up"><i class="bi ${arrow}" aria-hidden="true"></i>${delta}</strong><svg class="micro-chart" viewBox="0 0 48 20" preserveAspectRatio="none" aria-hidden="true"><polyline points="${spark}"/></svg></div></div></article>`;
}

function statusBadge(status) {
  const map = { ok: ['ok', '正常'], error: ['error', '错误'], warning: ['warn', '延迟'] };
  const [klass, label] = map[status] || map.ok;
  return `<span class="status-badge ${klass}"><i class="status-indicator" aria-hidden="true"></i>${label}</span>`;
}

function overview() {
  return `<section class="reveal">
    <div class="page-heading"><div><h1>运行概况</h1><p>实时掌握 AI 应用的运行状态、性能表现与潜在问题</p></div><div class="header-actions overview-filters"><button class="filter-chip"><span class="filter-label">项目</span><strong>客服智能体</strong><i class="bi bi-chevron-down" aria-hidden="true"></i></button><button class="filter-chip"><span class="filter-label">环境</span><strong>production</strong><i class="bi bi-chevron-down" aria-hidden="true"></i></button><button class="filter-chip"><span class="filter-label">时间范围</span><strong>最近 24 小时</strong><i class="bi bi-chevron-down" aria-hidden="true"></i></button></div></div>
    <div class="metric-grid">
      ${metricCard('请求量', '48,291', '', '+12.4%', 'up', [[0, 16], [8, 13], [15, 14], [22, 7], [29, 8], [36, 11], [42, 4], [48, 1]])}
      ${metricCard('错误率', '0.82', '%', '-0.3%', 'down', [[0, 4], [7, 6], [14, 12], [21, 8], [29, 11], [36, 15], [42, 10], [48, 5]])}
      ${metricCard('P95 延迟', '1.68', 's', '-12.1%', 'down', [[0, 14], [8, 11], [14, 4], [21, 5], [28, 10], [35, 12], [42, 7], [48, 6]])}
      ${metricCard('Token', '2.64', 'M', '+18.7%', 'up', [[0, 16], [8, 13], [15, 14], [22, 7], [29, 8], [36, 10], [42, 4], [48, 1]])}
    </div>
    <div class="content-grid">
      <section class="panel chart-panel reveal"><div class="panel-head"><div class="panel-title">请求与错误率</div><div class="chart-legend"><span><i class="legend-key" style="background:var(--accent)"></i>请求量（次）</span><span><i class="legend-key" style="background:var(--amber)"></i>错误率（%）</span></div></div><div class="chart-wrap">${chartSvg()}</div></section>
      <section class="panel alert-panel reveal"><div class="panel-head"><div class="panel-title">待处理告警</div><button class="text-link" data-page-action="alerts">查看全部 →</button></div><div class="alert-list">
        <div class="alert-item" data-trace-id="a3f9c7e2d1b4"><span class="severity-bar"></span><div class="alert-content"><strong>LLM 调用错误率上升</strong><p><span>llm-proxy</span><i></i><span>5 分钟前</span></p></div><span class="priority-badge high">高</span></div>
        <div class="alert-item" data-trace-id="b7d2e4c1a895"><span class="severity-bar warning"></span><div class="alert-content"><strong>检索延迟超过阈值</strong><p><span>rag-retriever</span><i></i><span>12 分钟前</span></p></div><span class="priority-badge medium">中</span></div>
        <div class="alert-item" data-trace-id="9c1a8f3d72e0"><span class="severity-bar info"></span><div class="alert-content"><strong>API 网关 5xx 增加</strong><p><span>api-gateway</span><i></i><span>28 分钟前</span></p></div><span class="priority-badge low">低</span></div>
      </div></section>
    </div>
    <div class="lower-grid"><section class="panel table-panel reveal"><div class="panel-head"><div class="panel-title">服务状态</div><button class="text-link" data-page-action="settings">查看全部 →</button></div><div class="table-wrap"><table class="data-table service-table"><thead><tr><th>服务</th><th>请求量</th><th>错误率</th><th>P95</th><th>状态</th></tr></thead><tbody>
      <tr><td><div class="service-cell">api-gateway</div></td><td>24,381</td><td>0.52%</td><td>482ms</td><td><span class="health-dot"></span>正常</td></tr>
      <tr><td><div class="service-cell">rag-retriever</div></td><td>12,907</td><td>1.21%</td><td>1.36s</td><td><span class="health-dot warning"></span>异常</td></tr>
      <tr><td><div class="service-cell">llm-proxy</div></td><td>11,003</td><td>0.91%</td><td>2.14s</td><td><span class="health-dot"></span>正常</td></tr>
    </tbody></table></div></section><section class="panel trace-panel reveal"><div class="panel-head"><div class="panel-title">最新 Traces</div><button class="text-link" data-page-action="traces">查看全部 →</button></div><div class="table-wrap trace-table-wrap"><table class="data-table compact-trace-table"><thead><tr><th>Trace ID</th><th>服务</th><th>耗时</th><th>状态</th><th>时间</th></tr></thead><tbody>${traces.slice(0, 5).map(traceTableRow).join('')}</tbody></table></div></section></div>
  </section>`;
}

function traceTableRow(trace) {
  const status = trace.status === 'error' ? '错误' : '成功';
  return `<tr class="clickable-row" data-trace-id="${trace.id}"><td><span class="trace-link">${trace.displayId}</span><button class="copy-id-button" type="button" data-action="copy-id" aria-label="复制 Trace ID"><i class="bi bi-copy" aria-hidden="true"></i></button></td><td>${trace.service}</td><td class="mono">${trace.duration}</td><td><span class="trace-state ${trace.status === 'error' ? 'error' : ''}"><i></i>${status}</span></td><td>${trace.time}</td></tr>`;
}

function tracesPage() {
  if (state.selectedTrace) return traceDetail(state.selectedTrace);
  return `<section class="reveal"><div class="page-heading"><div><div class="eyebrow">/ TRACE EXPLORER · 12,482 RESULTS</div><h1>追踪每一次回答。</h1><p>用 Trace ID 把前端、服务、RAG、模型和外部工具串起来。点击任意一行进入执行树。</p></div><div class="header-actions"><button class="btn btn-primary" data-action="export">↓ 导出结果</button></div></div><div class="filter-strip"><label class="search-box"><span>⌕</span><input placeholder="搜索 Trace ID、错误信息、服务…" /></label><button class="filter-chip">状态：全部 <span class="down">⌄</span></button><button class="filter-chip">服务：全部 <span class="down">⌄</span></button><button class="filter-chip">环境：production <span class="down">⌄</span></button><button class="filter-chip">更多筛选 <span class="down">⌄</span></button></div><section class="panel trace-table-panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>TRACE ID</th><th>OPERATION</th><th>SERVICE</th><th>STATUS</th><th>DURATION</th><th>SPANS</th><th>TOKENS</th><th>TIME</th></tr></thead><tbody>${traces.map(t => `<tr data-trace-id="${t.id}" class="clickable-row"><td><span class="trace-link">${t.id}</span></td><td>${t.operation}</td><td>${t.service}</td><td>${statusBadge(t.status)}</td><td class="mono">${t.duration}</td><td>${t.spans}</td><td class="mono">${t.tokens}</td><td>${t.time}</td></tr>`).join('')}</tbody></table></div><div class="panel-footer"><span>显示 1–6 / 12,482 条 Trace</span><span class="mono">‹ 1 / 2,081 ›</span></div></section></section>`;
}

function traceDetail(id) {
  const trace = traces.find(t => t.id === id) || traces[0];
  return `<section class="reveal"><div class="trace-detail-header"><button class="back-button" data-action="back-traces">← 返回 Trace 列表</button><div><div class="eyebrow">TRACE DETAIL · ${trace.status === 'error' ? 'INVESTIGATE' : 'COMPLETED'}</div><h1 style="font-size:26px;margin:0">一次请求的完整路径</h1><div class="detail-id">${trace.id}</div></div><div class="detail-summary"><div class="summary-pill"><small>status</small><strong>${trace.status === 'error' ? 'ERROR' : 'OK'}</strong></div><div class="summary-pill"><small>duration</small><strong>${trace.duration}</strong></div><div class="summary-pill"><small>spans</small><strong>${trace.spans}</strong></div><div class="summary-pill"><small>tokens</small><strong>${trace.tokens}</strong></div></div></div><div class="detail-layout"><section class="panel tree-panel"><div class="panel-head"><div><div class="panel-title">Span 执行树</div><div class="panel-subtitle">parentSpanId 关系 · 时间线视图</div></div><button class="btn btn-quiet" data-action="copy-trace">复制 Trace ID</button></div><div class="trace-tree"><div class="tree-axis"><span>0ms</span><span>500ms</span><span>1000ms</span><span>1500ms</span><span>2000ms</span><span>2400ms</span></div><div class="tree-row"><div class="tree-label"><strong>http.server</strong><small>api-gateway · root</small></div><div class="tree-track"><div class="tree-bar root" style="left:0%;width:96%">POST /api/chat</div><span class="tree-duration" style="left:80%">2,396ms</span></div></div><div class="tree-row"><div class="tree-label"><strong>rag.retrieve</strong><small>rag-retriever</small></div><div class="tree-track"><div class="tree-bar rag" style="left:4%;width:35%">Qdrant search · topK 5</div><span class="tree-duration" style="left:26%">812ms</span></div></div><div class="tree-row"><div class="tree-label"><strong>rerank</strong><small>rag-retriever</small></div><div class="tree-track"><div class="tree-bar db" style="left:39%;width:11%">rerank</div><span class="tree-duration" style="left:41%">246ms</span></div></div><div class="tree-row"><div class="tree-label"><strong>llm.generate</strong><small>llm-proxy · gpt-4o</small></div><div class="tree-track"><div class="tree-bar llm ${trace.status === 'error' ? 'error' : ''}" style="left:51%;width:41%">${trace.status === 'error' ? 'timeout / upstream error' : 'gpt-4o · 2,860 tokens'}</div><span class="tree-duration" style="left:73%">${trace.status === 'error' ? '1,012ms · error' : '1,018ms'}</span></div></div><div class="tree-row"><div class="tree-label"><strong>response.serialize</strong><small>api-gateway</small></div><div class="tree-track"><div class="tree-bar db" style="left:93%;width:4%">···</div><span class="tree-duration" style="left:86%">94ms</span></div></div></div></section><aside class="panel span-panel"><div class="panel-head"><div><div class="panel-title">Span 属性</div><div class="panel-subtitle">llm.generate · selected</div></div><span class="status-badge ${trace.status === 'error' ? 'error' : 'ok'}">${trace.status === 'error' ? 'ERROR' : 'OK'}</span></div><div class="span-tabs"><button class="span-tab active">Attributes</button><button class="span-tab">Usage</button><button class="span-tab">Events</button></div><div class="span-meta"><div class="property-row"><span>service</span><span>llm-proxy</span></div><div class="property-row"><span>model</span><span>gpt-4o-2024-08-06</span></div><div class="property-row"><span>promptVersion</span><span>support-v12</span></div><div class="property-row"><span>inputTokens</span><span>1,920</span></div><div class="property-row"><span>outputTokens</span><span>940</span></div><div class="property-row"><span>totalTokens</span><span>2,860</span></div><div class="property-row"><span>finishReason</span><span>${trace.status === 'error' ? 'timeout' : 'stop'}</span></div></div><div class="panel-head" style="padding-top:0"><div><div class="panel-title" style="font-size:11px">采集上下文</div></div></div><pre class="code-block">{\n  <span class="key">"topK"</span>: <span class="string">5</span>,\n  <span class="key">"sources"</span>: [<span class="string">"faq-1024"</span>, <span class="string">"faq-2048"</span>],\n  <span class="key">"redaction"</span>: <span class="string">"enabled"</span>\n}</pre></aside></div></section>`;
}

function alertsPage() {
  const list = [
    ['critical', 'LLM 调用错误率上升', 'llm-proxy · 过去 5 分钟错误率 6.2%', '5 分钟前', 'a3f9c7e2d1b4'],
    ['warning', '检索延迟超过阈值', 'rag-retriever · P95 1.36s > 1s', '12 分钟前', 'b7d2e4c1a895'],
    ['info', 'API 网关 5xx 增加', 'api-gateway · 5xx 请求持续增加', '28 分钟前', '9c1a8f3d72e0'],
    ['info', 'Token 预算达到 80%', '客服智能体 · monthly budget', '36 分钟前', 'f4e2b9a7c316'],
    ['info', 'Collector 消费延迟恢复', 'observability-collector · lag 归零', '42 分钟前', '—'],
  ];
  return `<section class="reveal"><div class="page-heading"><div><div class="eyebrow">ALERTS · 12 ACTIVE</div><h1>告警中心</h1><p>按严重程度查看异常，并从告警直接进入相关 Trace。</p></div><div class="header-actions"><button class="btn btn-quiet" data-action="mute"><i class="bi bi-bell-slash" aria-hidden="true"></i> 静默规则</button><button class="btn btn-primary" data-action="rule"><i class="bi bi-plus-lg" aria-hidden="true"></i> 新建规则</button></div></div><div class="metric-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));"><article class="metric-card reveal"><div class="metric-label">活跃告警</div><div class="metric-value">12<span>条</span></div><div class="metric-foot"><span class="delta-down">+3</span><span>过去 30 分钟</span></div></article><article class="metric-card reveal"><div class="metric-label">严重告警</div><div class="metric-value">2<span>条</span></div><div class="metric-foot"><span class="delta-down">需要处理</span><span>最高优先级</span></div></article><article class="metric-card reveal"><div class="metric-label">平均响应</div><div class="metric-value">8<span>min</span></div><div class="metric-foot"><span class="delta-up">-2.1min</span><span>较上周</span></div></article><article class="metric-card reveal"><div class="metric-label">规则覆盖率</div><div class="metric-value">86<span>%</span></div><div class="metric-foot"><span class="delta-up">+4.8%</span><span>已覆盖服务</span></div></article></div><section class="panel trace-table-panel" style="margin-top:12px"><div class="panel-head"><div><div class="panel-title">告警时间线</div><div class="panel-subtitle">全部活跃和最近已恢复的告警</div></div><div class="filter-strip" style="margin:0"><button class="filter-chip">级别：全部 <i class="bi bi-chevron-down" aria-hidden="true"></i></button><button class="filter-chip">状态：活跃 <i class="bi bi-chevron-down" aria-hidden="true"></i></button></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>级别</th><th>告警</th><th>服务</th><th>规则</th><th>关联 Trace</th><th>状态</th><th>时间</th></tr></thead><tbody>${list.map(([level, title, desc, time, trace]) => `<tr><td><span class="status-badge ${level === 'critical' ? 'error' : level === 'warning' ? 'warn' : 'ok'}"><i class="status-indicator" aria-hidden="true"></i>${level === 'critical' ? '严重' : level === 'warning' ? '警告' : '提示'}</span></td><td><strong style="color:var(--ink);font-size:10px">${title}</strong><div style="color:var(--muted);font-size:9px;margin-top:4px">${desc}</div></td><td>${desc.split(' · ')[0]}</td><td class="mono">${title.includes('5xx') ? 'api_5xx_rate' : level === 'critical' ? 'error_rate_5m' : level === 'warning' ? 'latency_p95' : 'budget_monthly'}</td><td>${trace === '—' ? '—' : `<span class="trace-link" data-trace-id="${trace}">${trace}</span>`}</td><td><span class="status-badge ${time === '42 分钟前' ? 'ok' : 'warn'}"><i class="status-indicator" aria-hidden="true"></i>${time === '42 分钟前' ? '已恢复' : '待处理'}</span></td><td>${time}</td></tr>`).join('')}</tbody></table></div></section></section>`;
}

function aiPage() {
  return `<section class="reveal"><div class="page-heading"><div><div class="eyebrow">/ AI CHAIN · MODEL INTELLIGENCE</div><h1>模型在回答什么，为什么。</h1><p>把 Token、模型、RAG 和 Agent 执行放到同一张图里，看到效果，也看到代价。</p></div><div class="header-actions"><button class="btn btn-quiet" data-action="download-report">↓ 下载报告</button><button class="btn btn-primary" data-page-action="traces">打开 Trace</button></div></div><div class="ai-top-grid"><div class="ai-highlight"><div class="metric-label">AVG TTFT</div><div class="metric-value">420<span>ms</span></div><p>首 Token 延迟 · 较上周 <span class="delta-up">↓ 12%</span></p></div><div class="ai-highlight"><div class="metric-label">RAG HIT RATE</div><div class="metric-value">78.4<span>%</span></div><p>最终答案引用了检索上下文</p></div><div class="ai-highlight"><div class="metric-label">COST / REQUEST</div><div class="metric-value">$0.0038<span>/ req</span></div><p>按模型价格表估算 · 本日</p></div></div><div class="ai-layout"><section class="panel"><div class="panel-head"><div><div class="panel-title">模型调用与成本</div><div class="panel-subtitle">按总 Token 消耗排序 · production</div></div><button class="panel-menu">···</button></div><div style="padding-top:11px"><div class="model-row"><div class="model-name"><span class="model-logo">4o</span><div>gpt-4o<span class="model-sub">openai-compatible · 12,842 calls</span></div></div><div class="model-value">1.82M tok<div class="model-bar"><i style="width:88%"></i></div></div><div class="model-value">$128.4</div></div><div class="model-row"><div class="model-name"><span class="model-logo">4m</span><div>gpt-4o-mini<span class="model-sub">openai-compatible · 9,221 calls</span></div></div><div class="model-value">620K tok<div class="model-bar"><i style="width:42%"></i></div></div><div class="model-value">$31.8</div></div><div class="model-row"><div class="model-name"><span class="model-logo">Q</span><div>text-embedding-3-small<span class="model-sub">qdrant embedder · 21,302 calls</span></div></div><div class="model-value">200K tok<div class="model-bar"><i style="width:18%"></i></div></div><div class="model-value">$4.2</div></div><div class="panel-footer"><span>已配置 4 个模型价格</span><button class="text-link" data-action="price">管理价格表 →</button></div></div></section><section class="panel quality-card"><div class="panel-head"><div><div class="panel-title">RAG 质量信号</div><div class="panel-subtitle">过去 24 小时 · 7,240 次检索</div></div><span class="status-badge ok">● STABLE</span></div><div class="quality-stack"><div class="quality-item"><header><span>检索成功率</span><strong>96.8%</strong></header><div class="quality-track"><i style="width:96.8%"></i></div></div><div class="quality-item"><header><span>有效召回率</span><strong>78.4%</strong></header><div class="quality-track"><i style="width:78.4%"></i></div></div><div class="quality-item"><header><span>平均 topK</span><strong>5.0</strong></header><div class="quality-track"><i style="width:62%"></i></div></div><div class="quality-note">⚑ 过去 30 分钟有 <strong style="color:var(--amber)">18 条</strong> Trace 出现“召回为空”，建议查看数据源 <span class="mono">faq_2024</span>。</div></div></section></div></section>`;
}

function settingsPage() {
  return `<section class="reveal"><div class="page-heading"><div><div class="eyebrow">/ PROJECT SETTINGS · CONTRACTS</div><h1>让每个服务都可被看见。</h1><p>配置项目接入、采样和数据边界。原型里保留了第一版最关键的安全开关。</p></div><div class="header-actions"><button class="btn btn-primary" data-action="save-settings">保存修改</button></div></div><div class="settings-grid"><section class="panel"><div class="panel-head"><div><div class="panel-title">采集策略</div><div class="panel-subtitle">客服智能体 / production</div></div></div><div class="settings-list"><div class="setting-item"><div><strong>采集 Prompt / Response 原文</strong><p>当前关闭，仅保存长度、Hash 和 Token。</p></div><button class="toggle" data-toggle="content"><i></i></button></div><div class="setting-item"><div><strong>启用前端性能指标</strong><p>LCP / INP / CLS / FCP / TTFB。</p></div><button class="toggle on" data-toggle="web"><i></i></button></div><div class="setting-item"><div><strong>错误 Span 实时告警</strong><p>状态为 error 时立即触发 critical。</p></div><button class="toggle on" data-toggle="alert"><i></i></button></div><div class="setting-item"><div><strong>采样率</strong><p>生产流量全量采集 Span 元数据。</p></div><span class="mono" style="color:var(--lime);font-size:11px">100%</span></div></div></section><section class="panel docs-card"><div class="panel-head"><div><div class="panel-title">接入凭证与 Trace Header</div><div class="panel-subtitle">复制后添加到你的 API 服务</div></div><button class="btn btn-quiet" data-action="rotate-key">轮换密钥</button></div><div class="settings-list"><div class="copy-row"><span class="tiny-label" style="color:var(--muted);font-size:9px">PROJECT KEY</span><button class="text-link" data-action="copy-key">复制</button></div><div class="docs-code"><span class="method">trc_live_</span><span class="value">••••••••••••••••••••••••</span> <span style="color:#56636e">(仅创建时展示一次)</span></div><div class="copy-row"><span class="tiny-label" style="color:var(--muted);font-size:9px">REQUEST HEADER</span><button class="text-link" data-action="copy-header">复制示例</button></div><div class="docs-code"><span class="header">x-trace-id:</span> <span class="value">trace_web_8f2a9c13d7e1</span><br /><span class="header">x-project-key:</span> <span class="value">trc_live_••••••••</span></div><button class="btn btn-primary" data-page-action="docs">查看完整接入文档 →</button></div></section></div></section>`;
}

function docsPage() {
  return `<section class="reveal"><div class="page-heading"><div><div class="eyebrow">/ QUICKSTART · 04 MIN READ</div><h1>四分钟接入第一条 Trace。</h1><p>在 API 请求头带上 Trace ID，平台就能把你的 Web、RAG 和 LLM 调用串成一棵执行树。</p></div><div class="header-actions"><button class="btn btn-primary" data-action="copy-doc">复制接入代码</button></div></div><section class="panel docs-card"><div class="panel-head"><div><div class="panel-title">服务端接入 · TypeScript</div><div class="panel-subtitle">NestJS / Express / Node.js</div></div><span class="status-badge ok">SDK READY</span></div><pre class="docs-code"><span style="color:#798791">// 1. 生成或接收 Trace ID</span>\n<span class="method">const</span> traceId = req.headers[<span class="value">'x-trace-id'</span>] ?? crypto.randomUUID()\n\n<span style="color:#798791">// 2. 记录根 Span</span>\n<span class="method">const</span> root = recorder.start(<span class="value">'http.server'</span>, traceId)\n\n<span style="color:#798791">// 3. RAG 与 LLM 作为子 Span</span>\n<span class="method">const</span> rag = recorder.start(<span class="value">'rag.retrieve'</span>, traceId, root.id)\nrag.set(<span class="value">'topK'</span>, 5).set(<span class="value">'sources'</span>, sources)\n<span class="method">await</span> rag.end()\n\n<span class="method">const</span> llm = recorder.start(<span class="value">'llm.generate'</span>, traceId, root.id)\nllm.set(<span class="value">'model'</span>, <span class="value">'gpt-4o'</span>).setUsage(inputTokens, outputTokens)\n<span class="method">await</span> llm.end()\n<span class="method">await</span> root.end()</pre><div class="panel-footer"><span>上报后约 8 秒可在 Trace Explorer 查询</span><button class="text-link" data-action="copy-doc">复制全部代码 →</button></div></section></section>`;
}

const pages = { overview, traces: tracesPage, alerts: alertsPage, ai: aiPage, settings: settingsPage, docs: docsPage };
const titles = { overview: '运行概况', traces: 'Trace Explorer', alerts: '告警中心', ai: 'AI 链路', settings: '项目设置', docs: '接入文档' };

function render() {
  pageRoot.innerHTML = pages[state.page]();
  pageTitle.textContent = titles[state.page];
  navItems.forEach(item => item.classList.toggle('is-active', item.dataset.page === state.page));
  bindDynamicEvents();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function setPage(page) { state.page = page; state.selectedTrace = null; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

function bindDynamicEvents() {
  document.querySelectorAll('[data-page-action]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.pageAction)));
  document.querySelectorAll('[data-trace-id]').forEach(row => row.addEventListener('click', event => {
    if (event.target.closest('[data-action="copy-id"]')) return;
    state.selectedTrace = row.dataset.traceId;
    state.page = 'traces';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', event => {
    const action = button.dataset.action;
    if (action === 'copy-id') {
      event.stopPropagation();
      const id = button.closest('[data-trace-id]')?.dataset.traceId || '';
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(id).then(() => showToast('Trace ID 已复制')).catch(() => showToast('Trace ID 已复制'));
      else showToast('Trace ID 已复制');
      return;
    }
    if (action === 'back-traces') { state.selectedTrace = null; render(); return; }
    const messages = { about: 'Trace Ops · AI 全链路监控', refresh: '数据已刷新，延迟 8s', export: '已生成 Trace 导出任务', copy: '已复制到剪贴板', 'copy-trace': 'Trace ID 已复制', mute: '静默规则面板已打开', rule: '新建告警规则面板已打开', 'download-report': 'AI 链路报告生成中', price: '价格表配置已打开', 'save-settings': '项目设置已保存', 'rotate-key': '新密钥已生成（原密钥仍有效 24h）', 'copy-key': '项目密钥已复制', 'copy-header': 'Header 示例已复制', 'copy-doc': '接入代码已复制' };
    showToast(messages[action] || '操作已完成');
  }));
  document.querySelectorAll('[data-toggle]').forEach(toggle => toggle.addEventListener('click', () => { toggle.classList.toggle('on'); showToast(toggle.classList.contains('on') ? '采集开关已开启' : '采集开关已关闭'); }));
}

navItems.forEach(item => item.addEventListener('click', () => setPage(item.dataset.page)));
render();
