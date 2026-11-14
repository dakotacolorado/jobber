import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Store } from "./store.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_(URL|TOKEN)$/.test(k)));

const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "jobber-cli-"));
  dirs.push(dir);
  return dir;
}

/** Starts the server on a port the OS picks; answers its address once it says it listens. */
function serve(db: string, env: Record<string, string>, args = ["--port", "0", "--db", db]): Promise<{ url: string; out: () => string }> {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...clean(), ...env } });
  children.push(child);
  let out = "";
  return new Promise((ready, fail) => {
    child.stdout.on("data", (d) => {
      out += d;
      const url = / on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)?.[1];
      if (url) ready({ url, out: () => out });
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => fail(new Error(`exited ${code}: ${out}`)));
  });
}

describe("jobber serve", () => {
  it("serves the API on the database it is given, with the tokens in its environment", async () => {
    const dir = temp();
    const { url } = await serve(join(dir, "db", "js.db"), { AUTH_TOKEN: "a", RUNNER_TOKEN: "r" });
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/runs`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${url}/runs`, { headers: { authorization: "Bearer a" } })).status).toBe(200);
    expect(existsSync(join(dir, "db", "js.db"))).toBe(true);
  });

  it("says which token is missing, and answers 503 for what needs it", async () => {
    const { url, out } = await serve(join(temp(), "js.db"), {});
    expect(out()).toContain("AUTH_TOKEN and RUNNER_TOKEN not set");
    expect(out()).toContain("Submit code to run on whatever computers you have.");
    expect(out()).toMatch(/▸ Page {6}http:\/\/127\.0\.0\.1:\d+\//);
    expect(out(), "piped, it has no colors").not.toContain("\x1b");
    expect((await fetch(`${url}/runs`, { headers: { authorization: "Bearer a" } })).status).toBe(503);
  });
});

describe("jobber's settings", () => {
  it("takes its port, address and database from JOBBER_PORT, JOBBER_HOST and JOBBER_DB", async () => {
    const db = join(temp(), "jobber.db");
    const { out } = await serve(db, { JOBBER_PORT: "0", JOBBER_HOST: "127.0.0.1", JOBBER_DB: db }, []);
    expect(existsSync(db)).toBe(true);
    expect(out()).not.toContain("deprecated");
  });

  it("still takes the JOB_SERVICE_* names it had before, and says which JOBBER_* to set", async () => {
    const db = join(temp(), "old.db");
    const { out } = await serve(db, { JOB_SERVICE_PORT: "0", JOB_SERVICE_HOST: "127.0.0.1", JOB_SERVICE_DB: db }, []);
    expect(existsSync(db)).toBe(true);
    for (const name of ["PORT", "HOST", "DB"]) await expect.poll(out).toContain(`JOB_SERVICE_${name} is deprecated: set JOBBER_${name} instead`);
  });

  it("prefers JOBBER_* to the old name when both are set", async () => {
    const db = join(temp(), "new.db");
    await serve(db, { JOBBER_PORT: "0", JOBBER_DB: db, JOB_SERVICE_DB: join(temp(), "old.db") }, []);
    expect(existsSync(db)).toBe(true);
  });

  it("describes jobber in --help", () => {
    const done = spawnSync(process.execPath, [CLI, "--help"], { env: clean(), encoding: "utf8" });
    expect(done.status).toBe(0);
    expect(done.stdout).toMatch(/^jobber v\S+: submit code to run on whatever computers you have\./);
    expect(done.stdout).toContain("JOBBER_PORT");
    expect(done.stdout).not.toMatch(/job[-]service/i);
  });
});

describe("jobber serve, to a host", () => {
  it("takes the host's WebSocket and answers its heartbeat over it", async () => {
    const { url } = await serve(join(temp(), "js.db"), { AUTH_TOKEN: "a", RUNNER_TOKEN: "r" });
    const registered = await fetch(`${url}/hosts`, {
      method: "POST",
      headers: { authorization: "Bearer r", "content-type": "application/json" },
      body: JSON.stringify({ name: "h", os: "linux", arch: "x86_64", capacity: { cpu: 1, memory: 1024, gpu: 0, gpuMemory: 0 } }),
    });
    const { host, token } = (await registered.json()) as { host: { id: string }; token: string };
    const socket = new WebSocket(`${url.replace("http", "ws")}/hosts/${host.id}/connect`, { headers: { authorization: `Bearer ${token}` } });
    await new Promise((open) => socket.once("open", open));
    const answer = new Promise<string>((got) => socket.once("message", (data) => got(data.toString())));
    socket.send(JSON.stringify({ type: "heartbeat", free: { cpu: 1, memory: 1024, gpu: 0 }, metrics: { cpuLoad: 0, memoryUsed: 0, memoryTotal: 0, diskFree: 50_000, cpus: 0 }, running: [] }));
    expect(JSON.parse(await answer)).toEqual({ type: "heartbeat", cancel: [], ended: [], lease: 60 });
    socket.close();
  });
});

describe("jobber serve on a port already taken", () => {
  it("says so and exits 1", async () => {
    const { url } = await serve(join(temp(), "a.db"), {});
    const port = new URL(url).port;
    const done = spawnSync(process.execPath, [CLI, "--port", port, "--db", join(temp(), "b.db")], { env: clean(), encoding: "utf8", timeout: 10_000 });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`jobber: cannot serve on 127.0.0.1:${port}`);
  });
});

describe("jobber backup", () => {
  it("copies the database to the file it names", () => {
    const dir = temp();
    const store = Store.open(join(dir, "js.db"));
    store.putHost({ id: "h1", name: "h", os: "linux", arch: "x86_64", labels: {}, capacity: { cpu: 1, memory: 16, gpu: 0, gpuMemory: 0 }, version: null, features: [], free: null, metrics: null, createdAt: "t", lastSeenAt: "t", tokenHash: "x" });
    const done = spawnSync(process.execPath, [CLI, "backup", join(dir, "copy.db"), "--db", join(dir, "js.db")], { env: clean(), encoding: "utf8" });
    store.close();
    expect(done.status, done.stderr).toBe(0);
    const copy = Store.open(join(dir, "copy.db"));
    expect(copy.hosts().map((h) => h.id)).toEqual(["h1"]);
    copy.close();
  });
});
