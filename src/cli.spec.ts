import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
  const dir = mkdtempSync(join(tmpdir(), "job-service-cli-"));
  dirs.push(dir);
  return dir;
}

/** Starts the server on a port the OS picks; answers its address once it says it listens. */
function serve(db: string, env: Record<string, string>): Promise<{ url: string; out: () => string }> {
  const child = spawn(process.execPath, [CLI, "--port", "0", "--db", db], { env: { ...clean(), ...env } });
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

describe("job-service serve", () => {
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
    expect((await fetch(`${url}/runs`, { headers: { authorization: "Bearer a" } })).status).toBe(503);
  });
});

describe("job-service serve on a port already taken", () => {
  it("says so and exits 1", async () => {
    const { url } = await serve(join(temp(), "a.db"), {});
    const port = new URL(url).port;
    const done = spawnSync(process.execPath, [CLI, "--port", port, "--db", join(temp(), "b.db")], { env: clean(), encoding: "utf8", timeout: 10_000 });
    expect(done.status).toBe(1);
    expect(done.stderr).toContain(`job-service: cannot serve on 127.0.0.1:${port}`);
  });
});

describe("job-service backup", () => {
  it("copies the database to the file it names", () => {
    const dir = temp();
    const store = Store.open(join(dir, "js.db"));
    store.createRunner({ id: "r1", name: "h", labels: {}, slots: 1, memory: 16, version: null, hostId: null, createdAt: "t", lastSeenAt: "t", tokenHash: "x" });
    const done = spawnSync(process.execPath, [CLI, "backup", join(dir, "copy.db"), "--db", join(dir, "js.db")], { env: clean(), encoding: "utf8" });
    store.close();
    expect(done.status, done.stderr).toBe(0);
    const copy = Store.open(join(dir, "copy.db"));
    expect(copy.runners().map((r) => r.id)).toEqual(["r1"]);
    copy.close();
  });
});
