/**
 * PANOS-OS Phase 6 — Voice Intent Parser
 * Translates raw JARVIS utterances into structured intents for KhanOrchestrator.
 */

// ─── Intent types ────────────────────────────────────────────────────────────

export type VoiceIntent =
  | { kind: "new_task"; goal: string }
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "cancel" }
  | { kind: "status" }
  | { kind: "unknown" };

// ─── Recognition patterns ────────────────────────────────────────────────────

/**
 * Ordered patterns for new-task extraction.
 * First match wins; capture group 1 becomes the goal string.
 */
const NEW_TASK_PATTERNS: RegExp[] = [
  // "Hey KHAN, create a task to / run / execute / start / build / do <goal>"
  /^(?:hey\s+khan[,!\s]+)(?:create a task to|run|execute|start|build|do)\s+(.+)/i,
  // "Hey KHAN, <anything else>" — bare delegation
  /^(?:hey\s+khan[,!\s]+)(.+)/i,
  // No wake word — explicit task verbs
  /^(?:create a task to|new task[:\s]+|execute|run|start|build)\s+(.+)/i,
];

const APPROVE_RE =
  /^(?:approve|yes|go ahead|confirm|proceed|looks good|do it|that'?s fine|affirmative)\b/i;
const REJECT_RE =
  /^(?:reject|no|nope|stop|don'?t|don'?t do it|cancel that|reject that|bad idea|not that)\b/i;
const CANCEL_RE =
  /^(?:cancel|abort|kill it|terminate|stop the task)\b/i;
const STATUS_RE =
  /^(?:status|what'?s the status|how'?s it going|update me|progress|what'?s happening)\b/i;

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse a raw voice utterance into a structured VoiceIntent.
 * Priority: cancel > approve > reject > status > new_task > unknown.
 */
export function parseVoiceIntent(utterance: string): VoiceIntent {
  const u = utterance.trim();
  if (!u) return { kind: "unknown" };

  // Cancel beats everything — explicit termination
  if (CANCEL_RE.test(u)) return { kind: "cancel" };
  if (APPROVE_RE.test(u)) return { kind: "approve" };
  if (REJECT_RE.test(u)) return { kind: "reject" };
  if (STATUS_RE.test(u)) return { kind: "status" };

  for (const pattern of NEW_TASK_PATTERNS) {
    const m = u.match(pattern);
    if (m?.[1]) {
      const goal = m[1].trim().replace(/[.!?]+$/, "").trim();
      if (goal.length > 0) return { kind: "new_task", goal };
    }
  }

  return { kind: "unknown" };
}

// ─── HTTP contract types ──────────────────────────────────────────────────────

export interface VoiceRequest {
  /** Raw spoken utterance from JARVIS */
  utterance: string;
  /**
   * Active task ID — required for approve / reject / cancel / status.
   * Ignored when intent resolves to new_task.
   */
  taskId?: string;
}

export interface VoiceResponse {
  /** Resolved intent kind */
  intent: VoiceIntent["kind"];
  /** Task ID acted upon or newly created */
  taskId?: string;
  /** Extracted goal (only present when intent === "new_task") */
  goal?: string;
  /** Human-readable confirmation message for JARVIS TTS */
  message: string;
}
