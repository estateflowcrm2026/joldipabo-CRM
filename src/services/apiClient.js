// API client — a thin fetch wrapper for talking to the Joldipabo backend.
//
// The default app still runs against `demoRepository` (in-memory seed data).
// This module exists so `apiRepository.js` can call the real HTTP surface
// when `VITE_USE_API_REPOSITORY === 'true'`.
//
// Config (all Vite env vars, read once on first call):
//   VITE_API_BASE_URL     default http://localhost:4000/api/v1
//   VITE_DEV_AUTH_TOKEN   default Bearer token when `getAuthToken()` returns null
//
// What this client guarantees:
//   * Always sends JSON requests, always parses JSON responses.
//   * Reads `Authorization: Bearer <token>` from getAuthToken(); falls back
//     to `VITE_DEV_AUTH_TOKEN` (if set) so a curl-style dev shortcut works.
//   * Reads the standard backend error envelope `{ error: { code, message, detail? } }`
//     and surfaces it as `ApiError`. A non-JSON / network failure becomes
//     a generic `ApiError` with status 0 and code 'network-error'.
//   * Never throws synchronously. Every request resolves or rejects.
//
// What this client does NOT do:
//   * No retries, no backoff, no caching, no auth refresh.
//   * No `localStorage` token persistence (token state is module-scoped).
//   * No multipart upload (only JSON bodies).
//   * No abort signal handling beyond what the caller passes.

const DEFAULT_BASE_URL = 'http://localhost:4000/api/v1';

/**
 * Returns the configured base URL. Cached after first read so a hot-reload
 * during dev does not mid-flight switch the target.
 *
 * @returns {string}
 */
function readBaseUrl() {
  // `import.meta.env.VITE_*` is replaced at build time by Vite. Undefined
  // when unset; fall back to the default.
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  const fromEnv = env.VITE_API_BASE_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    // Strip trailing slash to keep path concatenation predictable.
    return fromEnv.trim().replace(/\/+$/, '');
  }
  return DEFAULT_BASE_URL;
}

/**
 * Returns the configured default dev token. Empty string when unset.
 *
 * @returns {string}
 */
function readDevToken() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  const fromEnv = env.VITE_DEV_AUTH_TOKEN;
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
}

// ---------------------------------------------------------------------------
// Auth token state. Module-scoped so it survives between request calls in
// the same session; not persisted to localStorage by design (the demo app
// does not own auth state yet).
// ---------------------------------------------------------------------------

let authToken = null;

/**
 * Returns the Bearer token to send on the next request. Resolution order:
 *   1. The token set via `setAuthToken()` (if non-empty).
 *   2. `VITE_DEV_AUTH_TOKEN` (if non-empty).
 *   3. `null` (the server will respond 401).
 *
 * @returns {string|null}
 */
export function getAuthToken() {
  if (authToken) return authToken;
  const fallback = readDevToken();
  return fallback || null;
}

/**
 * Replace the auth token used by subsequent requests. Pass an empty string
 * to clear (subsequent calls fall back to the env var, if any).
 *
 * @param {string|null|undefined} token
 */
export function setAuthToken(token) {
  authToken = typeof token === 'string' && token.trim() ? token.trim() : null;
}

/** Clear the auth token. Subsequent calls fall back to `VITE_DEV_AUTH_TOKEN`. */
export function clearAuthToken() {
  authToken = null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown by `apiRequest` when the server responds with a non-2xx
 * status, or when the request fails before reaching the server.
 *
 * The shape mirrors the backend's `{ error: { code, message, detail? } }`
 * envelope so callers can pattern-match on `code` (e.g. 'unauthorized',
 * 'forbidden', 'not-found', 'invalid-payload').
 */
export class ApiError extends Error {
  /**
   * @param {object} args
   * @param {number} args.status    HTTP status code. 0 for network / parse failures.
   * @param {string} args.code      Backend error code, or 'network-error' / 'parse-error'.
   * @param {string} args.message   Human-readable message.
   * @param {object} [args.detail]  Optional structured payload from the server.
   */
  constructor({ status, code, message, detail }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.message = message;
    if (detail !== undefined) this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

/**
 * Issue an HTTP request to the configured backend.
 *
 * @param {string} path            Path beginning with `/`, e.g. `/listings`.
 *   Joined onto the configured base URL.
 * @param {object} [options]
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} [options.method='GET']
 * @param {object} [options.body]   JSON body. Omit / null for no body.
 * @param {object} [options.query]  Query string params. Values are coerced
 *   via `String()`; `undefined` / `null` are dropped.
 * @param {object} [options.headers] Extra request headers.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<*>}            Parsed JSON body, or `null` for 204 / empty.
 * @throws {ApiError}
 */
export async function apiRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const baseUrl = readBaseUrl();
  const url = buildUrl(baseUrl, path, options.query);

  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  const hasBody = options.body !== undefined && options.body !== null;
  if (hasBody && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getAuthToken();
  if (token && !('Authorization' in headers)) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
      // `credentials: 'include'` attaches the HttpOnly session cookie.
      // Needed because the frontend and API are different origins in
      // development (localhost:5173 vs localhost:4000), and a
      // cross-origin fetch defaults to omitting credentials — which
      // would present as "the session cookie does not exist" rather
      // than as a CORS problem.
      credentials: options.credentials ?? 'same-origin',
    });
  } catch (err) {
    // Network / DNS / CORS / abort. Treat all as ApiError so callers have
    // one shape to handle.
    const code = err && err.name === 'AbortError' ? 'aborted' : 'network-error';
    throw new ApiError({
      status: 0,
      code,
      message: err && err.message ? String(err.message) : 'Network request failed.',
    });
  }

  // No content — server says nothing to parse. Return null so callers
  // can treat 204 / empty bodies uniformly.
  if (response.status === 204) return null;

  // Read once. If parsing fails we still need the status to throw a useful
  // ApiError, so buffer the text first.
  const rawText = await response.text();
  let body = null;
  if (rawText) {
    try {
      body = JSON.parse(rawText);
    } catch (_) {
      if (response.ok) {
        // 2xx but not JSON — treat as parse error rather than swallowing
        // a success that the caller cannot understand.
        throw new ApiError({
          status: response.status,
          code: 'parse-error',
          message: 'Response was not valid JSON.',
        });
      }
      // Non-2xx with a non-JSON body: best-effort status-only error.
      throw new ApiError({
        status: response.status,
        code: 'http-error',
        message: response.statusText || `HTTP ${response.status}`,
      });
    }
  }

  if (!response.ok) {
    // The server emits the standard envelope `{ error: { code, message, detail? } }`.
    // Anything else falls back to a status-text message.
    const err = body && body.error;
    throw new ApiError({
      status: response.status,
      code: (err && err.code) || 'http-error',
      message: (err && err.message) || response.statusText || `HTTP ${response.status}`,
      detail: err && err.detail,
    });
  }

  return body;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Compose `baseUrl + path + ?query`. Path is expected to start with `/`.
 * `query` keys with `undefined`/`null`/empty-string values are dropped.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @param {object} [query]
 * @returns {string}
 */
function buildUrl(baseUrl, path, query) {
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  if (!query) return `${baseUrl}${normalisedPath}`;
  const params = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const str = typeof value === 'string' ? value.trim() : String(value);
    if (!str) continue;
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(str)}`);
  }
  if (params.length === 0) return `${baseUrl}${normalisedPath}`;
  return `${baseUrl}${normalisedPath}?${params.join('&')}`;
}
