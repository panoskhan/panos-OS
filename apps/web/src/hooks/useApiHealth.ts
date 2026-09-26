import { useEffect, useState } from "react";
import { api, type KhanApiClient } from "../lib/api";

export type ApiState = "checking" | "online" | "offline";

const RECHECK_MS = 10_000;

/** Reports whether the API's /health endpoint answers, re-checking periodically. */
export function useApiHealth(client: KhanApiClient = api): ApiState {
  const [state, setState] = useState<ApiState>("checking");

  useEffect(() => {
    let active = true;
    const check = () =>
      client.health().then(
        () => active && setState("online"),
        () => active && setState("offline")
      );
    check();
    const timer = setInterval(check, RECHECK_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client]);

  return state;
}
