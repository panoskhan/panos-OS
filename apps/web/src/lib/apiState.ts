import { useEffect, useState } from "react";
import { api } from "./api";

export type ApiState = "checking" | "online" | "offline";

export function useApiHealth(): ApiState {
  const [state, setState] = useState<ApiState>("checking");
  useEffect(() => {
    let active = true;
    api.health().then(
      () => active && setState("online"),
      () => active && setState("offline")
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}
