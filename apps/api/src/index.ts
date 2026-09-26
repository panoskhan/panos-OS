import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  ApiError,
  CreateTaskRequest,
  HealthResponse,
  TaskEventsResponse,
  TaskResponse
} from "../../../packages/contracts/src/api";
import {
  InvalidTaskStateError,
  KhanOrchestrator,
  TaskNotFoundError
} from "../../../services/orchestrator/src/orchestrator";

const PORT = Number(process.env.API_PORT ?? 3001);
const MAX_BODY_BYTES = 1024 * 1024;
const TASK_ROUTE = /^\/v1\/tasks\/([^/]+)(?:\/(approve|reject|cancel|events))?$/;
const DEFAULT_CORS_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

export interface KhanApiServerOptions {
  /** Browser origins allowed to call the API. Defaults to API_CORS_ORIGINS or the Vite dev server. */
  corsOrigins?: string[];
}

function corsOriginsFromEnv(): string[] {
  const configured = process.env.API_CORS_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean);
  return configured?.length ? configured : DEFAULT_CORS_ORIGINS;
}

function corsHeaders(origin: string | undefined, allowed: ReadonlySet<string>): Record<string, string> {
  if (!origin || !allowed.has(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(detail ?? code);
  }
}

type RouteResult = [status: number, payload: HealthResponse | TaskResponse | TaskEventsResponse];

function send(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function methodNotAllowed(allowed: string[]): HttpError {
  return new HttpError(405, "method_not_allowed", `Allowed: ${allowed.join(", ")}`, { Allow: allowed.join(", ") });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return reject(new HttpError(413, "payload_too_large", `Max ${MAX_BODY_BYTES} bytes`));
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function parseCreateTask(body: unknown): CreateTaskRequest {
  const { goal, projectId } = asObject(body);
  if (typeof goal !== "string" || !goal.trim()) throw new HttpError(400, "goal_required");
  if (projectId !== undefined && (typeof projectId !== "string" || !projectId.trim())) {
    throw new HttpError(400, "invalid_project_id", "projectId must be a non-empty string");
  }
  return { goal: goal.trim(), projectId: projectId?.trim() };
}

function parseReason(body: unknown): string | undefined {
  const { reason } = asObject(body);
  if (reason === undefined) return undefined;
  if (typeof reason !== "string") throw new HttpError(400, "invalid_reason", "reason must be a string");
  return reason.trim() || undefined;
}

function decodeTaskId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "invalid_task_id");
  }
}

async function route(orchestrator: KhanOrchestrator, req: IncomingMessage): Promise<RouteResult> {
  const method = req.method ?? "GET";
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/health") {
    if (method !== "GET") throw methodNotAllowed(["GET"]);
    return [200, { status: "ok", service: "khan-os-api" }];
  }

  if (pathname === "/v1/tasks") {
    if (method !== "POST") throw methodNotAllowed(["POST"]);
    const { goal, projectId } = parseCreateTask(await readJsonBody(req));
    return [201, orchestrator.start(goal, projectId)];
  }

  const match = TASK_ROUTE.exec(pathname);
  if (!match) throw new HttpError(404, "not_found");
  const taskId = decodeTaskId(match[1]);
  const action = match[2];

  if (action === undefined || action === "events") {
    if (method !== "GET") throw methodNotAllowed(["GET"]);
    return action === "events"
      ? [200, { taskId, events: orchestrator.events(taskId) }]
      : [200, orchestrator.get(taskId)];
  }

  if (method !== "POST") throw methodNotAllowed(["POST"]);
  const body = await readJsonBody(req);
  switch (action) {
    case "approve":
      asObject(body);
      return [200, orchestrator.approve(taskId)];
    case "reject":
      return [200, orchestrator.reject(taskId, parseReason(body))];
    case "cancel":
      return [200, orchestrator.cancel(taskId, parseReason(body))];
    default:
      throw new HttpError(404, "not_found");
  }
}

function toError(error: unknown): { status: number; body: ApiError; headers?: Record<string, string> } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.code, detail: error.detail }, headers: error.headers };
  }
  if (error instanceof TaskNotFoundError) {
    return { status: 404, body: { error: "task_not_found", detail: error.message } };
  }
  if (error instanceof InvalidTaskStateError) {
    return { status: 409, body: { error: "invalid_task_state", detail: error.message } };
  }
  return {
    status: 500,
    body: { error: "internal_error", detail: error instanceof Error ? error.message : String(error) }
  };
}

export function createKhanApiServer(
  orchestrator = new KhanOrchestrator(),
  { corsOrigins = corsOriginsFromEnv() }: KhanApiServerOptions = {}
) {
  const allowedOrigins = new Set(corsOrigins);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const cors = corsHeaders(req.headers.origin, allowedOrigins);
    if (req.method === "OPTIONS") {
      const preflight = Object.keys(cors).length
        ? { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" }
        : {};
      res.writeHead(204, preflight);
      res.end();
      return;
    }

    route(orchestrator, req).then(
      ([status, payload]) => send(res, status, payload, cors),
      (error: unknown) => {
        const { status, body, headers } = toError(error);
        send(res, status, body, { ...cors, ...headers });
      }
    );
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("apps/api/src/index.ts")) {
  createKhanApiServer().listen(PORT, "127.0.0.1", () => {
    console.log(`KHAN OS API: http://127.0.0.1:${PORT}`);
  });
}
