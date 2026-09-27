import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  ApiError,
  CreateTaskRequest,
  HealthResponse,
  ProjectInfoResponse,
  TaskEvent,
  TaskEventsResponse,
  TaskResponse
} from "../../../packages/contracts/src/api";
import type { TaskStatus } from "../../../packages/contracts/src/task";
import {
  InvalidTaskStateError,
  KhanOrchestrator,
  TaskNotFoundError
} from "../../../services/orchestrator/src/orchestrator";

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
  | [status: number, payload: HealthResponse | TaskResponse | TaskEventsResponse | ProjectInfoResponse]
  | EventStreamRequest;

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

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  rb: "Ruby"
};

let cachedProjectInfo: ProjectInfoResponse | undefined;

function computeProjectInfo(): ProjectInfoResponse {
  const root = process.cwd();
  const git = (args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  let files: string[] = [];
  try {
    files = git(["ls-files"]).split("\n").filter(Boolean);
  } catch {
    files = [];
  }

  const extensionCounts = new Map<string, number>();
  for (const file of files) {
    const extension = /\.([a-zA-Z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
    if (!extension || !(extension in LANGUAGE_BY_EXTENSION)) continue;
    extensionCounts.set(extension, (extensionCounts.get(extension) ?? 0) + 1);
  }
  const topExtension = [...extensionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  let name = "khan-os";
  try {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { name?: string };
    if (pkg.name) name = pkg.name;
  } catch {
    // package.json missing or unreadable; keep the fallback name.
  }

  let lastUpdated: string | null = null;
  try {
    lastUpdated = git(["log", "-1", "--format=%cI"]) || null;
  } catch {
    lastUpdated = null;
  }

  return {
    name,
    fileCount: files.length,
    language: topExtension ? LANGUAGE_BY_EXTENSION[topExtension] : "Unknown",
    lastUpdated
  };
}

/** Computed once per process: the repository's file list and package name don't change while the server runs. */
function getProjectInfo(): ProjectInfoResponse {
  cachedProjectInfo ??= computeProjectInfo();
  return cachedProjectInfo;
}

function wantsEventStream(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("text/event-stream");
}

function lastEventId(req: IncomingMessage): number {
  const raw = req.headers["last-event-id"];
  const seq = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

function isTerminalEvent(event: TaskEvent): boolean {
  return event.type === "task.status_changed" && TERMINAL_STATUSES.has(event.data.to as TaskStatus);
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
  heartbeatMs: number
): void {
  res.writeHead(200, {
    ...cors,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(`retry: ${SSE_RETRY_MS}\n\n`);

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

async function route(orchestrator: KhanOrchestrator, req: IncomingMessage): Promise<RouteResult> {
  const method = req.method ?? "GET";
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === "/health") {
    if (method !== "GET") throw methodNotAllowed(["GET"]);
    return [200, { status: "ok", service: "khan-os-api" }];
  }

  if (pathname === "/v1/project") {
    if (method !== "GET") throw methodNotAllowed(["GET"]);
    return [200, getProjectInfo()];
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
    case "approve":
      asObject(body);
      return [202, orchestrator.approve(taskId)];
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
  { corsOrigins = corsOriginsFromEnv(), heartbeatMs = DEFAULT_HEARTBEAT_MS }: KhanApiServerOptions = {}
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
      (result) => {
        if ("kind" in result) streamTaskEvents(orchestrator, res, result, cors, heartbeatMs);
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
  createKhanApiServer().listen(PORT, "127.0.0.1", () => {
    console.log(`KHAN OS API: http://127.0.0.1:${PORT}`);
  });
}
