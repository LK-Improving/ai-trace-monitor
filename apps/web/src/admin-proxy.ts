const ADMIN_READ_PATHS = new Set([
  '/api/v1/projects',
  '/api/v1/overview',
  '/api/v1/metrics/overview',
  '/api/v1/metrics/ai',
  '/api/v1/traces',
  '/api/v1/alerts',
  '/api/v1/alerts/summary',
]);

const ALERT_STATE_PATCH_PATH = /^\/api\/v1\/alerts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/state$/i;

/**
 * Legacy path-only allowlist check retained for existing consumers/tests.
 * Runtime credential forwarding uses the stricter local proxy and query
 * validator in admin-proxy-runtime.mjs.
 */
export function isAdminReadRequest(method: string | undefined, requestUrl: string | undefined): boolean {
  if (method?.toUpperCase() !== 'GET' || !requestUrl) return false;
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//') || requestUrl.includes('\\') || requestUrl.includes('#')) {
    return false;
  }

  const pathname = requestUrl.split('?', 1)[0].replace(/\/+$/, '') || '/';
  const rawPathname = requestUrl.split('?', 1)[0];
  if (rawPathname === '/api/v1/alerts/summary') return ADMIN_READ_PATHS.has(rawPathname);
  if (rawPathname.startsWith('/api/v1/alerts/')) return false;
  if (ADMIN_READ_PATHS.has(pathname)) return true;
  return /^\/api\/v1\/traces\/[^/]+$/.test(pathname);
}

/** The one browser mutation allowed through the local admin proxy. */
export function isAlertStatePatchRequest(method: string | undefined, requestUrl: string | undefined): boolean {
  if (method?.toUpperCase() !== 'PATCH' || !requestUrl) return false;
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//') || /[\\?#]/.test(requestUrl)) return false;
  return ALERT_STATE_PATCH_PATH.test(requestUrl);
}
