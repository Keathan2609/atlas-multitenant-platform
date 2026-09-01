/**
 * The HTTP client.
 *
 * Every request the browser makes to the API goes through here, which is what
 * makes three things true in one place rather than fifteen:
 *
 *  - `credentials: 'include'` on every call, so the session cookie travels.
 *  - The CSRF token is read from its cookie and echoed on every mutating
 *    request. Client code never thinks about it.
 *  - The API's error envelope becomes a typed `ApiError`, so a caller can
 *    switch on `code` and read `details` for field errors instead of parsing
 *    a message.
 */

export interface ApiErrorDetail {
  field: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: ApiErrorDetail[];
  };
}

/**
 * A failed request, carrying enough for the UI to react precisely: the status
 * to decide between "not found" and "forbidden", the code for specific
 * handling, and details to attach errors to the fields that caused them.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details: ApiErrorDetail[];

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error.code;
    this.requestId = body.error.requestId;
    this.details = body.error.details ?? [];
  }

  /** The caller is signed out, or their session expired. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** The caller is signed in but their role does not permit this. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /**
   * Not found — which for a tenant-scoped resource also means "exists, but not
   * in an organization you belong to". The API deliberately does not
   * distinguish those, and neither does the UI.
   */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** Thrown when the API cannot be reached at all — distinct from an error response. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Could not reach the server.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const CSRF_COOKIE = 'atlas_csrf';
const CSRF_HEADER = 'x-csrf-token';

/**
 * Reads the CSRF token the API set alongside the session.
 *
 * This cookie is deliberately readable by script — that is the double-submit
 * mechanism, not an oversight. It carries no authority on its own; without the
 * httpOnly session cookie it grants nothing.
 */
function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Query parameters. Undefined and empty-string values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_URL}/api/v1${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';

  if (!SAFE_METHODS.has(method)) {
    const token = csrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      // Without this the session cookie is not sent and every request is
      // anonymous. It is the reason the API's CORS config lists explicit
      // origins rather than a wildcard.
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new NetworkError(cause);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    throw new ApiError(response.status, parsed as ApiErrorBody);
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    apiRequest<T>(path, {
      method: 'GET',
      ...(query ? { query } : {}),
      ...(signal ? { signal } : {}),
    }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'DELETE', ...(body !== undefined ? { body } : {}) }),
};

/**
 * Maps an ApiError's field details onto react-hook-form.
 *
 * Server validation is authoritative — the client schema exists for fast
 * feedback, not correctness — so a rejected submission must be able to put the
 * server's message on the exact field that produced it.
 */
export function applyFieldErrors(
  error: unknown,
  setError: (field: string, err: { type: string; message: string }) => void,
): boolean {
  if (!(error instanceof ApiError) || error.details.length === 0) return false;
  for (const detail of error.details) {
    setError(detail.field, { type: 'server', message: detail.message });
  }
  return true;
}
