# KHAN OS

KHAN OS is a modular personal AI orchestration platform. You give it a goal; it plans a task graph, runs the steps
through permission-gated agents, stops for your approval before anything protected, has an independent QA step verify
the result, and records every decision in a tamper-evident audit log.

**Understand → Plan → Act → Verify**, with a human decision in front of any consequential action.

> Status: the first vertical slice works end to end (API, live web UI, approval loop, audit log, auth, rate limiting).
> The agents are **stubs** unless `NVIDIA_API_KEY` is set; with it, the coding agent is backed by a real model that
> proposes but does not change files. QA is still rule-based, and nothing touches GitHub or your files yet.
> See [Known limitations](#known-limitations).

## Run it

Needs Node 22 or newer.

```bash
npm install
npm run demo        # terminal 1: the API on http://127.0.0.1:3001 (auth ON with a demo key, each step takes 600 ms)
npm run web:demo    # terminal 2: the web UI on http://127.0.0.1:5173 (sends the same demo key)
```

Open http://127.0.0.1:5173, pick **GitHub approval**, press **Run KHAN**, and approve when the panel appears.

Without auth, for plain local development:

```bash
npm run api         # the API, auth OFF, steps finish instantly
npm run web:dev     # the web UI, no key
```

| Script | What it does |
|---|---|
| `npm run demo` | API in demo mode: `KHAN_API_KEYS=demo:khan-demo-key` and `KHAN_STUB_STEP_DELAY_MS=600` (from `apps/api/demo.env`) |
| `npm run web:demo` | Web UI that sends the demo key (`apps/web/.env.demo`) |
| `npm run api` / `npm run web:dev` | API / web UI with no auth and no delay |
| `npm test` | The whole test suite (Node's test runner; loads `tests/test.env` so rate limits are off and no keys are needed) |
| `npm run build` | Type-checks the backend and the web app |
| `npm run web:build` | Production build of the web app |
| `npm run cli` | Runs one goal through the orchestrator and prints the JSON report |

Try the API from a shell (bash):

```bash
KEY=khan-demo-key
curl -s -X POST http://127.0.0.1:3001/v1/tasks -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"goal":"Implement the fix and push the changes to GitHub."}'
# → 201, task in "executing". Then: GET /v1/tasks/<id>  (it will reach "waiting_approval")
curl -s -X POST http://127.0.0.1:3001/v1/tasks/<id>/approve -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" -d '{"reason":"Reviewed the diff"}'
curl -s "http://127.0.0.1:3001/v1/audit?taskId=<id>&order=asc" -H "Authorization: Bearer $KEY"
```

## API

The server listens on `127.0.0.1` only (`API_PORT`, default 3001). All bodies are JSON.

| Method and path | What it does | Success |
|---|---|---|
| `GET /health` | Liveness. Always open. | 200 `{"status":"ok","service":"khan-os-api"}` |
| `POST /v1/tasks` | Create a task from `{ "goal", "projectId"? }`. It runs in the background. | 201, task in `executing` |
| `GET /v1/tasks/:id` | The task: `{ task, plan, execution, verification }`. A step being worked on shows as `running`. | 200 |
| `POST /v1/tasks/:id/approve` | Approve the step waiting for approval, with an optional `{ "reason" }`. Execution resumes. | 202 |
| `POST /v1/tasks/:id/reject` | Reject it, optional `{ "reason" }`. The task fails. | 200 |
| `POST /v1/tasks/:id/cancel` | Cancel the task, optional `{ "reason" }`. A step already running finishes; nothing further starts. | 200 |
| `GET /v1/tasks/:id/events` | The task's event log as JSON `{ taskId, events }`, **or a live Server-Sent Events stream** when the request has `Accept: text/event-stream`. | 200 |
| `GET /v1/audit` | The audit log, with filters and paging (below). | 200 |
| `GET /v1/status` | Self-test results for every component (below). Always open. | 200 |

Errors are `{ "error": "<code>", "detail"?: "…" }`: `400` bad input, `401` `unauthorized`, `404` unknown task or path,
`405` wrong method, `409` `invalid_task_state` (for example approving a task that is not waiting), `413` body over 1 MB,
`429` `rate_limited`.

A task moves through `received → understanding → planning → executing → verifying → completed`, with
`waiting_approval` whenever a step needs a decision, and `failed` or `cancelled` as other endings.

**Event stream.** Each event has a sequence number `id`; a reconnecting `EventSource` resumes from `Last-Event-ID`. The
stream replays history, then follows live, and ends with `event: end` after the task's last event (`task.completed`,
`task.failed`, or the cancel), so the browser stops reconnecting. It stays open while a task waits for approval.

## Auth

API-key authentication, **off by default** for local development.

- **Turn it on:** set `KHAN_API_KEYS` to comma-separated `name:key` pairs, for example
  `KHAN_API_KEYS=admin:secret123,ops:another-key`. A key may contain colons but not spaces.
- **Use it:** send `Authorization: Bearer <key>` on every request.
- **Open endpoints:** `GET /health` and `GET /v1/status` never need a key (they must always answer). CORS preflights
  need none either.
- **Refused:** a missing or wrong key gets `401` with exactly `{"error":"unauthorized"}`. Unknown paths get `401` too, so
  a caller without a key cannot tell what exists.
- **Event stream:** a browser's `EventSource` cannot set headers, so `GET /v1/tasks/:id/events` (and only that
  endpoint) also accepts the key as `?token=<key>`. Everywhere else the key in the URL is ignored.
- **The actor:** the key's name is recorded in the audit log as the actor for creating, approving, rejecting and
  cancelling a task, and on refused attempts. The orchestrator's own decisions are `system`; with auth off, requests
  are `anonymous`. The names `system` and `anonymous` are reserved and cannot be used for a key.
- **Web UI:** reads `VITE_API_KEY` and sends it as the Bearer header, and as `?token=` on the event stream.
- **A malformed `KHAN_API_KEYS` stops the server from starting** (it never silently runs without auth), and errors never
  print a key. Keys are compared as SHA-256 digests in constant time.

**Every valid key has full access.** The name is a label, not a role: a key called `readonly` is not read-only.

## Rate limiting

A token bucket per client (its address) and per key, per request class. A bucket starts full and refills continuously.

| Class | Applies to | Default | Variable |
|---|---|---|---|
| Task creation | `POST /v1/tasks` | 10 / minute | `KHAN_RATE_LIMIT_TASKS` |
| Audit reads | `GET /v1/audit` | 20 / minute | `KHAN_RATE_LIMIT_AUDIT` |
| Everything else | reads, approve/reject/cancel, the event stream, `/health`, `/v1/status`, unknown paths | 60 / minute | `KHAN_RATE_LIMIT_READ` |

Set a variable to `0` to turn that limit off. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset` (Unix seconds when the bucket is full again). A refused request gets `429`, a `Retry-After` header
(seconds) and `{"error":"rate_limited","retryAfterMs":N}`. The limit is checked before authentication, so guessing keys
is limited too. Only the socket's address is trusted, never `X-Forwarded-For`.

## Audit log

An append-only record of every decision, kept in `data/audit.jsonl` (git-ignored; override with `KHAN_AUDIT_FILE`), one
JSON entry per line.

- **What is recorded:** every task event, including `permission.decided` (allowed / needs approval / denied, before the
  step runs), `qa.verdict`, `task.completed` and `task.failed` (with the stage it failed at), plus refused attempts
  (`request.refused`). Each entry has the `actor`.
- **Tamper evidence:** each entry stores the SHA-256 of the previous one. Editing, removing or reordering an entry breaks
  the chain from that point, and the server reports where. The chain is checked when the server starts and reported by
  `/v1/status`.
- **A failing disk never stops a task.** Entries stay readable from memory, are held, and are written in order once the
  disk recovers.
- **Read it:** `GET /v1/audit?taskId=&type=&actor=&since=&until=&order=desc&cursor=&limit=100` returns
  `{ entries, page: { order, limit, nextCursor }, total }`. Paging is by cursor (the id of the last entry you received);
  `limit` is 1 to 500; `order` is `desc` (newest first, the default) or `asc`.

## Status

`GET /v1/status` self-tests the live components and always answers `200`; `status` is `degraded` when any component is
`down`. A component is `up` (its self-test passed), `down`, or `not_configured` (it exists in the design but nothing
uses it yet, which never counts as degraded).

| Component | What is checked |
|---|---|
| Orchestrator | Uptime and live task counts |
| Model Router | `not_configured` without `NVIDIA_API_KEY`, and until a real call has succeeded; `up` after a successful call; `down` if the last call failed. It never calls the model itself, so checking status costs nothing (the server makes one tiny call at startup) |
| Agents | Every agent a plan can name has a handler |
| Permissions | The live engine allows reads, gates `github.write` behind approval, and denies unknown permissions |
| Independent QA | Accepts a valid result, rejects a failed one and one that ignores the goal |
| Audit Log | Entry count, whether the file is writable, and that the hash chain is intact (`not_configured` if only in memory) |
| Rate Limiter | Its configuration, how many requests it has refused, and a self-test of the bucket logic |

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `API_PORT` | API port | `3001` |
| `API_CORS_ORIGINS` | Browser origins allowed to call the API (comma-separated) | the Vite dev server |
| `KHAN_API_KEYS` | `name:key` pairs; unset means auth is off | unset |
| `KHAN_RATE_LIMIT_TASKS` / `_READ` / `_AUDIT` | Requests per minute; `0` disables | `10` / `60` / `20` |
| `KHAN_AUDIT_FILE` | Audit log path | `data/audit.jsonl` |
| `KHAN_TASKS_FILE` | Where tasks are kept between restarts | `data/tasks.json` |
| `NVIDIA_API_KEY` | Key for the model endpoint. Put it in `.env` (git-ignored, see `.env.example`), never in chat or in code. Unset means agent steps are stubs | unset |
| `KHAN_MODEL` / `KHAN_MODEL_BASE_URL` / `KHAN_MODEL_TIMEOUT_MS` | Model, OpenAI-compatible endpoint, and per-call timeout | `google/gemma-4-31b-it` / `https://integrate.api.nvidia.com/v1` / `180000` |
| `KHAN_STUB_STEP_DELAY_MS` | **Stub timing only:** makes the stub agents wait per step so progress is visible in demos | `0` |
| `VITE_API_URL` | API address the web app calls | `http://127.0.0.1:3001` |
| `VITE_API_KEY` | Key the web app sends | none |

## What is in the repo

- `apps/api`: the HTTP API (`node:http`, no framework).
- `apps/web`: the React and Vite web UI: orbital view, live execution graph and activity log, approval panel, recent
  tasks, system status. It follows a task over the event stream and falls back to polling if the stream fails.
- `apps/cli`: runs one goal and prints the report.
- `services/orchestrator`: task state machine, planning, the background execution loop, approvals, the event log.
- `services/agents`: the agent runtime (permission check, then the handler).
- `services/permissions`: the permission policy and engine.
- `services/status`, `services/audit`, `services/rate-limit`, `services/auth`: the four pieces described above.
- `services/model-router`: `client.ts` is the real model client (OpenAI-compatible chat, timeouts, typed errors, health);
  `router.ts` is an unused capability-routing function, kept for when more than one model exists.
- `agents/`: planner, coding and QA agents. With a key, the coding agent is backed by the model
  (`agents/coding/src/model-handler.ts`).
- `packages/contracts`: the shared types, used by both the API and the web app.
- `tests/`: unit, integration and real-HTTP tests (real servers, real `EventSource`).

Planned but not built: `apps/extension` (browser bridge), `services/memory`, `services/verification`, `tools/`. The
long-term data direction (PostgreSQL, pgvector, Redis) is in `docs/ARCHITECTURE.md`.

## Known limitations

- **Without a key the agents are stubs; with one they only propose.** The model-backed coding agent reasons about each
  step and its first finding says "no files were changed and no tests were run". Nothing writes files, runs tests or
  touches GitHub; approving a "push to GitHub" task only marks the step done.
- **Tasks are kept in `data/tasks.json`,** rewritten whole after every event (fine for one local server, not for
  thousands of tasks). A task that was mid-execution when the server stopped is marked failed ("interrupted"); one
  waiting for approval can still be approved after a restart. There is no cleanup of old tasks.
- **Keys have no roles** and there is no key rotation or revocation short of restarting with a new `KHAN_API_KEYS`.
  Failed logins are rate limited but not written to the audit log.
- **No TLS.** The API speaks plain HTTP on localhost. `?token=` puts the key in a URL, so do not expose the API beyond
  localhost without a TLS-terminating proxy that does not log query strings.
- **Audit log limits:** the hash chain cannot detect entries cut off the very end (that needs the latest hash kept
  somewhere else), and writes are not `fsync`ed, so a power loss can lose the last entries.
- **Rate limits are per process and in memory,** and counted per client address. The 60/minute default for reads is
  tight for a busy browser tab (each live event triggers a re-read); raise `KHAN_RATE_LIMIT_READ` if you see 429s.
- A step that is already running cannot be interrupted by cancel; it finishes and is recorded.
- The "Projects / Agents / Model Router / Permissions / Settings" screens are not built.

## Development principle

Build → QA → Publish → Verify → Fix → Next. Consequential external actions pass through explicit permission and approval
gates.

CI runs `npm install`, `npm run build` and `npm test` on every pull request, and a check that the required
architecture files exist (`.github/workflows/ci.yml`).
