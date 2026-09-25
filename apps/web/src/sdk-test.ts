import {
  createTraceId,
  initBrowserMonitoring,
  isValidTraceId,
  teardownBrowserMonitoring,
  type BrowserMonitorEvent,
} from './api';
import './sdk-test.css';

const PRIVACY_CANARY = 'sdk_local_fixture_not_collected_7f3a';
const TEST_ENDPOINT = `/__sdk_test__/http-error?fixture=${PRIVACY_CANARY}`;
const MAX_VISIBLE_EVENTS = 40;

const startButton = document.querySelector<HTMLButtonElement>('#start-sdk')!;
const stopButton = document.querySelector<HTMLButtonElement>('#stop-sdk')!;
const captureErrors = document.querySelector<HTMLInputElement>('#capture-errors')!;
const captureVitals = document.querySelector<HTMLInputElement>('#capture-vitals')!;
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

function eventTitle(event: BrowserMonitorEvent): string {
  if (event.type === 'network_error') return `${event.method} ${event.path} · ${event.status || event.reason}`;
  if (event.type === 'web_vital') return `${event.metric} · ${event.value}`;
  return event.message;
}

function eventKind(event: BrowserMonitorEvent): string {
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
  allScenarioButtons.forEach((button) => { button.disabled = !next; });
  statePill.dataset.state = next ? 'running' : 'stopped';
  stateText.textContent = next ? '采集中' : '未启动';
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
  initBrowserMonitoring({
    service: 'web-sdk-demo',
    environment: 'dev',
    captureErrors: captureErrors.checked,
    captureWebVitals: captureVitals.checked,
    sampleRate: 1,
    onEvent(event) {
      events.unshift(event);
      if (events.length > MAX_VISIBLE_EVENTS) events.length = MAX_VISIBLE_EVENTS;
      renderEvents();
    },
  });
  setRunning(true);
}

function stopSdk(): void {
  teardownBrowserMonitoring();
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
document.querySelector<HTMLButtonElement>('#clear-events')!.addEventListener('click', () => {
  events.length = 0;
  renderEvents();
});

setRunning(false);
renderEvents();
