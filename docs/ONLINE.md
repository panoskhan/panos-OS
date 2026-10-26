# Run Panos OS online

The Render blueprint runs the existing React app and API together over HTTPS. The browser calls the same site's `/v1` API, so it does not need localhost access or a bundled API secret.

1. Push this change to your GitHub repository.
2. In Render, create a Blueprint from `panoskhan/panos-OS` and select the branch containing `render.yaml`.
3. Set `SITE_PASSWORD` securely in Render to a unique password of at least 16 characters. Never put it in the repository or a `VITE_` variable.
4. Deploy, then open the HTTPS address Render assigns. Sign in with username **panos** and your password.

The blueprint enables a public demo: anyone can open the app, create simulated tasks, and follow their progress. Settings, audit access, approvals, cancellations, background automation, and other API routes require owner authentication. The demo hides settings and approval controls. The service still requires a suitable owner password at startup. Render supplies HTTPS; use the public service only through HTTPS. Set PUBLIC_DEMO=false and rebuild without VITE_PUBLIC_DEMO=true for the private interface.

This remains a prototype: agents simulate work and model integration is not configured. Every person with the site password shares full access. Tasks are held in memory. The free plan can sleep and its filesystem is ephemeral, so restarts lose task state and may lose audit/ghost files. For retained files, use a paid service with a persistent disk and set `KHAN_AUDIT_FILE` and `KHAN_GHOST_DIR` to that disk. Persistent storage does not make in-memory tasks durable.

## Verify a deployment

Public visitors receive an HttpOnly session cookie when opening the homepage or making their first allowed API request. Each session uses its own in-memory orchestrator, task store and audit log, so another visitor cannot read a task or its event stream even with its task ID. Sessions expire after one hour and are lost on restart; remembered browser history drops unavailable tasks. The demo admits up to 500 simultaneous sessions. Guided walkthrough buttons start analysis, testing, or an approval-gated demonstration without enabling protected actions.

Confirm `/health` returns `{"status":"ok","service":"panos-os-online"}`. Opening `/` without credentials must prompt for a password. After signing in, the app should load system status and complete a read-only task. Check a task requiring approval pauses and resumes after your decision. The event stream must use the hosted site's `/v1/tasks/.../events` URL. Do not consider the deployment validated from the health check alone.

## Local deployment check

## Owner workspace

Public demo resources are bounded independently of visitor cookies: a server-wide
budget admits 60 new sessions and 60 task submissions per minute, and each session
allows at most 20 task submissions over its one-hour lifetime. Excess requests
receive HTTP 429 with Retry-After. Existing visitors can still read results and
the owner dashboard and health checks remain accessible. These limits protect
the demo's temporary memory; they do not turn it into a multi-user AI service.

Open `/owner` and sign in as `panos` with the password in Render's SITE_PASSWORD variable. The dashboard lets you create projects, upload text files, inspect files and saved suggested diffs, run private tasks, review approvals, configure a NVIDIA model key, disable AI, set a daily call limit, and export project backups. Public demo sessions cannot access these endpoints, owner tasks, API keys, or uploaded files. Uploads are data, never executed; suggestions are proposals and never automatically applied.

Private AI starts disabled. Enter your own NVIDIA API key securely in the owner dashboard, choose a model, set the daily limit, and enable it. Keys are retained server-side in a mode-0600 owner data file and excluded from API responses and project backups. This private AI client uses NVIDIA's OpenAI-compatible endpoint. One logical call runs at a time, outputs are capped at 2048 tokens, and failed calls consume the limit. Existing provider retry behavior can cause multiple provider requests per logical call. Costs are owner-entered estimates only; actual costs and token usage must be checked with the provider. Without a configured key, no live-model behavior has been verified.

Owner projects, suggestions, settings, usage counters, audit entries, and task state are stored under KHAN_DATA_DIR (default data/). Public sessions remain temporary. File persistence survives process restarts on the same filesystem; durability across Render redeploys requires a persistent disk. Export project backups before moving to a disk: changing the data directory does not automatically migrate files or keys.

On Render Free, use Export all projects before redeploying, then Import project backup to restore missing projects. Imports validate the entire file before saving, preserve existing project IDs, and never replace model settings or reset usage counters. The import limit is 10 MB; use Export this project for larger collections. API keys must be retained separately and re-entered after ephemeral storage is lost. Private task history is not included in project backups. Use Test connection after saving and enabling AI; it sends one small real model request, consumes the daily limit, and may incur provider charges. A saved key is not evidence of successful connectivity.

`render.persistent.yaml` is the prepared paid alternative: a Starter service with a 1 GB disk mounted at /var/data, and KHAN_DATA_DIR=/var/data. It has not been enabled automatically. Review Render's current service and disk charges before switching a Blueprint path or adding the disk to the existing service. The Free blueprint stays unchanged. Do not create a second service just to add storage. The backup downloads projects and usage, not API keys or private tasks; retain keys separately in your password manager.

Use Node 22.22.0, then run `npm ci`, `npm run build`, and `VITE_API_URL=/ npm run web:build`. Set `SITE_PASSWORD` in the process environment and run `node --import tsx apps/web/src/online-server.ts`. This is a deployment check; the actual public URL is assigned by the host after deployment.
