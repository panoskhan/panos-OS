import type { SettingsResponse, UpdateSettingsRequest, UpdateSettingsResponse } from "../../../../packages/contracts/src/api";
import { api } from "./api";

/** Fetch the current settings (masked key, model name, configured flag). */
export async function getSettings(): Promise<SettingsResponse> {
  const res = await fetch(`${api.baseUrl}/v1/settings`, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  if (!res.ok) throw new Error(`Settings fetch failed: ${res.status}`);
  return res.json() as Promise<SettingsResponse>;
}

/** Save a new NVIDIA API key (or clear it with an empty string). */
export async function updateSettings(body: UpdateSettingsRequest): Promise<UpdateSettingsResponse> {
  const res = await fetch(`${api.baseUrl}/v1/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Settings update failed: ${res.status}`);
  return res.json() as Promise<UpdateSettingsResponse>;
}
