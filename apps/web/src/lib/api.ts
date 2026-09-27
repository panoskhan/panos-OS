/// <reference types="vite/client" />
import type {
  ApiError,
  CreateTaskRequest,
  HealthResponse,
  ProjectInfoResponse,
  TaskEventsResponse,
  TaskResponse
} from "../../../../packages/contracts/src/api";

export const DEFAULT_API_URL = "http://127.0.0.1:3001";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ApiRequestError";
  }
}

export interface KhanApiClient {
  readonly baseUrl: string;
  health(): Promise<HealthResponse>;
  createTask(request: CreateTaskRequest): Promise<TaskResponse>;
  getTask(taskId: string): Promise<TaskResponse>;
  approveTask(taskId: string): Promise<TaskResponse>;
  rejectTask(taskId: string, reason?: string): Promise<TaskResponse>;
  cancelTask(taskId: string, reason?: string): Promise<TaskResponse>;
  getTaskEvents(taskId: string): Promise<TaskEventsResponse>;
  getProjectInfo(): Promise<ProjectInfoResponse>;
}

export function createApiClient(baseUrl: string = DEFAULT_API_URL): KhanApiClient {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = payload as Partial<ApiError> | null;
      throw new ApiRequestError(response.status, error?.error ?? `http_${response.status}`, error?.detail);
    }
    return payload as T;
  }

  const taskPath = (taskId: string) => `/v1/tasks/${encodeURIComponent(taskId)}`;
  const decision = (reason?: string) => (reason ? { reason } : undefined);

  return {
    baseUrl: root,
    health: () => request<HealthResponse>("GET", "/health"),
    createTask: (body) => request<TaskResponse>("POST", "/v1/tasks", body),
    getTask: (taskId) => request<TaskResponse>("GET", taskPath(taskId)),
    approveTask: (taskId) => request<TaskResponse>("POST", `${taskPath(taskId)}/approve`),
    rejectTask: (taskId, reason) => request<TaskResponse>("POST", `${taskPath(taskId)}/reject`, decision(reason)),
    cancelTask: (taskId, reason) => request<TaskResponse>("POST", `${taskPath(taskId)}/cancel`, decision(reason)),
    getTaskEvents: (taskId) => request<TaskEventsResponse>("GET", `${taskPath(taskId)}/events`),
    getProjectInfo: () => request<ProjectInfoResponse>("GET", "/v1/project")
  };
}

// `import.meta.env` only exists under Vite; Node (tests) falls back to the default.
export const api = createApiClient(import.meta.env?.VITE_API_URL || DEFAULT_API_URL);
