import {
  createTraceId,
  initBrowserMonitoring,
  isValidTraceId,
  teardownBrowserMonitoring,
  type BrowserMonitorEvent,
} from './api';
import {
  BROWSER_SPAN_ENDPOINT,
  BROWSER_SPAN_ENVIRONMENT,
  BROWSER_SPAN_SERVICE,
  createBrowserSpanTransport,
  type BrowserSpanTransport,
  type BrowserSpanTransportStatus,
} from './browser-span-transport';
import './sdk-test.css';

const PRIVACY_CANARY = 'sdk_local_fixture_not_collected_7f3a';
const TEST_ENDPOINT = `/__sdk_test__/http-error?fixture=${PRIVACY_CANARY}`;
const MAX_VISIBLE_EVENTS = 40;

const startButton = document.querySelector<HTMLButtonElement>('#start-sdk')!;
const stopButton = document.querySelector<HTMLButtonElement>('#stop-sdk')!;
const captureErrors = document.querySelector<HTMLInputElement>('#capture-errors')!;
const captureVitals = document.querySelector<HTMLInputElement>('#capture-vitals')!;
const serverRelay = document.querySelector<HTMLInputElement>('#server-relay')!;
const flushButton = document.querySelector<HTMLButtonElement>('#flush-spans')!;
const transportState = document.querySelector<HTMLElement>('#transport-state')!;
const transportDetail = document.querySelector<HTMLElement>('#transport-detail')!;
const statePill = document.querySelector<HTMLElement>('#sdk-state')!;
const stateText = statePill.querySelector<HTMLSpanElement>('span')!;
const traceIdElement = document.querySelector<HTMLElement>('#current-trace-id')!;
const traceValidity = document.querySelector<HTMLElement>('#trace-valid')!;
const eventCount = document.querySelector<HTMLElement>('#event-count')!;
const traceCheck = document.querySelector<HTMLElement>('#trace-check')!;
const privacyCheck = document.querySelector<HTMLElement>('#privacy-check')!;
const eventList = document.querySelector<HTMLElement>('#event-list')!;
const eventJson = document.querySelector<HTMLPreElement>('#event-json')!;
const allScenarioButtons = [...document.querySelectorAll<HTMLButtonElement>('.scenario-button')];
const events: BrowserMonitorEvent[] = [];
let running = false;
let currentTraceId = '';
let spanTransport: BrowserSpanTransport | undefined;
let retainedTransportStatus: BrowserSpanTransportStatus | undefined;

function eventTitle(event: BrowserMonitorEvent): string {
  if (event.type === 'navigation') return 'Browser navigation';
  if (event.type === 'network_error') return `${event.method} ${event.path} · ${event.status || event.reason}`;
  if (event.type === 'web_vital') return `${event.metric} · ${event.value}`;
  return event.message;
}

function eventKind(event: BrowserMonitorEvent): string {
  if (event.type === 'navigation') return 'NAVIGATION';
  if (event.type === 'network_error') return 'NETWORK';
  if (event.type === 'web_vital') return 'VITAL';
  if (event.type === 'javascript_error') return 'JS ERROR';
  return 'PROMISE';
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
}

function renderEvents(): void {
  eventCount.textContent = `${events.length} 条`;
  const hasEvents = events.length > 0;
  const allTraceIdsValid = hasEvents && events.every((event) => isValidTraceId(event.traceId));
  const fixtureLeaked = events.some((event) => JSON.stringify(event).includes(PRIVACY_CANARY));

  traceCheck.textContent = hasEvents ? (allTraceIdsValid ? '全部有效' : '存在无效值') : '等待事件';
  traceCheck.dataset.state = hasEvents ? (allTraceIdsValid ? 'ok' : 'bad') : 'idle';
  privacyCheck.textContent = hasEvents ? (fixtureLeaked ? '发现测试标记' : '未发现') : '等待事件';
  privacyCheck.dataset.state = hasEvents ? (fixtureLeaked ? 'bad' : 'ok') : 'idle';

  eventList.replaceChildren();
  if (!hasEvents) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const glyph = document.createElement('span');
    glyph.className = 'empty-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '∅';
    const title = document.createElement('strong');
    title.textContent = '还没有事件';
    const hint = document.createElement('small');
    hint.textContent = '启动 SDK 后，从上方选择一个合成场景。';
    empty.append(glyph, title, hint);
    eventList.append(empty);
    eventJson.textContent = '// 收到事件后，仅显示 SDK onEvent 回调中的字段';
    return;
  }

  events.slice(0, MAX_VISIBLE_EVENTS).forEach((event, index) => {
    const row = document.createElement('article');
    row.className = 'event-row';
    const kind = document.createElement('span');
    kind.className = `event-kind ${event.type.replace('_', '-')}`;
    kind.textContent = eventKind(event);
    const copy = document.createElement('span');
    copy.className = 'event-copy';
    const title = document.createElement('strong');
    title.textContent = eventTitle(event);
    const metadata = document.createElement('small');
    metadata.textContent = `${event.service} · ${formatTime(event.timestamp)}`;
    copy.append(title, metadata);
    const id = document.createElement('code');
    id.textContent = event.traceId;
    row.append(kind, copy, id);
    eventList.append(row);
    if (index === 0) eventJson.textContent = JSON.stringify(event, null, 2);
  });
}

function setRunning(next: boolean): void {
  running = next;
  startButton.disabled = next;
  stopButton.disabled = !next;
  captureErrors.disabled = next;
  captureVitals.disabled = next;
  serverRelay.disabled = next;
  allScenarioButtons.forEach((button) => { button.disabled = !next; });
  statePill.dataset.state = next ? 'running' : 'stopped';
  stateText.textContent = next ? '采集中' : '未启动';
  renderTransportStatus();
}

function renderTransportStatus(): void {
  const status = spanTransport?.getStatus() ?? retainedTransportStatus;
  flushButton.disabled = !running || !spanTransport || !status || status.queueSize === 0 || status.state === 'sending';

  if (!serverRelay.checked && !status) {
    transportState.textContent = '默认关闭';
    transportState.dataset.state = 'idle';
    transportDetail.textContent = '仅本地 onEvent；不会发起平台请求。';
    return;
  }

  if (!spanTransport && status?.state === 'disposed') {
    transportState.textContent = '已停止';
    transportState.dataset.state = 'disposed';
    transportDetail.textContent = `累计 API 内存排队 ${status.apiQueuedCount} · 失败 ${status.failedCount} · 丢弃 ${status.droppedCount}`;
    return;
  }

  if (!running || !spanTransport) {
    transportState.textContent = serverRelay.checked ? '启动后生效' : '默认关闭';
    transportState.dataset.state = 'idle';
    transportDetail.textContent = `固定 ${BROWSER_SPAN_ENVIRONMENT} / ${BROWSER_SPAN_SERVICE} · 同源 ${BROWSER_SPAN_ENDPOINT}`;
    return;
  }

  if (status?.state === 'sending') {
    transportState.textContent = '发送中';
    transportState.dataset.state = 'sending';
  } else if (status?.queueSize) {
    transportState.textContent = 'queued_in_memory';
    transportState.dataset.state = 'queued_in_memory';
  } else if (status?.lastDelivery === 'queued_in_memory') {
    transportState.textContent = 'API内存排队';
    transportState.dataset.state = 'queued_in_memory';
  } else if (status?.state === 'failed') {
    transportState.textContent = '上报失败';
    transportState.dataset.state = 'failed';
  } else {
    transportState.textContent = '已启用 · 等待事件';
    transportState.dataset.state = 'idle';
  }
  transportDetail.textContent = `浏览器队列 ${status?.queueSize ?? 0} · API内存排队 ${status?.apiQueuedCount ?? 0} · 失败 ${status?.failedCount ?? 0} · 丢弃 ${status?.droppedCount ?? 0}`;
}

function startSdk(): void {
  if (running) return;
  if (!currentTraceId) currentTraceId = createTraceId();
  events.length = 0;
  renderEvents();
  document.querySelector<HTMLMetaElement>('meta[name="x-trace-id"]')?.remove();
  const traceMeta = document.createElement('meta');
  traceMeta.name = 'x-trace-id';
  traceMeta.content = currentTraceId;
  document.head.append(traceMeta);

  traceIdElement.textContent = currentTraceId;
  traceValidity.textContent = isValidTraceId(currentTraceId) ? '格式有效' : '格式无效';
  traceValidity.dataset.state = isValidTraceId(currentTraceId) ? 'ok' : 'bad';

  // Create the opt-in relay before the monitor patch; the adapter also resolves the underlying fetch if loaded late.
  spanTransport = serverRelay.checked
    ? createBrowserSpanTransport({
      endpoint: BROWSER_SPAN_ENDPOINT,
      onStatusChange(status) {
        retainedTransportStatus = status;
        renderTransportStatus();
      },
    })
    : undefined;
  retainedTransportStatus = spanTransport?.getStatus();

  initBrowserMonitoring({
    service: BROWSER_SPAN_SERVICE,
    environment: BROWSER_SPAN_ENVIRONMENT,
    captureErrors: captureErrors.checked,
    captureWebVitals: captureVitals.checked,
    sampleRate: 1,
    onEvent(event) {
      events.unshift(event);
      if (events.length > MAX_VISIBLE_EVENTS) events.length = MAX_VISIBLE_EVENTS;
      renderEvents();
    },
    ...(spanTransport ? { transport: spanTransport.transport } : {}),
  });
  setRunning(true);
}

function stopSdk(): void {
  teardownBrowserMonitoring();
  spanTransport?.dispose();
  if (spanTransport) retainedTransportStatus = spanTransport.getStatus();
  spanTransport = undefined;
  setRunning(false);
}

async function triggerFetchError(): Promise<void> {
  try {
    // Local Vite fixture only: GET, no body/auth; deliberately do not inspect the response body.
    await fetch(TEST_ENDPOINT, { method: 'GET' });
  } catch {
    // The SDK captures network failures too; no raw exception details are shown here.
  }
}

function triggerJavaScriptError(): void {
  const error = new Error(PRIVACY_CANARY);
  window.dispatchEvent(new ErrorEvent('error', {
    message: PRIVACY_CANARY,
    filename: new URL('/src/sdk-test.ts', location.origin).href,
    lineno: 1,
    colno: 1,
    error,
  }));
}

function triggerPromiseRejection(): void {
  const syntheticEvent = new Event('unhandledrejection');
  Object.defineProperty(syntheticEvent, 'reason', { value: new Error(PRIVACY_CANARY) });
  window.dispatchEvent(syntheticEvent);
}

startButton.addEventListener('click', startSdk);
stopButton.addEventListener('click', stopSdk);
document.querySelector<HTMLButtonElement>('#trigger-fetch')!.addEventListener('click', () => void triggerFetchError());
document.querySelector<HTMLButtonElement>('#trigger-js-error')!.addEventListener('click', triggerJavaScriptError);
document.querySelector<HTMLButtonElement>('#trigger-rejection')!.addEventListener('click', triggerPromiseRejection);
flushButton.addEventListener('click', () => { void spanTransport?.flush(); });
serverRelay.addEventListener('change', renderTransportStatus);
document.querySelector<HTMLButtonElement>('#clear-events')!.addEventListener('click', () => {
  events.length = 0;
  renderEvents();
});

setRunning(false);
renderEvents();
