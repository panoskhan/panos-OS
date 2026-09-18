# KHAN OS

KHAN OS is a modular personal AI orchestration platform.

## Core workflow

**Understand → Plan → Research → Act → Test → Verify → Report**

## Architecture

- `apps/web` — KHAN OS web dashboard
- `apps/api` — API service
- `apps/extension` — browser client/bridge
- `services/orchestrator` — task planning and execution state
- `services/model-router` — model-agnostic routing
- `services/agent-runtime` — standardized agent execution
- `services/memory` — project and long-term memory
- `services/permissions` — least-privilege controls and approvals
- `services/verification` — independent validation
- `agents/` — specialized agents
- `tools/` — controlled external capabilities
- `packages/` — shared contracts and schemas
- `tests/` — unit, integration, agent and end-to-end tests

## MVP

The first vertical slice is:

**Project → Plan → Execute → Test → Report**

Initial agents:

- Planner
- Coding
- Files
- QA

Initial integrations:

- Local workspace
- GitHub

## Development principle

Build → QA → Publish → Verify → Fix → Next

Consequential external actions should pass through explicit permission/approval gates.

## GitHub Actions

The repository currently checks in its CI workflow at `.github/workflows/ci.yml`.

GitHub-managed automation entries that may appear under the Actions UI are not necessarily workflow source files committed to this repository.
