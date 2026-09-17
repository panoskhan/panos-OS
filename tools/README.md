# Tool Gateway

All external capabilities must be exposed through structured tool contracts.

## Initial tool families

- `workspace` — read/write project workspace
- `github` — repository and pull-request operations
- `web` — controlled web research
- `browser` — browser bridge for the KHAN extension

## Rules

1. Validate inputs before execution.
2. Check required permissions before execution.
3. Log the action and result.
4. Return structured results.
5. Require approval for configured external or high-impact actions.
