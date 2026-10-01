const ADMIN_READ_PATHS = new Set(['/api/v1/projects', '/api/v1/overview']);

/** Restrict server-side admin credentials to the two read-only endpoints used by Overview. */
export function isAdminReadRequest(method: string | undefined, requestUrl: string | undefined): boolean {
  if (method?.toUpperCase() !== 'GET' || !requestUrl) return false;
  // Vite should only ever proxy origin-form paths. Reject absolute-form and
  // protocol-relative URLs before URL parsing so credentials cannot be
  // attached to a request whose authority was supplied by the caller.
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) return false;

  try {
    const pathname = new URL(requestUrl, 'http://vite.local').pathname.replace(/\/+$/, '') || '/';
    return ADMIN_READ_PATHS.has(pathname);
  } catch {
    return false;
  }
}
