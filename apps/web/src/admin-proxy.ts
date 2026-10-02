const ADMIN_READ_PATHS = new Set([
  '/api/v1/projects',
  '/api/v1/overview',
  '/api/v1/metrics/overview',
  '/api/v1/metrics/ai',
  '/api/v1/traces',
]);

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
  if (ADMIN_READ_PATHS.has(pathname)) return true;
  return /^\/api\/v1\/traces\/[^/]+$/.test(pathname);
}
