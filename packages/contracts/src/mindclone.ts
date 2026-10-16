/**
 * PANOS-OS Phase 7d — Mind Clone
 *
 * A Mind Clone is a named persona derived from a curated memory corpus.
 * You feed it a set of source artifacts (task transcripts, notes, voice logs)
 * and it learns the owner's reasoning patterns, vocabulary and decision style.
 * Any agent can then impersonate that persona when starting a task:
 *
 *   orchestrator.start(goal, { persona: "panos-v1" })
 *
 * The clone does NOT store raw data — it stores a compact latent profile built
 * by the distillation step. Raw sources stay in the caller's hands.
 */

export type MindCloneStatus = "training" | "ready" | "failed" | "archived";

/** One source artifact fed to the distillation pipeline. */
export interface MindSource {
  /** Caller-assigned label for this source, e.g. "task-transcript-2026-01-01" */
  label: string;
  /** Plaintext content (transcripts, notes, voice-to-text). Max 200 kB per source. */
  content: string;
}

/**
 * The latent persona profile produced by the distillation step.
 * Stored as a compact JSON blob; surfaced to the agent at task start.
 */
export interface PersonaProfile {
  /** Vocabulary fingerprint: top-N distinctive tokens and n-gram patterns */
  vocabularyFingerprint: string[];
  /** Decision heuristics extracted from the source materials */
  decisionHeuristics: string[];
  /** Communication style descriptors */
  styleDescriptors: string[];
  /** Free-form synthesis note written by the distiller */
  synthesis: string;
}

export interface MindClone {
  id: string;
  /** Human-readable name, e.g. "panos-v1". Must be unique within an actor's clones. */
  name: string;
  /** Actor who created this clone (flows through to audit log) */
  actor: string;
  status: MindCloneStatus;
  createdAt: string;
  /** ISO timestamp when distillation completed (status became "ready") */
  trainedAt?: string;
  /** Number of source artifacts consumed during training */
  sourceCount: number;
  /** Approximate token count of the source corpus */
  corpusTokens: number;
  /** Populated once status === "ready" */
  profile?: PersonaProfile;
  /** Human-readable failure reason when status === "failed" */
  failureReason?: string;
}

export interface MindCloneReport {
  clone: MindClone;
}

export const MINDCLONE_MAX_SOURCES = 50;
export const MINDCLONE_MAX_SOURCE_BYTES = 200_000; // 200 kB per source
export const MINDCLONE_MAX_NAME_LENGTH = 64;
