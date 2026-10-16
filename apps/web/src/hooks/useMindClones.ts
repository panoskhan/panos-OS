import { useCallback, useEffect, useRef, useState } from "react";
import type { MindClone, MindCloneReport } from "../../../../packages/contracts/src/mindclone";
import { ApiRequestError, api, type KhanApiClient } from "../lib/api";

export const MINDCLONE_INTERVAL_MS = 5000;

export interface MindClonesState {
  clones: MindClone[];
  loaded: boolean;
  error: string | null;
  training: boolean;
  /** id of the clone currently being archived */
  pendingId: string | null;
}

export interface MindClonesApi extends MindClonesState {
  train(name: string, sources: { label: string; content: string }[]): Promise<MindCloneReport | null>;
  archive(cloneId: string): Promise<void>;
  refresh(): Promise<void>;
}

export function useMindClones(client: KhanApiClient = api): MindClonesApi {
  const [state, setState] = useState<MindClonesState>({
    clones: [],
    loaded: false,
    error: null,
    training: false,
    pendingId: null,
  });

  const inFlight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { clones } = await client.getMindClones();
      if (alive.current) setState((s) => ({ ...s, clones, loaded: true, error: null }));
    } catch (error) {
      if (!alive.current || (error instanceof ApiRequestError && error.status === 429)) return;
      if (alive.current) setState((s) => ({ ...s, loaded: true, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      inFlight.current = false;
    }
  }, [client]);

  const train = useCallback(
    async (name: string, sources: { label: string; content: string }[]): Promise<MindCloneReport | null> => {
      setState((s) => ({ ...s, training: true, error: null }));
      try {
        const report = await client.trainMindClone(name, sources);
        if (alive.current) await refresh();
        return report;
      } catch (error) {
        if (alive.current) setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }));
        return null;
      } finally {
        if (alive.current) setState((s) => ({ ...s, training: false }));
      }
    },
    [client, refresh]
  );

  const archive = useCallback(
    async (cloneId: string) => {
      setState((s) => ({ ...s, pendingId: cloneId }));
      try {
        await client.archiveMindClone(cloneId);
        if (alive.current) await refresh();
      } catch (error) {
        if (alive.current) setState((s) => ({ ...s, error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (alive.current) setState((s) => ({ ...s, pendingId: null }));
      }
    },
    [client, refresh]
  );

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), MINDCLONE_INTERVAL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return { ...state, train, archive, refresh };
}
