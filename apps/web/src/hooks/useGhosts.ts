import { useCallback, useEffect, useRef, useState } from "react";
import type { Ghost, GhostSchedule } from "../../../../packages/contracts/src/ghost";
import { ApiRequestError, api, type KhanApiClient } from "../lib/api";

/**
 * Ghosts fire on their own timers, so the roster is read back on a timer too. 2 s is short enough
 * that a fire count visibly ticks up while someone is watching, and the endpoint is a map read.
 */
export const GHOST_INTERVAL_MS = 2000;

export type GhostAction = "register" | "pause" | "resume" | "remove";

export interface GhostsState {
  ghosts: Ghost[];
  /** Null until the first answer arrives; an unreachable API leaves the last roster in place. */
  loaded: boolean;
  error: string | null;
  /** Which ghost is mid-request, so only that row's buttons go busy. */
  pendingId: string | null;
  pendingAction: GhostAction | null;
}

export interface GhostsApi extends GhostsState {
  register(goal: string, schedule: GhostSchedule): Promise<void>;
  pause(ghostId: string): Promise<void>;
  resume(ghostId: string): Promise<void>;
  remove(ghostId: string): Promise<void>;
  refresh(): Promise<void>;
}

export function useGhosts(client: KhanApiClient = api): GhostsApi {
  const [state, setState] = useState<GhostsState>({
    ghosts: [],
    loaded: false,
    error: null,
    pendingId: null,
    pendingAction: null
  });

  const inFlight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    // A poll that overlaps the previous one tells us nothing new; skip rather than queue.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { ghosts } = await client.getGhosts();
      if (alive.current) setState((s) => ({ ...s, ghosts, loaded: true, error: null }));
    } catch (error) {
      // A 429 means the API is alive and asking us to slow down: keep the roster we have.
      if (!alive.current || (error instanceof ApiRequestError && error.status === 429)) return;
      setState((s) => ({ ...s, loaded: true, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      inFlight.current = false;
    }
  }, [client]);

  /** Runs one mutation, then re-reads, so the row shows what the server now holds rather than a guess. */
  const act = useCallback(
    async (ghostId: string | null, action: GhostAction, run: () => Promise<unknown>) => {
      setState((s) => ({ ...s, pendingId: ghostId, pendingAction: action, error: null }));
      try {
        await run();
      } catch (error) {
        if (alive.current) {
          setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }));
        }
      } finally {
        if (alive.current) setState((s) => ({ ...s, pendingId: null, pendingAction: null }));
        // Re-read even after a failure: the registry is the authority on what actually changed.
        await refresh();
      }
    },
    [refresh]
  );

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), GHOST_INTERVAL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return {
    ...state,
    refresh,
    register: (goal, schedule) => act(null, "register", () => client.registerGhost(goal, schedule)),
    pause: (ghostId) => act(ghostId, "pause", () => client.pauseGhost(ghostId)),
    resume: (ghostId) => act(ghostId, "resume", () => client.resumeGhost(ghostId)),
    remove: (ghostId) => act(ghostId, "remove", () => client.removeGhost(ghostId))
  };
}
