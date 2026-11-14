import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import type { Host, Run } from "./domain.ts";
import { mcpDocument, renderMcp, renderMcpHtml } from "./mcp-doc.ts";
import { MCP_DOC, MCP_FILE, MCP_PAGE, openApiDocument } from "./spec.ts";
import { Store } from "./store.ts";
import { startNext } from "./testing.ts";

const TOKEN = "submitter";
const REGISTRATION = "registration";
const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function setup() {
  const store = Store.open(":memory:");
  const api = new JobApi(store, { submitter: TOKEN, registration: REGISTRATION }, {
    version: "0.1.0",
    commit: "x",
  });
  const fetch = (path: string, auth: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    api.fetch(
      new Request(`http://local${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${auth}`, ...init.headers },
        body: init.body === undefined ? undefined : init.body instanceof Uint8Array ? init.body : JSON.stringify(init.body),
      }),
    );
  const rpc = (auth: string, method: string, params: unknown, headers: Record<string, string> = {}) =>
    fetch("/mcp", auth, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: { jsonrpc: "2.0", id: 1, method, params },
    });
  /** A tool's answer: its JSON, and whether it is an error. */
  const use = async <T = unknown>(name: string, args: unknown, headers: Record<string, string> = {}) => {
    const res = await rpc(TOKEN, "tools/call", { name, arguments: args }, headers);
    expect(res.status).toBe(200);
    const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as T };
  };
  /** A host, as job-runner is: registered, taking runs and appending under its own token. */
  const host = async () => {
    const reg = await fetch("/hosts", REGISTRATION, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { name: "host", os: "linux", arch: "x86_64", capacity: { cpu: 1, memory: 2048, gpu: 0, gpuMemory: 0 } },
    });
    const { host: me, token } = (await reg.json()) as { host: Host; token: string };
    const claim = async () => startNext(store, me.id)!.run;
    const append = (id: string, text: string, start: number) => {
      const bytes = new TextEncoder().encode(text);
      return fetch(`/runs/${id}/log`, token, {
        method: "PATCH",
        headers: { "content-type": "application/octet-stream", "content-range": `bytes ${start}-${start + bytes.length - 1}/*` },
        body: bytes,
      });
    };
    return { claim, append };
  };
  return { rpc, use, host, fetch };
}

describe("the MCP server", () => {
  it("takes the submitters' token, and none other", async () => {
    const { rpc } = setup();
    expect((await rpc("nobody", "tools/list", {})).status).toBe(401);
    expect((await rpc(REGISTRATION, "tools/list", {})).status).toBe(401);
  });

  it("submits a labeled run, follows its log, finds it by label, and cancels it", async () => {
    const { use, host } = setup();
    const submitted = await use<Run>("submit_run", { repo: "dakotacolorado/python-template", commit: COMMIT, job: "hello", labels: { by: "agent-7" } });
    expect(submitted.isError).toBe(false);
    expect(submitted.json).toMatchObject({ state: "pending", labels: { by: "agent-7" }, args: [] });
    const run = submitted.json;

    const r = await host();
    expect((await r.claim()).id).toBe(run.id);
    await r.append(run.id, "hello\n", 0);
    type Log = { state: string; offset: number; size: number; next: number; log: string };
    const first = (await use<Log>("get_run_log", { id: run.id })).json;
    expect(first).toEqual({ state: "running", attempt: 1, offset: 0, size: 6, next: 6, log: "hello\n" });
    await r.append(run.id, "wörld\n", 6);
    expect((await use<Log>("get_run_log", { id: run.id, offset: first.next })).json).toMatchObject({ log: "wörld\n", size: 13, next: 13 });
    expect((await use<Log>("get_run_log", { id: run.id, offset: 13 })).json).toMatchObject({ log: "", next: 13 });

    expect((await use<{ runs: Run[] }>("list_runs", { state: "running" })).json.runs.map((each) => each.id)).toEqual([run.id]);
    expect((await use<{ runs: Run[] }>("list_runs", { label: "by=agent-7" })).json.runs.map((each) => each.id)).toEqual([run.id]);
    const next = await use<Run>("submit_run", { repo: "dakotacolorado/python-template", commit: COMMIT, job: "hello", priority: 5 });
    expect((await use<{ runs: Run[] }>("list_queue", {})).json.runs.map((each) => each.id)).toEqual([next.json.id]);
    expect((await use<{ hosts: Host[] }>("list_hosts", {})).json.hosts).toHaveLength(1);
    expect((await use<Run>("cancel_run", { id: run.id })).json).toMatchObject({ id: run.id, cancelRequested: true });
    expect((await use<Run>("get_run", { id: run.id })).json.cancelRequested).toBe(true);
  });

  it("answers an API refusal as the tool's error, in the API's words", async () => {
    const { use } = setup();
    const missing = await use<{ code: string; message: string }>("get_run", { id: "00000000-0000-4000-8000-000000000000" });
    expect(missing).toEqual({ isError: true, json: { code: "ResourceNotFoundException", message: "no run 00000000-0000-4000-8000-000000000000" } });
    expect((await use("get_run_log", { id: "00000000-0000-4000-8000-000000000000" })).isError).toBe(true);
  });

  it("has one tool per operation the submitters' token calls, named the same in snake_case", async () => {
    const { paths } = await openApiDocument();
    const snake = (id: string) => id.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    // The host protocol takes a host's token, or the registration token; Platform is health.
    const submitters = Object.values(paths)
      .flatMap((methods) => Object.values(methods))
      .filter((op) => !op.tags?.includes("Platform") && op.operationId !== "RegisterHost" && op.security?.some((s) => typeof s === "object" && s !== null && "bearerAuth" in s))
      .map((op) => snake(op.operationId));
    expect((await mcpDocument()).tools.map((tool) => tool.name).sort()).toEqual(submitters.sort());
  });
});

describe("mcp.json, docs/MCP.md and docs/mcp.html", () => {
  it("match what the server serves", async () => {
    const served = await mcpDocument();
    expect(JSON.parse(readFileSync(MCP_FILE, "utf8"))).toEqual(served);
    expect(readFileSync(MCP_DOC, "utf8")).toBe(renderMcp(served));
    expect(readFileSync(MCP_PAGE, "utf8")).toBe(renderMcpHtml(served));
  });

  it("are served without a token, giving the address they were reached at", async () => {
    const { fetch } = setup();
    const page = await fetch("/docs/mcp", "", { headers: { host: "beta.example.ts.net:8445", "x-forwarded-proto": "https" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("https://beta.example.ts.net:8445/mcp");
    expect(html).not.toContain("127.0.0.1");
    const forged = await (await fetch("/docs/mcp", "", { headers: { host: "x\"><script>" } })).text();
    expect(forged).not.toContain("<script>");
    expect((await fetch("/mcp.json", "")).status).toBe(200);
  });
});
