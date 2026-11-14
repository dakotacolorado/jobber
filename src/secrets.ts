import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RequestError } from "./domain.ts";

/** A secret as it is listed: never its value. */
export interface SecretInfo {
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Bytes of an AES-256 key. */
const KEY_BYTES = 32;

/**
 * `JOBBER_SECRETS_KEY`: 32 bytes, as base64 (`openssl rand -base64 32`) or
 * 64 hex digits. Throws for anything else, so a mistyped key is not taken.
 */
export function parseKey(text: string): Buffer {
  const trimmed = text.trim();
  const hex = /^[0-9a-fA-F]{64}$/.test(trimmed);
  const key = hex ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES || (!hex && !/^[A-Za-z0-9+/]{43}=?$/.test(trimmed))) {
    throw new Error(`JOBBER_SECRETS_KEY must be ${KEY_BYTES} bytes, as base64 (openssl rand -base64 ${KEY_BYTES}) or ${KEY_BYTES * 2} hex digits`);
  }
  return key;
}

/**
 * Named secrets, each value sealed with AES-256-GCM under one key and stored
 * beside the runs, the name bound into it as associated data so a sealed value
 * cannot be moved to another name. No key: none can be set or read, and a
 * database already holding some is refused at once (`new Secrets` throws).
 */
export class Secrets {
  private readonly db: DatabaseSync;
  private readonly key: Buffer | null;

  constructor(db: DatabaseSync, key: Buffer | null) {
    this.db = db;
    this.key = key;
    db.exec("CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, sealed BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const first = db.prepare("SELECT name, sealed FROM secrets LIMIT 1").get() as { name: string; sealed: Uint8Array } | undefined;
    if (!first) return;
    if (!key) throw new Error("the database holds secrets, but JOBBER_SECRETS_KEY is not set: set the key they were stored with");
    try {
      this.open(first.name, first.sealed);
    } catch {
      throw new Error("JOBBER_SECRETS_KEY does not open the secrets stored: set the key they were stored with");
    }
  }

  /** Secrets can be set: a key is configured. */
  get enabled(): boolean {
    return this.key !== null;
  }

  list(): SecretInfo[] {
    return (this.db.prepare("SELECT name, created_at, updated_at FROM secrets ORDER BY name").all() as { name: string; created_at: string; updated_at: string }[]).map((r) => ({
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Sets `name` to `value`, replacing any value it had. */
  put(name: string, value: string, at: string): SecretInfo {
    const sealed = this.seal(name, value);
    this.db
      .prepare("INSERT INTO secrets (name, sealed, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at")
      .run(name, sealed, at, at);
    return this.info(name)!;
  }

  /** Deletes `name`; answers what it was, null if there was none. */
  delete(name: string): SecretInfo | null {
    const was = this.info(name);
    if (was) this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
    return was;
  }

  /** Of `names`, those not stored. */
  missing(names: string[]): string[] {
    const known = new Set(this.list().map((s) => s.name));
    return names.filter((n) => !known.has(n));
  }

  /** The values of `names`, by name; throws naming any not stored. */
  values(names: string[]): Record<string, string> {
    const gone = this.missing(names);
    if (gone.length) throw new RequestError(`no secret ${gone.join(", ")}`, 409);
    const out: Record<string, string> = {};
    for (const name of names) {
      const row = this.db.prepare("SELECT sealed FROM secrets WHERE name = ?").get(name) as { sealed: Uint8Array };
      out[name] = this.open(name, row.sealed);
    }
    return out;
  }

  private info(name: string): SecretInfo | null {
    return this.list().find((s) => s.name === name) ?? null;
  }

  private need(): Buffer {
    if (!this.key) throw new RequestError("jobber has no JOBBER_SECRETS_KEY: secrets cannot be set", 503);
    return this.key;
  }

  /** iv (12) ‖ tag (16) ‖ ciphertext. */
  private seal(name: string, value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.need(), iv);
    cipher.setAAD(Buffer.from(name));
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private open(name: string, sealed: Uint8Array): string {
    const bytes = Buffer.from(sealed);
    const decipher = createDecipheriv("aes-256-gcm", this.need(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }
}
