/**
 * Token-bucket rate limiting. A bucket holds up to `limit` tokens, starts full, and refills continuously at
 * `limit` tokens per minute. Every request takes one token; with none left it is refused, and the caller is told
 * how long until one is available.
 */

export type RateClass = "tasks" | "read" | "audit";

/** Requests per minute for each class. 0 turns a class off. */
export interface RateLimitConfig {
  tasks: number;
  read: number;
  audit: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = { tasks: 10, read: 60, audit: 20 };
const WINDOW_MS = 60_000;
const SWEEP_EVERY = 500;

export interface RateDecision {
  limited: boolean;
  /** The class's requests-per-minute limit (the bucket's size). */
  limit: number;
  /** Whole requests still available right now. */
  remaining: number;
  /** When the bucket will be completely full again (epoch ms). */
  resetAtMs: number;
  /** 0 unless limited: how long until one request is available. */
  retryAfterMs: number;
}

export interface RateLimiterDescription {
  limits: RateLimitConfig;
  /** Buckets currently tracked (one per client per class). */
  tracked: number;
  /** Requests refused since the process started. */
  limitedTotal: number;
}

function limitFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number of requests per minute (0 turns the limit off), got '${raw}'`);
  return Number(raw);
}

/** Reads KHAN_RATE_LIMIT_TASKS, KHAN_RATE_LIMIT_READ and KHAN_RATE_LIMIT_AUDIT. Setting one to 0 disables it. */
export function rateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    tasks: limitFrom(env, "KHAN_RATE_LIMIT_TASKS", DEFAULT_RATE_LIMITS.tasks),
    read: limitFrom(env, "KHAN_RATE_LIMIT_READ", DEFAULT_RATE_LIMITS.read),
    audit: limitFrom(env, "KHAN_RATE_LIMIT_AUDIT", DEFAULT_RATE_LIMITS.audit)
  };
}

/**
 * Which limit a request counts against: creating a task, reading the audit log, or anything else. "Anything else"
 * includes approve/reject/cancel (bounded by the tasks that exist), the status endpoints and the event stream.
 */
export function classify(method: string, pathname: string): RateClass {
  if (pathname === "/v1/audit") return "audit";
  if (method === "POST" && pathname === "/v1/tasks") return "tasks";
  return "read";
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private checks = 0;
  private limitedTotal = 0;

  constructor(
    private readonly limits: RateLimitConfig,
    private readonly now: () => number = Date.now
  ) {}

  /** Takes a token for this client from this class's bucket. Returns null when the class has no limit. */
  check(rateClass: RateClass, client: string): RateDecision | null {
    const limit = this.limits[rateClass];
    if (limit <= 0) return null;

    const now = this.now();
    const ratePerMs = limit / WINDOW_MS;
    const key = `${rateClass}|${client}`;
    const bucket = this.buckets.get(key) ?? { tokens: limit, updatedAt: now };
    bucket.tokens = Math.min(limit, bucket.tokens + Math.max(0, now - bucket.updatedAt) * ratePerMs);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);

    let decision: RateDecision;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      decision = {
        limited: false,
        limit,
        remaining: Math.floor(bucket.tokens),
        resetAtMs: now + Math.ceil((limit - bucket.tokens) / ratePerMs),
        retryAfterMs: 0
      };
    } else {
      this.limitedTotal++;
      decision = {
        limited: true,
        limit,
        remaining: 0,
        resetAtMs: now + Math.ceil((limit - bucket.tokens) / ratePerMs),
        retryAfterMs: Math.ceil((1 - bucket.tokens) / ratePerMs)
      };
    }

    // Only after this request is counted: sweeping first would delete a brand-new (still full) bucket and lose its token.
    if (++this.checks % SWEEP_EVERY === 0) this.sweep(now);
    return decision;
  }

  describe(): RateLimiterDescription {
    return { limits: { ...this.limits }, tracked: this.buckets.size, limitedTotal: this.limitedTotal };
  }

  /** Forgets clients whose buckets have refilled completely: they are indistinguishable from new ones. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const limit = this.limits[key.slice(0, key.indexOf("|")) as RateClass];
      if (bucket.tokens + (now - bucket.updatedAt) * (limit / WINDOW_MS) >= limit) this.buckets.delete(key);
    }
  }

  /**
   * Runs the bucket logic against a scratch limiter and a fake clock, returning what went wrong (empty when it works).
   * Used by /v1/status so the "up" means the limiter really limits, not just that it was constructed.
   */
  selfTest(): string[] {
    let time = 1_000_000;
    // A scratch instance of this limiter's own class, so a broken subclass is caught, not just the base logic.
    const Limiter = this.constructor as new (limits: RateLimitConfig, now: () => number) => RateLimiter;
    const scratch = new Limiter({ tasks: 2, read: 0, audit: 0 }, () => time);
    const problems: string[] = [];

    const first = scratch.check("tasks", "a");
    const second = scratch.check("tasks", "a");
    const third = scratch.check("tasks", "a");
    if (first?.limited !== false || first.remaining !== 1) problems.push("the first request was not allowed with one token left");
    if (second?.limited !== false || second.remaining !== 0) problems.push("the second request was not allowed with none left");
    if (third?.limited !== true || third.retryAfterMs !== 30_000) problems.push("a request over the limit was not refused with the right wait");
    if (scratch.check("tasks", "b")?.limited !== false) problems.push("one client's requests used up another client's tokens");
    if (scratch.check("read", "a") !== null) problems.push("a disabled class was limited");

    time += 30_000;
    if (scratch.check("tasks", "a")?.limited !== false) problems.push("tokens did not refill over time");
    return problems;
  }
}
