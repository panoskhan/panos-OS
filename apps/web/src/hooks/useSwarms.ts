import { useCallback, useEffect, useRef, useState } from "react";
import type { Swarm, SwarmReport } from "../../../../packages/contracts/src/swarm";
import { ApiRequestError, api, type KhanApiClient } from "../lib/api";

/**
 * Swarms are running in the background so we poll to see contender progress.
 * 2 s keeps the scoreboard live while someone is watching without hammering the API.
 */
export const SWARM_INTERVAL_MS = 2000;

export type SwarmAction = "launch";

export interface SwarmsState {
  swarms: Swarm[];
  /** Null until the first answer arrives. */
  loaded: boolean;
  error: string | null;
  /** True while a launch is in flight. */
  launching: boolean;
}

export interface SwarmsApi extends SwarmsState {
  launch(problem: string, size?: number): Promise<void>;
  refresh(): Promise<void>;
}

export function useSwarms(client: KhanApiClient = api): SwarmsApi {
  const [state, setState] = useState<SwarmsState>({
    swarms: [],
    loaded: false,
    error: null,
    launching: false
  });

  const inFlight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { swarms } = await client.getSwarms();
      if (alive.current) setState((s) => ({ ...s, swarms, loaded: true, error: null }));
    } catch (error) {
      if (!alive.current || (error instanceof ApiRequestError && error.status === 429)) return;
      setState((s) => ({ ...s, loaded: true, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      inFlight.current = false;
    }
  }, [client]);

  const launch = useCallback(
    async (problem: string, size?: number) => {
      setState((s) => ({ ...s, launching: true, error: null }));
      try {
        await client.launchSwarm(problem, size);
      } catch (error) {
        if (alive.current) {
          setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }));
        }
      } finally {
        if (alive.current) setState((s) => ({ ...s, launching: false }));
        await refresh();
      }
    },
    [client, refresh]
  );

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), SWARM_INTERVAL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return { ...state, launch, refresh };
}
