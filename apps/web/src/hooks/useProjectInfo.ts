import { useEffect, useState } from "react";
import type { ProjectInfoResponse } from "../../../../packages/contracts/src/api";
import { api, type KhanApiClient } from "../lib/api";

export function useProjectInfo(client: KhanApiClient = api) {
  const [info, setInfo] = useState<ProjectInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    client.getProjectInfo().then(
      (response) => {
        if (active) {
          setInfo(response);
          setError(null);
        }
      },
      (fetchError: unknown) => {
        if (active) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      }
    );
    return () => {
      active = false;
    };
  }, [client]);

  return { info, error };
}
