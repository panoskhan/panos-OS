import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type {
  ApiError,
  AuditResponse,
  CreateTaskRequest,
  HealthResponse,
  StatusResponse,
  TaskEvent,
  TaskEventsResponse,
  TaskResponse
} from "../../../packages/contracts/src/api";
import type { TaskStatus } from "../../../packages/contracts/src/task";
import { PLAN_AGENTS } from "../../../agents/planner/src/index";
import { verifyIndependentQa } from "../../../agents/qa/src/index";
import {
  InvalidTaskStateError,
  KhanOrchestrator,
  TaskNotFoundError
} from "../../../services/orchestrator/src/orchestrator";
import { AuditLog, DEFAULT_PAGE_LIMIT, FileAuditSink, MAX_PAGE_LIMIT, type AuditQuery } from "../../../services/audit/src/index";
import { collectStatus } from "../../../services/status/src/index";

const PORT = Number(process.env.API_PORT ?? 3001);
const MAX_BODY_BYTES = 1024 * 1024;
const TASK_ROUTE = /^\/v1\/tasks\/([^/]+)(?:\/(approve|reject|cancel|events))?$/;
const DEFAULT_CORS_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
const DEFAULT_HEARTBEAT_MS = 15_000;
const SSE_RETRY_MS = 2_000;
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

export interface KhanApiServerOptions {
  /** Browser origins allowed to call the API. Defaults to API_CORS_ORIGINS or the Vite dev server. */
  corsOrigins?: string[];
  /** Interval between keep-alive comments on event streams. */
  heartbeatMs?: number;
  /** How long a browser waits before reconnecting a dropped event stream. */
  retryMs?: number;
  /** Clock in ms, used for uptime. Injectable so tests need no real waiting. */
  clock?: () => number;
}

const SERVICE_NAME = "khan-os-api";

function readVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, "../../../package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
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

interface EventStreamRequest {
  kind: "event-stream";
  taskId: string;
  /** Only events with a higher sequence number are sent (from the Last-Event-ID header). */
  afterSeq: number;
}

type RouteResult =
  | [status: number, payload: HealthResponse | StatusResponse | AuditResponse | TaskResponse | TaskEventsResponse]
  | EventStreamRequest;

const AUDIT_ORDERS = ["asc", "desc"] as const;

function badQuery(code: string, detail: string): HttpError {
  return new HttpError(400, code, detail);
}

function textParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  if (value === null) return undefined;
  if (!value.trim()) throw badQuery(`invalid_${name}`, `${name} must not be empty`);
  return value;
}

function timeParam(params: URLSearchParams, name: "since" | "until"): string | undefined {
  const value = textParam(params, name);
  if (value !== undefined && Number.isNaN(Date.parse(value))) throw badQuery(`invalid_${name}`, `${name} must be an ISO 8601 timestamp`);
  return value;
}

function auditQueryFrom(params: URLSearchParams): { query: AuditQuery; order: "asc" | "desc"; limit: number } {
  const order = (params.get("order") ?? "desc") as (typeof AUDIT_ORDERS)[number];
  if (!AUDIT_ORDERS.includes(order)) throw badQuery("invalid_order", "order must be asc or desc");

  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!/^\d+$/.test(rawLimit ?? "1") || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw badQuery("invalid_limit", `limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}`);
  }

  const rawCursor = params.get("cursor");
  if (rawCursor !== null && (!/^\d+$/.test(rawCursor) || Number(rawCursor) < 1)) {
    throw badQuery("invalid_cursor", "cursor must be the nextCursor value from a previous page");
  }

  return {
    order,
    limit,
    query: {
      taskId: textParam(params, "taskId"),
      type: textParam(params, "type"),
      actor: textParam(params, "actor"),
      since: timeParam(params, "since"),
      until: timeParam(params, "until"),
      order,
      limit,
      cursor: rawCursor === null ? null : Number(rawCursor)
    }
  };
}

function readAudit(orchestrator: KhanOrchestrator, params: URLSearchParams): AuditResponse {
  const { query, order, limit } = auditQueryFrom(params);
  const { entries, nextCursor, total } = orchestrator.auditLog.query(query);
  return { entries, page: { order, limit, nextCursor: nextCursor === null ? null : String(nextCursor) }, total };
}

/** Records an attempt that was refused because of the task's state (approving a task that isn't waiting, and so on). */
function refusalAudited<T>(orchestrator: KhanOrchestrator, action: string, taskId: string, attempt: () => T): T {
  try {
    return attempt();
  } catch (error) {
    if (error instanceof InvalidTaskStateError) {
      orchestrator.auditLog.record({
        at: new Date().toISOString(),
        taskId,
        type: "request.refused",
        actor: "anonymous",
        data: { action, taskStatus: error.status, reason: error.message }
      });
    }
    throw error;
  }
}

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

function wantsEventStream(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("text/event-stream");
}

function lastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  const seq = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

/**
 * The last event a task emits. Completion and failure end with their own event, which follows the status change,
 * so the stream must not close on the status change itself. A cancel emits its own event first, so it ends on the
 * status change.
 */
function isTerminalEvent(event: TaskEvent): boolean {
  if (event.type === "task.completed" || event.type === "task.failed") return true;
  return event.type === "task.status_changed" && event.data.to === "cancelled";
}

/**
 * Streams a task's events as Server-Sent Events: replays events after `afterSeq`, then sends
 * new ones live. Each event's `id` is its sequence number, so a reconnecting EventSource resumes
 * via Last-Event-ID. Once the task reaches a terminal status the server sends `event: end` and
 * closes, which tells the client to stop reconnecting.
 */
function streamTaskEvents(
  orchestrator: KhanOrchestrator,
  res: ServerResponse,
  { taskId, afterSeq }: EventStreamRequest,
  cors: Record<string, string>,
  heartbeatMs: number,
  retryMs: number
): void {
  res.writeHead(200, {
    ...cors,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`retry: ${retryMs}\n\n`);

  let lastSentSeq = afterSeq;
  let closed = false;
  let unsubscribe = () => {};
  let heartbeat: NodeJS.Timeout | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    res.end();
  };
  const end = () => {
    if (closed) return;
    res.write("event: end\ndata: {}\n\n");
    close();
  };
  const sendEvent = (event: TaskEvent) => {
    if (closed || event.seq <= lastSentSeq) return;
    lastSentSeq = event.seq;
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    if (isTerminalEvent(event)) end();
  };

  // Subscribe before replaying so no event can fall between the history and the live feed;
  // the sequence check drops anything already sent.
  unsubscribe = orchestrator.subscribe(taskId, sendEvent);
  heartbeat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
  res.on("close", close);

  for (const event of orchestrator.events(taskId)) sendEvent(event);
  if (TERMINAL_STATUSES.has(orchestrator.get(taskId).task.status)) end();
}

async function route(
  orchestrator: KhanOrchestrator,
  req: IncomingMessage,
  status: () => StatusResponse
): Promise<RouteResult> {
  const method = req.method ?? "GET";
  const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/v1/audit") {
    if (method !== "GET") throw methodNotAllowed(["GET"]);
    return [200, readAudit(orchestrator, searchParams)];
  }

  if (pathname === "/health") {
    if (method !== "GET") throw methodNotAllowed(["GET"]);
    return [200, { status: "ok", service: SERVICE_NAME }];
  }

  if (pathname === "/v1/status") {
    if (method !== "GET") throw methodNotAllowed(["GET"]);
    return [200, status()]; // always 200: a failing component shows as "degraded" in the body
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
    if (action === undefined) return [200, orchestrator.get(taskId)];

    if (!wantsEventStream(req)) return [200, { taskId, events: orchestrator.events(taskId) }];
    orchestrator.get(taskId); // Unknown tasks get a JSON 404 before any stream headers are sent.
    return { kind: "event-stream", taskId, afterSeq: lastEventId(req) };
  }

  if (method !== "POST") throw methodNotAllowed(["POST"]);
  const body = await readJsonBody(req);
  switch (action) {
    case "approve": {
      const reason = parseReason(body);
      return [202, refusalAudited(orchestrator, "approve", taskId, () => orchestrator.approve(taskId, reason))];
    }
    case "reject": {
      const reason = parseReason(body);
      return [200, refusalAudited(orchestrator, "reject", taskId, () => orchestrator.reject(taskId, reason))];
    }
    case "cancel": {
      const reason = parseReason(body);
      return [200, refusalAudited(orchestrator, "cancel", taskId, () => orchestrator.cancel(taskId, reason))];
    }
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
  {
    corsOrigins = corsOriginsFromEnv(),
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    retryMs = SSE_RETRY_MS,
    clock = Date.now
  }: KhanApiServerOptions = {}
) {
  const allowedOrigins = new Set(corsOrigins);
  const version = readVersion();
  const startedAt = clock();
  const status = () =>
    collectStatus({
      service: SERVICE_NAME,
      version,
      startedAt,
      now: clock,
      diagnostics: () => orchestrator.diagnostics(),
      planAgents: PLAN_AGENTS,
      verify: verifyIndependentQa
    });
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

    route(orchestrator, req, status).then(
      (result) => {
        if ("kind" in result) streamTaskEvents(orchestrator, res, result, cors, heartbeatMs, retryMs);
        else send(res, result[0], result[1], cors);
      },
      (error: unknown) => {
        const { status, body, headers } = toError(error);
        send(res, status, body, { ...cors, ...headers });
      }
    );
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("apps/api/src/index.ts")) {
  // Run as a server, the audit log is kept in a file (git-ignored data/ folder unless KHAN_AUDIT_FILE says otherwise).
  const auditFile = process.env.KHAN_AUDIT_FILE ?? join(process.cwd(), "data", "audit.jsonl");
  const audit = new AuditLog(new FileAuditSink(auditFile));
  const orchestrator = new KhanOrchestrator(undefined, undefined, undefined, undefined, audit);
  createKhanApiServer(orchestrator).listen(PORT, "127.0.0.1", () => {
    const health = audit.health();
    console.log(`KHAN OS API: http://127.0.0.1:${PORT}`);
    console.log(`Audit log: ${auditFile} (${health.entries} entries, chain ${health.integrity.ok ? "intact" : `BROKEN at entry ${health.integrity.brokenAt}`})`);
  });
}
