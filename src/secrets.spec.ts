import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import { fits, NO_RETRY, submitted, type Run } from "./domain.ts";
import { parseKey, Secrets } from "./secrets.ts";
import { start } from "./server.ts";
import { Store } from "./store.ts";

const KEY = Buffer.alloc(32, 1);
const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("JOBBER_SECRETS_KEY", () => {
  it("is 32 bytes, as base64 or hex, and nothing else", () => {
    expect(parseKey(KEY.toString("base64"))).toEqual(KEY);
    expect(parseKey(KEY.toString("hex"))).toEqual(KEY);
    for (const bad of ["", "short", Buffer.alloc(16).toString("base64"), Buffer.alloc(33).toString("base64"), `${KEY.toString("base64")}!`]) {
      expect(() => parseKey(bad)).toThrow(/32 bytes/);
    }
  });
});

describe("secrets at rest", () => {
  it("are stored sealed, listed without their values, and rotated in place", () => {
    const db = new DatabaseSync(":memory:");
    const secrets = new Secrets(db, KEY);
    secrets.put("NPM_TOKEN", "npm_plaintext", "2026-11-13T00:00:00.000Z");
    const rotated = secrets.put("NPM_TOKEN", "npm_rotated", "2026-11-14T00:00:00.000Z");
    expect(rotated).toEqual({ name: "NPM_TOKEN", createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-14T00:00:00.000Z" });
    expect(JSON.stringify(secrets.list())).not.toContain("npm_");
    const stored = Buffer.concat((db.prepare("SELECT sealed FROM secrets").all() as { sealed: Uint8Array }[]).map((r) => Buffer.from(r.sealed)));
    expect(stored.toString("latin1")).not.toContain("npm_");
    expect(secrets.values(["NPM_TOKEN"])).toEqual({ NPM_TOKEN: "npm_rotated" });
    expect(() => secrets.values(["NPM_TOKEN", "NOPE"])).toThrow("no secret NOPE");
  });

  it("refuse to open without the key they were stored with", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => new Secrets(db, null).put("A", "v", "t")).toThrow(/JOBBER_SECRETS_KEY/);
    new Secrets(db, KEY).put("A", "v", "t");
    expect(() => new Secrets(db, null)).toThrow(/holds secrets, but JOBBER_SECRETS_KEY is not set/);
    expect(() => new Secrets(db, Buffer.alloc(32, 2))).toThrow(/does not open the secrets stored/);
    expect(new Secrets(db, KEY).values(["A"])).toEqual({ A: "v" });
  });

  it("keep jobber from starting on a database holding them without the key", () => {
    const file = join(mkdtempSync(join(tmpdir(), "jobber-secrets-")), "jobber.db");
    const first = start({ db: file, tokens: { submitter: "t", registration: null }, secretsKey: KEY });
    new Secrets(first.store.db, KEY).put("A", "v", "t");
    first.close();
    expect(() => start({ db: file, tokens: { submitter: "t", registration: null } })).toThrow(/JOBBER_SECRETS_KEY is not set/);
    start({ db: file, tokens: { submitter: "t", registration: null }, secretsKey: KEY }).close();
  });
});

function setup(key: Buffer | null = KEY, admin: string | null = "admin") {
  const store = Store.open(":memory:");
  const api = new JobApi(store, { submitter: "sub", registration: "reg", admin }, { version: "0", commit: "x" }, undefined, new Secrets(store.db, key));
  const call = (method: string, path: string, auth: string, body?: unknown) =>
    api.fetch(
      new Request(`http://local${path}`, {
        method,
        headers: { authorization: `Bearer ${auth}`, ...(body !== undefined && { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const submit = (over: Record<string, unknown>) => call("POST", "/runs", "sub", { repo: "o/r", commit: COMMIT, job: "deploy", ...over });
  return { call, submit };
}

describe("the secrets API", () => {
  it("is the admin's alone, and never answers a value", async () => {
    const { call } = setup();
    expect((await call("PUT", "/secrets/AWS_ROLE", "sub", { value: "arn:aws:iam::1:role/x" })).status).toBe(401);
    const put = await call("PUT", "/secrets/AWS_ROLE", "admin", { value: "arn:aws:iam::1:role/x" });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain("arn:aws");
    const listed = await call("GET", "/secrets", "admin");
    expect(await listed.json()).toEqual({ secrets: [{ name: "AWS_ROLE", createdAt: expect.any(String), updatedAt: expect.any(String) }] });
    expect((await call("GET", "/secrets", "sub")).status).toBe(401);
    expect((await call("PUT", "/secrets/lower", "admin", { value: "v" })).status).toBe(400);
    expect((await call("DELETE", "/secrets/AWS_ROLE", "admin")).status).toBe(200);
    expect(await (await call("DELETE", "/secrets/AWS_ROLE", "admin")).json()).toMatchObject({ code: "ResourceNotFoundException" });
  });

  it("answers 503 without an admin token, or, to set one, without a key", async () => {
    expect((await setup(KEY, null).call("GET", "/secrets", "admin")).status).toBe(503);
    const res = await setup(null).call("PUT", "/secrets/A", "admin", { value: "v" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "ServiceUnavailableException" });
  });
});

describe("SubmitRun", () => {
  it("refuses a secret not set, and takes one that is", async () => {
    const { call, submit } = setup();
    const refused = await submit({ secrets: ["AWS_ROLE"] });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "ValidationException", message: "secrets: no secret AWS_ROLE is set" });
    await call("PUT", "/secrets/AWS_ROLE", "admin", { value: "v" });
    const taken = await submit({ secrets: ["AWS_ROLE"] });
    expect(taken.status).toBe(201);
    expect(await taken.json()).toMatchObject({ secrets: ["AWS_ROLE"], onHost: false });
    expect((await submit({ secrets: ["AWS_ROLE", "AWS_ROLE"] })).status).toBe(400);
  });

  it("refuses a run onHost without a host, or naming a host not registered", async () => {
    const { call, submit } = setup();
    expect(await (await submit({ onHost: true })).json()).toMatchObject({ message: "requirements.host: a run onHost names the host it runs on" });
    expect(await (await submit({ onHost: true, requirements: { host: "laptop" } })).json()).toMatchObject({ message: "requirements.host: no host laptop is registered" });
    await call("POST", "/hosts", "reg", { name: "laptop", os: "linux", arch: "x86_64", capacity: { cpu: 1, memory: 1024, gpu: 0, gpuMemory: 0 } });
    const taken = await submit({ onHost: true, requirements: { host: "laptop" } });
    expect(taken.status).toBe(201);
    expect(await taken.json()).toMatchObject({ onHost: true, requirements: { host: "laptop" } });
  });
});

describe("fits", () => {
  const run = (over: Partial<Pick<Run, "secrets" | "onHost">> & { host?: string }): Run =>
    submitted({
      repo: "o/r",
      commit: COMMIT,
      job: "j",
      args: [],
      requirements: { os: null, arch: null, cpu: null, memory: null, gpu: null, gpuMemory: null, timeout: null, host: over.host ?? null },
      labels: {},
      priority: 0,
      retry: NO_RETRY,
      secrets: over.secrets ?? [],
      onHost: over.onHost ?? false,
    });
  const host = (name: string, features: string[]) => ({ name, features, os: "linux" as const, arch: "x86_64" as const, free: { cpu: 4, memory: 8192, gpu: 0 }, gpuMemory: 0 });

  it("needs the features a run uses, and the host it names", () => {
    expect(fits(run({}), host("a", []))).toBe(true);
    expect(fits(run({ secrets: ["X"] }), host("a", []))).toBe(false);
    expect(fits(run({ secrets: ["X"] }), host("a", ["secrets"]))).toBe(true);
    expect(fits(run({ onHost: true, host: "a" }), host("a", ["secrets"]))).toBe(false);
    expect(fits(run({ onHost: true, host: "a" }), host("a", ["hostRuns"]))).toBe(true);
    expect(fits(run({ onHost: true, host: "a" }), host("b", ["hostRuns"]))).toBe(false);
    expect(fits(run({ host: "a" }), host("b", []))).toBe(false);
    expect(fits(run({ onHost: true, host: "a", secrets: ["X"] }), host("a", ["hostRuns"]))).toBe(false);
  });
});
