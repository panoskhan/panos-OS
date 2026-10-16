import { useRef, useState } from "react";
import {
  MINDCLONE_MAX_NAME_LENGTH,
  MINDCLONE_MAX_SOURCE_BYTES,
  MINDCLONE_MAX_SOURCES,
  type MindClone,
} from "../../../../packages/contracts/src/mindclone";
import type { MindClonesApi } from "../hooks/useMindClones";

function statusTone(status: MindClone["status"]): string {
  if (status === "ready") return "active";
  if (status === "failed") return "danger";
  if (status === "archived") return "warn";
  return "ok"; // training
}

function CloneCard({ clone, api }: { clone: MindClone; api: MindClonesApi }) {
  const [open, setOpen] = useState(false);
  const busy = api.pendingId === clone.id;

  return (
    <li className="swarm-card" data-status={clone.status}>
      <button
        type="button"
        className="swarm-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="swarm-problem">
          <code>{clone.name}</code>
        </span>
        <span className="badge" data-tone={statusTone(clone.status)}>{clone.status}</span>
        <span className="ghost-count" style={{ fontSize: "0.8em", opacity: 0.7 }}>
          {clone.sourceCount} src · ~{Math.round(clone.corpusTokens / 1000)}k tokens
        </span>
        <span className="swarm-toggle" aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="swarm-body">
          {clone.status === "ready" && clone.profile && (
            <>
              <p className="swarm-verdict">{clone.profile.synthesis}</p>
              {clone.profile.styleDescriptors.length > 0 && (
                <p style={{ fontSize: "0.85em", opacity: 0.8 }}>
                  <strong>Style:</strong> {clone.profile.styleDescriptors.join(" · ")}
                </p>
              )}
              {clone.profile.vocabularyFingerprint.length > 0 && (
                <p style={{ fontSize: "0.85em", opacity: 0.8 }}>
                  <strong>Vocabulary:</strong>{" "}
                  {clone.profile.vocabularyFingerprint.slice(0, 12).join(", ")}
                </p>
              )}
              {clone.profile.decisionHeuristics.length > 0 && (
                <details>
                  <summary style={{ cursor: "pointer", fontSize: "0.85em" }}>
                    {clone.profile.decisionHeuristics.length} decision heuristics
                  </summary>
                  <ul style={{ fontSize: "0.8em", marginTop: "0.5rem" }}>
                    {clone.profile.decisionHeuristics.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {clone.status === "failed" && (
            <p className="error-banner" role="alert">{clone.failureReason ?? "Unknown failure"}</p>
          )}
          <p className="swarm-meta">
            <code>{clone.id.slice(0, 8)}</code>
            {" · "}
            {clone.trainedAt
              ? `trained ${new Date(clone.trainedAt).toLocaleString()}`
              : `created ${new Date(clone.createdAt).toLocaleString()}`}
          </p>
          {clone.status !== "archived" && (
            <div className="ghost-actions" style={{ marginTop: "0.5rem" }}>
              <button
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => void api.archive(clone.id)}
              >
                {busy ? "Archiving…" : "Archive"}
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

interface MindClonePanelProps {
  clones: MindClonesApi;
}

export function MindClonePanel({ clones }: MindClonePanelProps) {
  const [name, setName] = useState("");
  const [rawSources, setRawSources] = useState("");
  const [sourceLabel, setSourceLabel] = useState("source-1");
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const ready = clones.clones.filter((c) => c.status === "ready").length;

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MINDCLONE_MAX_SOURCE_BYTES) {
      setFileError(`File is too large (max ${Math.round(MINDCLONE_MAX_SOURCE_BYTES / 1024)} KB)`);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      setRawSources(String(ev.target?.result ?? ""));
      setSourceLabel(file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "source");
    };
    reader.readAsText(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedContent = rawSources.trim();
    if (!trimmedName || !trimmedContent || clones.training) return;
    const sources = [{ label: sourceLabel.trim() || "source-1", content: trimmedContent }];
    const report = await clones.train(trimmedName, sources);
    if (report) {
      setName("");
      setRawSources("");
      setSourceLabel("source-1");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section className="panel" aria-labelledby="mindclone-title">
      <div className="panel-head">
        <h2 id="mindclone-title">Mind Clone</h2>
        <span className="ghost-summary">{ready} ready</span>
      </div>

      <p className="note">
        Distil a named persona from transcripts, notes or voice logs. The clone stores a compact profile — vocabulary
        fingerprint, decision heuristics and style — that any agent can load when starting a task.
      </p>

      {clones.error && (
        <div className="error-banner" role="alert">
          <strong>Mind Clone error:</strong> {clones.error}
        </div>
      )}

      {clones.clones.length ? (
        <ul className="swarm-list">
          {clones.clones.map((c) => (
            <CloneCard key={c.id} clone={c} api={clones} />
          ))}
        </ul>
      ) : (
        <p className="empty">
          {clones.loaded
            ? "No clones yet. Feed a corpus below."
            : "Loading clones…"}
        </p>
      )}

      <form className="ghost-form" style={{ flexDirection: "column", gap: "0.5rem" }} onSubmit={submit}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 160px" }}>
            <label className="sr-only" htmlFor="clone-name">Clone name</label>
            <input
              id="clone-name"
              value={name}
              maxLength={MINDCLONE_MAX_NAME_LENGTH}
              placeholder="Name, e.g. panos-v1"
              style={{ fontFamily: "monospace" }}
              onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
            />
          </div>
          <div style={{ flex: "1 1 160px" }}>
            <label className="sr-only" htmlFor="clone-label">Source label</label>
            <input
              id="clone-label"
              value={sourceLabel}
              placeholder="Source label"
              onChange={(e) => setSourceLabel(e.target.value)}
            />
          </div>
        </div>

        <label className="sr-only" htmlFor="clone-file">Upload a text file</label>
        <input
          id="clone-file"
          type="file"
          accept=".txt,.md,.log,.json,.csv"
          ref={fileRef}
          onChange={handleFile}
          style={{ fontSize: "0.875rem" }}
        />
        {fileError && <p style={{ color: "var(--color-danger, red)", fontSize: "0.8em" }}>{fileError}</p>}

        <label className="sr-only" htmlFor="clone-content">Or paste corpus text</label>
        <textarea
          id="clone-content"
          value={rawSources}
          rows={5}
          placeholder="Or paste corpus text here (transcripts, notes, voice logs)…"
          onChange={(e) => setRawSources(e.target.value)}
          style={{ fontFamily: "monospace", fontSize: "0.8rem", resize: "vertical" }}
        />

        <button
          type="submit"
          className="btn btn-primary"
          disabled={!name.trim() || !rawSources.trim() || clones.training}
        >
          {clones.training ? "Training…" : "Train Clone"}
        </button>
      </form>
      <p className="note">
        Max {MINDCLONE_MAX_SOURCES} sources · {Math.round(MINDCLONE_MAX_SOURCE_BYTES / 1024)} KB each · name: alphanumeric, dash, underscore
      </p>
    </section>
  );
}
