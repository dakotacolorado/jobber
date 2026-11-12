import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// skill/bin/jobs against a stub job-service on a free port, which breaks calls the way a network does.

const JOBS = fileURLToPath(new URL("../skill/bin/jobs", import.meta.url));
const ID = "job-1";
const COMMIT_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

type Fault = "drop" | "503" | "short" | "hang";

/** A job whose log grows by one line a read, then ends `state` with `exit`; each fault answers one log read in turn. */
function stub(lines: string[], end: { state: string; exit: number | null }, faults: Fault[]) {
  let log = "";
  let reads = 0;
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === `/runs/${ID}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: ID, state: lines.length ? "running" : end.state, exit: lines.length ? null : end.exit, reason: null }));
      return;
    }
    const fault = reads++ % 2 === 1 ? faults.shift() : undefined;
    if (fault === "drop") return req.socket.destroy();
    if (fault === "hang") return;
    if (fault === "503") return res.writeHead(503).end("busy");
    const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "bytes=0-")![1]);
    const next = lines.shift();
    if (next !== undefined) log += next;
    const bytes = Buffer.from(log).subarray(from);
    const headers = {
      "content-range": bytes.length ? `bytes ${from}-${from + bytes.length - 1}/${log.length}` : `bytes */${log.length}`,
      "run-state": lines.length ? "running" : end.state,
      "content-type": "text/plain",
    };
    // A short read: Content-Range promises the bytes, but only half arrive, with a matching Content-Length.
    res.writeHead(206, headers).end(fault === "short" ? bytes.subarray(0, bytes.length >> 1) : bytes);
  };
  return handle;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => (s.closeAllConnections(), s.close(done)))));
});

async function serve(handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function follow(url: string, env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_(URL|TOKEN)$/.test(k)));
  const child = spawn("sh", [JOBS, "log", ID, "-f"], { env: { ...clean, JS_URL: url, JS_TOKEN: "t", JOBS_CALL_TIMEOUT: "2", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => child.on("close", (code) => done({ code, stdout, stderr })));
}

const LINES = Array.from({ length: 6 }, (_, i) => `line ${i + 1}\n`);

describe("jobs log -f", () => {
  it("ends when the log it has not read is no longer kept, rather than polling", async () => {
    const url = await serve((req, res) => {
      if (req.url === `/runs/${ID}`) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: ID, state: "succeeded", exit: 0, reason: null }));
      res.writeHead(206, { "content-range": "bytes */12", "run-state": "succeeded", "content-type": "text/plain" }).end();
    });
    const run = await follow(url);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("from byte 0 of 12, is no longer kept");
  }, 30_000);

  it("rides out a dropped connection, a 503, a short read and a timeout, and prints each line once", async () => {
    const url = await serve(stub([...LINES], { state: "succeeded", exit: 0 }, ["drop", "503", "short", "hang"]));
    const run = await follow(url);
    expect(run.stdout).toBe(LINES.join(""));
    expect(run.code).toBe(0);
    for (const why of ["curl exit 52", "HTTP 503", "a short read", "curl exit 28"]) expect(run.stderr).toContain(why);
  }, 60_000);

  it("exits with the job's exit code when it failed", async () => {
    const url = await serve(stub([...LINES], { state: "failed", exit: 3 }, ["drop"]));
    const run = await follow(url);
    expect(run.stdout).toBe(LINES.join(""));
    expect(run.code).toBe(3);
  }, 30_000);

  it("exits 75, not curl's code, when job-service stays unreachable", async () => {
    const url = await serve((req) => req.socket.destroy());
    const run = await follow(url, { JOBS_RETRY_FOR: "2" });
    expect(run.code).toBe(75);
    expect(run.stderr).toContain("cannot reach job-service");
  }, 30_000);
});

/** A stub that records each call and answers `{}`. */
async function recording() {
  const calls: { method: string; url: string; who: string | undefined; body: string }[] = [];
  const url = await serve((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, who: req.headers["claimed-by"] as string | undefined, body });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  return { url, calls };
}

function jobs(url: string, args: string[], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_(URL|TOKEN|CLAIMED_BY)$/.test(k) && k !== "CLAUDE_CONFIG_DIR"));
  const child = spawn("sh", [JOBS, ...args], { env: { ...clean, JS_URL: url, JS_TOKEN: "t", ...env } });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<{ code: number | null; stderr: string }>((done) => child.on("close", (code) => done({ code, stderr })));
}

describe("jobs submit --for and list --for", () => {
  it("submits what the run is for, as the session's worker", async () => {
    const { url, calls } = await recording();
    const run = await jobs(url, ["submit", "--for", "item:28af81bc", "a/b", COMMIT_SHA, "test", "--x"], { CLAUDE_CONFIG_DIR: "/w/d03e1824-3c95ed51/home/.claude" });
    expect(run.code).toBe(0);
    expect(calls[0]!.method + " " + calls[0]!.url).toBe("POST /runs");
    expect(calls[0]!.who).toBe("d03e1824-3c95ed51");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ repo: "a/b", job: "test", args: ["--x"], for: { kind: "item", id: "28af81bc" } });
  });

  it("submits for nothing without --for, and with no routine without --routine", async () => {
    const { url, calls } = await recording();
    expect((await jobs(url, ["submit", "a/b", COMMIT_SHA, "test"])).code).toBe(0);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ for: null, routine: null, host: null });
  });

  it("submits a routine and its target, with --for in either order", async () => {
    const { url, calls } = await recording();
    const R = "862d32fbe2a988fb533215c156cf058191ec54b9";
    const run = await jobs(url, ["submit", "--routine", "o/routines", R, "o/b", "--for", "batch:7", "--host", "laptop", "o/b", COMMIT_SHA, "deploy-beta"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      repo: "o/b",
      commit: COMMIT_SHA,
      job: "deploy-beta",
      args: [],
      for: { kind: "batch", id: "7" },
      routine: { repo: "o/routines", commit: R, dir: "o/b" },
      host: "laptop",
    });
  });

  it("lists by what runs were for, and by state", async () => {
    const { url, calls } = await recording();
    expect((await jobs(url, ["list", "--for", "change:dakotacolorado/a#9", "failed"])).code).toBe(0);
    expect((await jobs(url, ["list", "running"])).code).toBe(0);
    expect(calls.map((c) => c.url)).toEqual(["/runs?for=change%3Adakotacolorado%2Fa%239&state=failed", "/runs?state=running"]);
  });

  it("refuses a kind it does not know, calling nothing", async () => {
    const { url, calls } = await recording();
    const run = await jobs(url, ["submit", "--for", "epic:x", "a/b", COMMIT_SHA, "test"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--for takes KIND:ID");
    expect(calls).toEqual([]);
  });
});
