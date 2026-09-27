/// <reference types="vite/client" />
import type {
  ApiError,
  AuditResponse,
  CreateTaskRequest,
  HealthResponse,
  StatusResponse,
  TaskEventsResponse,
  TaskResponse
} from "../../../../packages/contracts/src/api";

export const DEFAULT_API_URL = "http://127.0.0.1:3001";
export const UNAUTHORIZED_HINT = "the API needs a valid key: set VITE_API_KEY and reload";

/** Filters and paging for GET /v1/audit. `cursor` is the previous page's `nextCursor`. */
export interface AuditParams {
  taskId?: string;
  type?: string;
  actor?: string;
  since?: string;
  until?: string;
  order?: "asc" | "desc";
  cursor?: string;
  limit?: number;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    /** Only for 429: how long the API asked us to wait. */
    readonly retryAfterMs?: number
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ApiRequestError";
  }
}

export interface KhanApiClient {
  readonly baseUrl: string;
  health(): Promise<HealthResponse>;
  /** Self-test results for the system's components (GET /v1/status). */
  getStatus(): Promise<StatusResponse>;
  /** One page of the audit log (GET /v1/audit). */
  getAudit(params?: AuditParams): Promise<AuditResponse>;
  createTask(request: CreateTaskRequest): Promise<TaskResponse>;
  getTask(taskId: string): Promise<TaskResponse>;
  approveTask(taskId: string): Promise<TaskResponse>;
  rejectTask(taskId: string, reason?: string): Promise<TaskResponse>;
  cancelTask(taskId: string, reason?: string): Promise<TaskResponse>;
  getTaskEvents(taskId: string): Promise<TaskEventsResponse>;
  /** URL of the task's live event stream (open it with EventSource). */
  eventsUrl(taskId: string): string;
}

/**
 * `apiKey` is sent as `Authorization: Bearer <key>` on every request. The event stream cannot carry a header (a
 * browser's EventSource has no way to set one), so its URL gets `?token=<key>` instead.
 */
export function createApiClient(baseUrl: string = DEFAULT_API_URL, apiKey?: string): KhanApiClient {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(`${root}${path}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = payload as Partial<ApiError> | null;
      if (response.status === 429) {
        const headerSeconds = Number(response.headers.get("retry-after"));
        const retryAfterMs = error?.retryAfterMs ?? (Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds * 1000 : 1000);
        throw new ApiRequestError(429, "rate_limited", `too many requests, try again in ${Math.ceil(retryAfterMs / 1000)}s`, retryAfterMs);
      }
      if (response.status === 401) throw new ApiRequestError(401, "unauthorized", UNAUTHORIZED_HINT);
      throw new ApiRequestError(response.status, error?.error ?? `http_${response.status}`, error?.detail);
    }
    return payload as T;
  }

  const taskPath = (taskId: string) => `/v1/tasks/${encodeURIComponent(taskId)}`;
  const decision = (reason?: string) => (reason ? { reason } : undefined);

  return {
    baseUrl: root,
    health: () => request<HealthResponse>("GET", "/health"),
    getStatus: () => request<StatusResponse>("GET", "/v1/status"),
    getAudit: (params = {}) => {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(params)) if (value !== undefined) query.set(name, String(value));
      const suffix = query.size ? `?${query}` : "";
      return request<AuditResponse>("GET", `/v1/audit${suffix}`);
    },
    createTask: (body) => request<TaskResponse>("POST", "/v1/tasks", body),
    getTask: (taskId) => request<TaskResponse>("GET", taskPath(taskId)),
    approveTask: (taskId) => request<TaskResponse>("POST", `${taskPath(taskId)}/approve`),
    rejectTask: (taskId, reason) => request<TaskResponse>("POST", `${taskPath(taskId)}/reject`, decision(reason)),
    cancelTask: (taskId, reason) => request<TaskResponse>("POST", `${taskPath(taskId)}/cancel`, decision(reason)),
    getTaskEvents: (taskId) => request<TaskEventsResponse>("GET", `${taskPath(taskId)}/events`),
    eventsUrl: (taskId) => `${root}${taskPath(taskId)}/events${apiKey ? `?token=${encodeURIComponent(apiKey)}` : ""}`
  };
}

// `import.meta.env` only exists under Vite; Node (tests) falls back to the default.
export const api = createApiClient(import.meta.env?.VITE_API_URL || DEFAULT_API_URL, import.meta.env?.VITE_API_KEY || undefined);
