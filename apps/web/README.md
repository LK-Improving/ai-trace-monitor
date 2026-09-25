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

## 当前边界

当前事件只交给接入方传入的 `onEvent` / `transport`；它们尚未上报到平台后端。W4 起才实现 Span ingest、Kafka Producer 和 Collector 数据闭环。本 SDK 本轮也不生成或发送 Span、项目密钥、API 凭证，也不实现业务操作的异步 Trace 上下文绑定。

## 本地浏览器验收页

执行 `pnpm --filter @trace-ops/web dev` 后打开 `http://localhost:5173/sdk-test.html`。先点击“启动 SDK”，再触发同源 HTTP 失败、合成 JavaScript Error 或合成 Promise rejection；事件列表会显示本地 `onEvent` 收到的脱敏字段，并检查 Trace ID 格式和固定合成标记是否进入事件。

HTTP 场景只请求 Vite 提供的 `GET /__sdk_test__/http-error` 本地 503 fixture，query 中仅放固定合成隐私标记；不访问 API 或管理路由，不带请求体和 Authorization，也不会读取响应体。JS / Promise 场景通过合成浏览器事件触发，不制造真实未处理异常。事件只保存在当前页面内存，页面没有配置 `transport`，不使用 `localStorage`，也不会提交 Prompt、Response 或用户原文。
