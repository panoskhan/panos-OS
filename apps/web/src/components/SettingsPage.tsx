import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings, updateSettings } from "../lib/settingsApi";

interface ModelRouterStatus {
  configured: boolean;
  model: string;
  keyMasked: string | null;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function SettingsPage() {
  const [status, setStatus] = useState<ModelRouterStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const data = await getSettings();
      setStatus(data.modelRouter);
    } catch {
      // silently keep the last state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleSave = useCallback(async () => {
    setSaveState("saving");
    setSaveError(null);
    try {
      const result = await updateSettings({ nvidiaApiKey: apiKey.trim() });
      setSaveState(result.configured ? "saved" : "error");
      if (result.configured) {
        setApiKey("");
        // Small delay then reload status to reflect the startup check result
        setTimeout(() => {
          void reload().then(() => setSaveState("idle"));
        }, 2500);
      } else {
        setSaveError("Key was saved but the Model Router could not verify it. Check the key and try again.");
        setSaveState("error");
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaveState("error");
    }
  }, [apiKey, reload]);

  const handleClear = useCallback(async () => {
    setSaveState("saving");
    setSaveError(null);
    try {
      await updateSettings({ nvidiaApiKey: "" });
      setApiKey("");
      setSaveState("idle");
      void reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaveState("error");
    }
  }, [reload]);

  const configured = status?.configured ?? false;
  const dotState = loading ? "checking" : configured ? "online" : "offline";
  const dotLabel = loading ? "Checking…" : configured ? "Online" : "Not configured";

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2>Settings</h2>
        <p className="settings-subtitle">Configure integrations and API keys for KHAN OS.</p>
      </header>

      <section className="settings-card" aria-labelledby="model-router-heading">
        <h3 id="model-router-heading">Model Router</h3>
        <p className="settings-desc">
          KHAN OS uses NVIDIA NIM to run inference. Paste your{" "}
          <a href="https://build.nvidia.com" target="_blank" rel="noreferrer">
            NVIDIA API key
          </a>{" "}
          below to connect the Model Router.
        </p>

        <div className="settings-status-row">
          <ul className="settings-status-list">
            <li data-state={dotState}>
              <i aria-hidden="true" />
              <span>Model Router</span>
              <small>{dotLabel}</small>
            </li>
            {status && (
              <li data-state="idle">
                <i aria-hidden="true" />
                <span>Active model</span>
                <small className="model-name">{status.model}</small>
              </li>
            )}
          </ul>
          {status?.keyMasked && (
            <div className="current-key">
              <span className="key-label">Current key</span>
              <code className="key-masked">{status.keyMasked}</code>
              <button
                type="button"
                className="btn-ghost btn-danger-ghost"
                onClick={() => void handleClear()}
                disabled={saveState === "saving"}
              >
                Clear
              </button>
            </div>
          )}
        </div>

        <div className="settings-input-group">
          <label htmlFor="nvidia-api-key" className="settings-label">
            NVIDIA API Key
          </label>
          <div className="settings-input-row">
            <input
              ref={inputRef}
              id="nvidia-api-key"
              type="password"
              className="settings-input"
              placeholder="nvapi-…"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setSaveState("idle");
                setSaveError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && apiKey.trim()) void handleSave();
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleSave()}
              disabled={!apiKey.trim() || saveState === "saving"}
            >
              {saveState === "saving" ? "Saving…" : "Save Key"}
            </button>
          </div>

          {saveState === "saved" && (
            <p className="settings-feedback settings-ok" role="status">
              ✓ Key saved — the Model Router is running a startup check now.
            </p>
          )}
          {saveState === "error" && saveError && (
            <p className="settings-feedback settings-err" role="alert">
              ✗ {saveError}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
