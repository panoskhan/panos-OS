import { createHash, timingSafeEqual } from "node:crypto";

/** A bad KHAN_API_KEYS. The message never contains a key. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export interface Principal {
  /** The name from the key's `name:key` pair. It is what the audit log records as the actor. */
  name: string;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// These already mean something in the audit log: "system" is the orchestrator itself, "anonymous" is auth being off.
const RESERVED_NAMES = new Set(["system", "anonymous"]);

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

interface KeyEntry {
  name: string;
  digest: Buffer;
}

/**
 * API-key authentication. Keys come from KHAN_API_KEYS as comma-separated `name:key` pairs, for example
 * `admin:secret123,readonly:readkey456`. With no keys configured, authentication is off. Every valid key has full
 * access: the name only says who is acting.
 */
export class ApiKeyAuth {
  private constructor(private readonly keys: readonly KeyEntry[]) {}

  static disabled(): ApiKeyAuth {
    return new ApiKeyAuth([]);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ApiKeyAuth {
    return ApiKeyAuth.parse(env.KHAN_API_KEYS);
  }

  /** Throws AuthConfigError for anything malformed: a half-configured auth must not silently turn into no auth. */
  static parse(raw: string | undefined): ApiKeyAuth {
    const entries = (raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    const keys: KeyEntry[] = [];
    const seenNames = new Set<string>();
    const seenDigests = new Set<string>();

    entries.forEach((entry, index) => {
      const position = index + 1;
      const colon = entry.indexOf(":"); // the key itself may contain colons
      const name = colon === -1 ? "" : entry.slice(0, colon).trim();
      const key = colon === -1 ? "" : entry.slice(colon + 1).trim();
      if (!name || !key) throw new AuthConfigError(`KHAN_API_KEYS entry ${position} must look like name:key`);
      // A Bearer token cannot contain whitespace, so such a key could never be presented.
      if (/\s/.test(key)) throw new AuthConfigError(`KHAN_API_KEYS entry ${position}: the key must not contain spaces`);
      if (!NAME_PATTERN.test(name)) {
        throw new AuthConfigError(`KHAN_API_KEYS entry ${position}: the name must start with a letter or digit and use only letters, digits, '_', '.' and '-' (up to 64 characters)`);
      }
      if (RESERVED_NAMES.has(name.toLowerCase())) throw new AuthConfigError(`KHAN_API_KEYS entry ${position}: the name '${name}' is reserved`);
      if (seenNames.has(name.toLowerCase())) throw new AuthConfigError(`KHAN_API_KEYS entry ${position}: the name '${name}' is used twice`);

      const keyDigest = digest(key);
      if (seenDigests.has(keyDigest.toString("hex"))) throw new AuthConfigError(`KHAN_API_KEYS entry ${position} uses the same key as an earlier entry`);
      seenNames.add(name.toLowerCase());
      seenDigests.add(keyDigest.toString("hex"));
      keys.push({ name, digest: keyDigest });
    });

    return new ApiKeyAuth(keys);
  }

  get enabled(): boolean {
    return this.keys.length > 0;
  }

  /** The configured names, for the startup message. Never the keys. */
  names(): string[] {
    return this.keys.map((key) => key.name);
  }

  /**
   * The principal whose key this is, or null. Compares SHA-256 digests in constant time against every key, so
   * neither the key's length nor how much of it matches can be learned from how long this takes.
   */
  authenticate(presented: string | undefined): Principal | null {
    if (!this.enabled || !presented) return null;
    const attempt = digest(presented);
    let matched: KeyEntry | null = null;
    for (const key of this.keys) {
      if (timingSafeEqual(attempt, key.digest)) matched = key; // no early exit
    }
    return matched ? { name: matched.name } : null;
  }
}

/** The key from an `Authorization: Bearer <key>` header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1];
}
