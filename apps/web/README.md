# Phase 2：Trace ID 与服务端 Span Quickstart

Docs 页的 Node.js 示例集中导出为 `NODE_QUICKSTART`，浏览器示例为 `BROWSER_QUICKSTART`，来源是 `src/quickstart.ts`。Node.js 18+ 可直接用原生 `fetch`，不需要安装或导入 SDK。将 Node 示例保存为 `quickstart.mjs` 后执行 `node quickstart.mjs`。

运行前配置 `TRACE_OPS_PROJECT_KEY`、`TRACE_OPS_SERVICE` 和 `TRACE_OPS_ENVIRONMENT`，并确认 service/environment 已在隔离项目中注册。模板默认使用 `customer-api` / `dev`；`TRACE_OPS_ENDPOINT` 可选，默认 `http://localhost:3001/api/v1/spans`。环境只接受 `dev`、`staging`、`prod`。项目创建、服务注册和密钥签发方法见 [`apps/api/README.md` 的管理 API](../api/README.md#管理-api)；这些管理路由需要可信服务端的管理员令牌。

此请求把 `projectKey` 放在 JSON body，不放在 header；批次 `environment` 与每个 Span 的 `service` 需要匹配已注册绑定。Span 使用 `traceId`、`spanId`、可选 `parentSpanId`、`service`、`operation`、`startTime`、`endTime`、`status` 和 `attributes`。服务端补充 `projectId` 与 `schemaVersion`。HTTP 202 表示 API 有界内存队列已接受，不表示已持久写入 Kafka 或 ClickHouse。

```js
import { randomUUID } from 'node:crypto';

const endpoint = process.env.TRACE_OPS_ENDPOINT ?? 'http://localhost:3001/api/v1/spans';
const projectKey = process.env.TRACE_OPS_PROJECT_KEY;
const environment = process.env.TRACE_OPS_ENVIRONMENT ?? 'dev';
const service = process.env.TRACE_OPS_SERVICE ?? 'customer-api';

if (!projectKey) throw new Error('Set TRACE_OPS_PROJECT_KEY in the server environment.');
if (!['dev', 'staging', 'prod'].includes(environment)) {
  throw new Error('TRACE_OPS_ENVIRONMENT must be dev, staging, or prod.');
}

const traceId = 'trace_v1_' + randomUUID();
const rootSpanId = randomUUID();
const childSpanId = randomUUID();
const startTime = Date.now();
const childStartTime = Math.max(startTime, Date.now());
const childEndTime = Math.max(childStartTime, Date.now());
const endTime = Math.max(childEndTime, startTime);

const payload = {
  projectKey,
  environment,
  spans: [
    {
      traceId,
      spanId: rootSpanId,
      service,
      operation: 'http.server',
      startTime,
      endTime,
      status: 'ok',
      attributes: { source: 'quickstart' },
    },
    {
      traceId,
      spanId: childSpanId,
      parentSpanId: rootSpanId,
      service,
      operation: 'quickstart.work',
      startTime: childStartTime,
      endTime: childEndTime,
      status: 'ok',
      attributes: { source: 'quickstart' },
    },
  ],
};

const response = await fetch(endpoint, {
  method: 'POST',
  signal: AbortSignal.timeout(5000),
  headers: {
    'content-type': 'application/json',
    'x-trace-id': traceId,
  },
  body: JSON.stringify(payload),
});

if (response.status !== 202) {
  throw new Error('Span ingest expected HTTP 202, received ' + response.status);
}

console.log('Trace ' + traceId + ' accepted; HTTP 202 means queued in API process memory only, not durable storage.');
```

浏览器 quickstart 只生成并向自己的应用 API 透传 `x-trace-id`。它不会创建或上报 Span/前端监控事件，浏览器代码也不得持有项目密钥；前端事件采集不属于本阶段。

```js
const traceId = 'trace_v1_' + crypto.randomUUID();

await fetch('/api/chat', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-trace-id': traceId,
  },
  body: JSON.stringify({ question }),
});

// This only propagates a correlation ID to your application API.
// It does not create or upload Span or frontend monitoring events.
```

# 浏览器监控 SDK（Phase 1 W2–W3）

SDK 入口位于 `src/api.ts`。它复用 W1 的 Trace ID helper，并提供页面级监控启动、停止、Web Vitals 和前端异常事件。环境必须传入规范值 `dev`、`staging` 或 `prod`；展示层别名仅由 `toProtocolEnvironment()` 转换。

```ts
import { initBrowserMonitoring } from './api';

const monitor = initBrowserMonitoring({
  service: 'customer-web',
  environment: 'dev',
  enabled: true,
  sampleRate: 1,
  captureWebVitals: true,
  captureErrors: true,
  onEvent(event) {
    // 由接入方决定如何处理安全的诊断事件。
    console.info(event);
  },
});

// 页面卸载或接入方停用监控时调用；也可通过 startBrowserMonitoring() 重启。
monitor.teardown();
```

`onEvent` 和可选 `transport(event)` 是唯一的事件出口。默认没有 sink，也没有平台 telemetry ingest 地址；SDK 不会自行发 HTTP 上报请求。传入两者时，每个事件会分别交给两个 sink。sink 的同步异常和异步拒绝不会影响业务请求。

默认启用开关仅在调用 `initBrowserMonitoring()` 后生效：`enabled`、`captureWebVitals`、`captureErrors` 默认为 `true`，`sampleRate` 默认为 `1`。采样率在每次启动时为整个页面会话抽样；未抽中的会话不会注册监听器、patch 网络方法或注入 Trace ID。`enabled: false` 与 `teardown()` 会停止采集和 Trace Header 注入。相同配置重复 `start()` 不会重复安装监听器或 patch。

自动 fetch/XHR 处理只覆盖同源请求：注入一个符合 W1 格式的 `x-trace-id`，优先复用有效入站值，否则使用页面 meta 值或 Web Crypto 生成新值；同源网络错误和非 2xx 响应只产生 method、status、耗时和脱敏 path 元信息。跨域 fetch/XHR 原样通过，不注入 Header，也不采集事件。已有 `apiFetch()` 是显式 Trace-aware helper；浏览器中对跨域 URL 会跳过自动注入。

## 隐私默认

- SDK 不提供原文采集开关，也不读取或发送 Prompt、Response、用户输入、文档正文、请求/响应 body、Cookie、Authorization 或其他 Header。
- 网络事件不克隆或读取 Response body。路径去掉 query/hash，只保留已知固定路由名，其余路径段替换为 `:id`。JS 异常使用固定通用消息和标准错误类型，不读取原始异常消息或 rejection 文本；脚本路径也使用相同脱敏规则。
- Web Vitals 使用 GoogleChrome/web-vitals 官方 `onCLS`、`onINP`、`onLCP`、`onFCP`、`onTTFB` 回调，只读取指标名、数值、变化量、评级和安全格式的指标 ID；不读取 performance entries 或 DOM attribution。
- Web Vitals API 没有 observer teardown。SDK 每个页面生命周期最多注册一组观察器；teardown 后回调不再转发，重启时复用该组观察器。

## 可选 Browser Span relay（W8）

核心 SDK 默认仍只把安全事件交给接入方的 `onEvent` / `transport`。独立的 `src/browser-span-transport.ts` 可由接入方显式创建，把固定服务 `web-sdk-demo`、环境 `dev` 的 SDK 事件转成 Browser Span；它不是生产网关，也不会创建、读取或暴露 projectKey、PLATFORM_ADMIN_TOKEN 或 Authorization。验收页的“上报到本地平台”默认关闭，只有勾选后启动 SDK 才创建 relay。

Relay 只接受无 query/hash 的同源 endpoint，验收页固定使用 `POST /__sdk_test__/spans`。本地 Vite `configureServer` 通过根目录 `scripts/browser-span-relay.cjs` 提供此同源 BFF 路由；其他宿主需提供等价的 caller-owned BFF。浏览器请求 JSON 严格为 `{ environment: 'dev', spans: [...] }`，Span 仅含 `traceId`、`spanId`、`service`、`operation`、`startTime`、`endTime`、`status`、`attributes`。operation 固定映射为 `browser.web_vital`、`browser.javascript_error`、`browser.unhandled_rejection` 或 `browser.network_error`，且必须与 `attributes.eventType` 一致。属性只允许定义的安全诊断字段；原文 message、metricId、body、headers、parent ID 和 token usage 不发送。传入事件必须已属于 `web-sdk-demo` / `dev`，路径还会经过 relay 的白名单校验；Web Vital value 必须非负，delta 允许有符号并遵循 relay 的数值上限。

队列上限 100，单请求最多 20 个 Span，自动 flush 每秒一次；“立即上报”可立即启动 flush，并在一个 flush 中分批发送。单次请求超时 3 秒。失败的批次不重试；非 HTTP 202、超时和网络失败只增加失败计数，不抛到业务调用，也不会由 SDK 再捕获。Relay 在 SDK 启动前解析未包装的 fetch，`api.ts` 还仅对固定的同源 `POST /__sdk_test__/spans` 做递归保护。请求不带 Authorization，并使用 `credentials: 'omit'`。验收页只把 HTTP 202 显示为“API内存排队”，它表示 API 进程内存队列已接收，不代表持久写入或 Collector 入库；停止时清空待发队列、取消进行中的请求并 dispose，同时保留计数供检查。

该 relay 是一个可选的浏览器到宿主 BFF 接口示例，不是生产网关，也不替代应用自己的认证、生产反向代理或凭证管理。启动开发服务前在服务端进程设置 `SDK_TEST_PROJECT_KEY`。该密钥只供服务端 relay 使用，不能设置为 `VITE_*`，不会进入浏览器 Bundle 或 Span 请求体；服务端 relay 再使用此密钥转发到 API。未配置时 relay 会失败关闭；默认关闭状态不会发出上报请求。

## 控制台真实数据链路（Phase 2 W18–W20）

运行仓库根目录的 `pnpm dev` 时，总览、Trace 检索/详情、AI 链路和告警通知页读取真实 API 数据，包括 `/api/v1/projects`、`/api/v1/metrics/*`、`/api/v1/traces` 与 `/api/v1/alerts/*`。前端只走同源 `/api`；Vite 开发服务器从进程环境读取 `PLATFORM_ADMIN_TOKEN`，按路由、HTTP 方法、参数和 JSON 字段白名单转发这些管理请求，并在服务端注入 Bearer 令牌。令牌不进入浏览器 Bundle、`VITE_*` 配置或存储。未配置令牌或 API 不可用时显示明确错误，不回退为假实时数据。

此 Vite 代理仅用于本地开发。生产控制台必须配置可信的服务端反向代理/BFF 或用户登录与权限体系，不能把管理员令牌发给浏览器。总览“最新 Traces”、Trace 检索/详情、AI 指标、告警中心及项目设置中的告警通知均接入真实 API。通知界面支持项目级 Webhook/Email 渠道、测试投递、投递状态筛选和失败后人工重试；原始目标只在提交时进入同源代理，请求结束后不回显或持久化在浏览器。项目其他演示配置仍不执行真实写入，前端事件联合查询及生产权限闭环留在 Phase 3。

开发代理跟随进程环境中的 `API_PORT`（默认 3001）。若该端口被其他项目占用，可在根目录 `.env` 中设置其他端口后重启 `pnpm dev`；API 与前端代理会使用相同端口。请用 `http://127.0.0.1:5173/` 访问，避免 `localhost` 解析到其他应用占用的 IPv6 监听地址。

## 本地浏览器验收页

执行 `pnpm --filter @trace-ops/web dev` 后打开 `http://127.0.0.1:5173/sdk-test.html`。默认不勾选“上报到本地平台”：启动 SDK 并触发同源 HTTP 失败、合成 JavaScript Error、合成 Promise rejection 后，事件只进入本地 `onEvent`。Web Vitals 仍由 SDK 的官方 observer 正常采集；上报开关关闭时不会因此产生平台请求。

HTTP 场景只请求 Vite 提供的 `GET /__sdk_test__/http-error` 本地 503 fixture，query 中仅放固定合成隐私标记；不访问 API 或管理路由，不带请求体和 Authorization，也不会读取响应体。JS / Promise 场景通过合成浏览器事件触发，不制造真实未处理异常。启用平台 relay 需明确勾选并重启；“立即上报”可发送当前内存队列，停止会清空队列并保留 disposal 计数。页面不使用 `localStorage`，也不会提交 Prompt、Response 或用户原文。
