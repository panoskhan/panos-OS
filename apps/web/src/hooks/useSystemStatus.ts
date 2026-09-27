import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusResponse } from "../../../../packages/contracts/src/api";
import { ApiRequestError, api, type KhanApiClient } from "../lib/api";

/**
 * checking  no answer yet
 * online    the API answered; `report.status` says whether every component passed its self-test
 * offline   the API did not answer
 */
export type ApiState = "checking" | "online" | "offline";

export interface SystemStatus {
  state: ApiState;
  /** The last answer from GET /v1/status. Null until one arrives and while the API is unreachable. */
  report: StatusResponse | null;
}

export const STATUS_INTERVAL_MS = 5000;

/**
 * Checks GET /v1/status every 5 seconds. `recheckWhen` is any value that changes when the live task
 * connection has trouble (a dropped stream, a failed read): each change checks again straight away,
 * so a dead API shows as offline within about a second instead of at the next tick.
 */
export function useSystemStatus(recheckWhen: unknown, client: KhanApiClient = api): SystemStatus {
  const [status, setStatus] = useState<SystemStatus>({ state: "checking", report: null });
  const inFlight = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);

  const check = useCallback(async () => {
    if (inFlight.current) {
      again.current = true; // something changed while a check was running: run one more when it ends
      return;
    }
    inFlight.current = true;
    try {
      const report = await client.getStatus();
      if (alive.current) setStatus({ state: "online", report });
    } catch (error) {
      // A 429 means the API is alive and asking us to slow down: keep what we last knew instead of showing it offline.
      const rateLimited = error instanceof ApiRequestError && error.status === 429;
      if (alive.current && !rateLimited) setStatus({ state: "offline", report: null });
    } finally {
      inFlight.current = false;
      if (again.current && alive.current) {
        again.current = false;
        void check();
      }
    }
  }, [client]);

  useEffect(() => {
    alive.current = true;
    void check();
    const timer = setInterval(() => void check(), STATUS_INTERVAL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [check]);

  useEffect(() => {
    void check();
  }, [check, recheckWhen]);

  return status;
}
