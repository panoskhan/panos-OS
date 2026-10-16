/**
 * PANOS-OS Phase 7d — Mind Clone core
 * In-process registry + distillation engine for named persona profiles.
 *
 * The distiller runs synchronously on registration (no external LLM call):
 * it extracts vocabulary, heuristics and style from the source corpus using
 * simple but fast text analysis. A real deployment would swap _distill() for
 * an async fine-tuning or embedding call.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MINDCLONE_MAX_NAME_LENGTH,
  MINDCLONE_MAX_SOURCE_BYTES,
  MINDCLONE_MAX_SOURCES,
  type MindClone,
  type MindCloneReport,
  type MindSource,
  type PersonaProfile,
} from "../../contracts/src/mindclone";

export * from "../../contracts/src/mindclone";

// ─── MindCloneRegistry ────────────────────────────────────────────────────────

export class MindCloneRegistry {
  private readonly clones = new Map<string, MindClone>();
  private readonly dataFile: string;

  constructor(dataDir = "data") {
    this.dataFile = path.join(dataDir, "mindclones.jsonl");
    this._load();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Train a new Mind Clone from the provided source corpus.
   * Throws synchronously on validation errors; persists the clone on success.
   */
  train(name: string, sources: MindSource[], actor: string): MindCloneReport {
    // Validation
    if (!name || name.length > MINDCLONE_MAX_NAME_LENGTH) {
      throw new Error(`clone_name_invalid: must be 1–${MINDCLONE_MAX_NAME_LENGTH} chars`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error("clone_name_invalid: only alphanumeric, dash and underscore allowed");
    }
    if (sources.length === 0) {
      throw new Error("clone_sources_empty: provide at least one source");
    }
    if (sources.length > MINDCLONE_MAX_SOURCES) {
      throw new Error(`clone_sources_limit: max ${MINDCLONE_MAX_SOURCES} sources`);
    }
    for (const s of sources) {
      if (Buffer.byteLength(s.content, "utf-8") > MINDCLONE_MAX_SOURCE_BYTES) {
        throw new Error(`clone_source_too_large: source "${s.label}" exceeds ${MINDCLONE_MAX_SOURCE_BYTES} bytes`);
      }
    }
    // Check name uniqueness per actor
    for (const existing of this.clones.values()) {
      if (existing.actor === actor && existing.name === name && existing.status !== "archived") {
        throw new Error(`clone_name_taken: a clone named "${name}" already exists for this actor`);
      }
    }

    const corpusText = sources.map((s) => s.content).join("\n\n");
    const corpusTokens = Math.round(corpusText.length / 4); // rough token estimate

    let clone: MindClone = {
      id: randomUUID(),
      name,
      actor,
      status: "training",
      createdAt: new Date().toISOString(),
      sourceCount: sources.length,
      corpusTokens,
    };
    this.clones.set(clone.id, clone);
    this._persist(clone);

    try {
      const profile = this._distill(corpusText);
      clone.profile = profile;
      clone.status = "ready";
      clone.trainedAt = new Date().toISOString();
    } catch (err) {
      clone.status = "failed";
      clone.failureReason = (err as Error).message;
    }

    this._persist(clone);
    return { clone };
  }

  get(id: string): MindCloneReport {
    return { clone: this._require(id) };
  }

  getByName(name: string, actor: string): MindCloneReport {
    for (const clone of this.clones.values()) {
      if (clone.actor === actor && clone.name === name && clone.status !== "archived") {
        return { clone };
      }
    }
    throw new Error("clone_not_found");
  }

  list(actor?: string): MindClone[] {
    return Array.from(this.clones.values()).filter(
      (c) => c.status !== "archived" && (actor === undefined || c.actor === actor)
    );
  }

  archive(id: string): MindCloneReport {
    const clone = this._require(id);
    if (clone.status === "archived") return { clone };
    clone.status = "archived";
    this._persist(clone);
    return { clone };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _require(id: string): MindClone {
    const clone = this.clones.get(id);
    if (!clone) throw new Error("clone_not_found");
    return clone;
  }

  /**
   * Lightweight distillation: no external calls, runs in-process.
   * Extracts vocabulary fingerprint, decision heuristics and style descriptors
   * from the plaintext corpus. A production implementation would call an LLM.
   */
  private _distill(corpus: string): PersonaProfile {
    // ── Vocabulary fingerprint: top distinctive words (excl. stopwords) ──────
    const stopwords = new Set([
      "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
      "from","is","was","are","were","be","been","being","have","has","had","do",
      "does","did","will","would","could","should","may","might","shall","that",
      "this","these","those","it","its","i","we","you","he","she","they","me",
      "us","him","her","them","my","our","your","his","their","what","which","who",
      "how","when","where","why","if","then","so","not","no","yes","get","make",
    ]);
    const words = corpus
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopwords.has(w));

    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
    const vocabularyFingerprint = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([w]) => w);

    // ── Decision heuristics: sentences containing heuristic markers ──────────
    const heuristicMarkers = [
      /\b(always|never|first|before|after|must|should|prefer|avoid|ensure|check|verify)\b/i,
      /\b(if .+then|when .+,|because|therefore|thus|so that)\b/i,
      /\b(the goal is|the point is|what matters|key insight|lesson learned)\b/i,
    ];
    const sentences = corpus.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 20);
    const decisionHeuristics = sentences
      .filter((s) => heuristicMarkers.some((r) => r.test(s)))
      .slice(0, 10)
      .map((s) => s.replace(/\s+/g, " ").slice(0, 200));

    // ── Style descriptors ─────────────────────────────────────────────────────
    const avgSentenceLen = sentences.length
      ? sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentences.length
      : 0;
    const questionCount = (corpus.match(/\?/g) ?? []).length;
    const exclamationCount = (corpus.match(/!/g) ?? []).length;
    const bulletCount = (corpus.match(/^\s*[-*•]/gm) ?? []).length;

    const styleDescriptors: string[] = [];
    if (avgSentenceLen < 12) styleDescriptors.push("terse, short sentences");
    else if (avgSentenceLen > 25) styleDescriptors.push("detailed, long-form sentences");
    else styleDescriptors.push("moderate sentence length");

    if (questionCount / (sentences.length || 1) > 0.15) styleDescriptors.push("questioning, inquisitive tone");
    if (exclamationCount / (sentences.length || 1) > 0.1) styleDescriptors.push("emphatic, energetic tone");
    if (bulletCount > 10) styleDescriptors.push("list-oriented, structured");

    const techTerms = ["api","async","schema","config","deploy","pipeline","module","interface","endpoint"];
    const techScore = techTerms.filter((t) => corpus.toLowerCase().includes(t)).length;
    if (techScore >= 4) styleDescriptors.push("technical, engineering-focused vocabulary");

    const synthesis = [
      `Corpus: ${sentences.length} sentences, ~${Math.round(corpus.length / 1000)}k chars.`,
      styleDescriptors.join("; ") + ".",
      vocabularyFingerprint.length
        ? `Distinctive terms: ${vocabularyFingerprint.slice(0, 8).join(", ")}.`
        : "",
      decisionHeuristics.length
        ? `${decisionHeuristics.length} decision heuristics extracted.`
        : "No strong decision heuristics found.",
    ]
      .filter(Boolean)
      .join(" ");

    return { vocabularyFingerprint, decisionHeuristics, styleDescriptors, synthesis };
  }

  private _persist(clone: MindClone): void {
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      fs.appendFileSync(this.dataFile, JSON.stringify(clone) + "\n", "utf-8");
    } catch {
      // Non-fatal
    }
  }

  private _load(): void {
    try {
      const raw = fs.readFileSync(this.dataFile, "utf-8");
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          const c = JSON.parse(line) as MindClone;
          if (c.id) this.clones.set(c.id, c);
        } catch {
          /* skip malformed lines */
        }
      }
    } catch {
      /* no data file yet */
    }
  }
}
