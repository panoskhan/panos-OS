# Run Panos OS online

The Render blueprint runs the existing React app and API together over HTTPS. The browser calls the same site's `/v1` API, so it does not need localhost access or a bundled API secret.

1. Push this change to your GitHub repository.
2. In Render, create a Blueprint from `panoskhan/panos-OS` and select the branch containing `render.yaml`.
3. Set `SITE_PASSWORD` securely in Render to a unique password of at least 16 characters. Never put it in the repository or a `VITE_` variable.
4. Deploy, then open the HTTPS address Render assigns. Sign in with username **panos** and your password.

The blueprint enables a public demo: anyone can open the app, create simulated tasks, and follow their progress. Settings, audit access, approvals, cancellations, background automation, and other API routes require owner authentication. The demo hides settings and approval controls. The service still requires a suitable owner password at startup. Render supplies HTTPS; use the public service only through HTTPS. Set PUBLIC_DEMO=false and rebuild without VITE_PUBLIC_DEMO=true for the private interface.

This remains a prototype: agents simulate work and model integration is not configured. Every person with the site password shares full access. Tasks are held in memory. The free plan can sleep and its filesystem is ephemeral, so restarts lose task state and may lose audit/ghost files. For retained files, use a paid service with a persistent disk and set `KHAN_AUDIT_FILE` and `KHAN_GHOST_DIR` to that disk. Persistent storage does not make in-memory tasks durable.

## Verify a deployment

Confirm `/health` returns `{"status":"ok","service":"panos-os-online"}`. Opening `/` without credentials must prompt for a password. After signing in, the app should load system status and complete a read-only task. Check a task requiring approval pauses and resumes after your decision. The event stream must use the hosted site's `/v1/tasks/.../events` URL. Do not consider the deployment validated from the health check alone.

## Local deployment check

Use Node 22.22.0, then run `npm ci`, `npm run build`, and `VITE_API_URL=/ npm run web:build`. Set `SITE_PASSWORD` in the process environment and run `node --import tsx apps/web/src/online-server.ts`. This is a deployment check; the actual public URL is assigned by the host after deployment.
