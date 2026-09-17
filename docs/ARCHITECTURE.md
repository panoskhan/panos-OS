# KHAN OS Architecture

## System layers

1. Interface
2. Identity and authorization
3. Orchestrator
4. Model Router
5. Agent Runtime
6. Memory
7. Tool Gateway
8. Permission Engine
9. Verification
10. Observability

## Execution lifecycle

```text
RECEIVED
  ↓
UNDERSTANDING
  ↓
PLANNING
  ↓
PERMISSION CHECK
  ↓
EXECUTING
  ↓
VERIFYING
  ↓
COMPLETED
```

Failure path:

```text
EXECUTING → FAILED → DIAGNOSE → REPLAN → EXECUTING
```

## Safety boundary

Agents never receive unrestricted access. Tools are exposed through structured contracts and checked by the permission engine.

## MVP vertical slice

```text
User request
   ↓
Planner
   ↓
Task graph
   ↓
Coding / Files agents
   ↓
Tool gateway
   ↓
QA
   ↓
Report
```

## Future integrations

- KHAN Chrome Extension
- GitHub
- Web research
- Document processing
- Voice
- Vision
- iPhone / Apple App Intents

## Data model direction

PostgreSQL is the primary relational store. pgvector can support semantic memory. Redis can support queues, caching and transient execution state.
