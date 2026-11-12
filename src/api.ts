import { OpenAPIHono } from "@hono/zod-openapi";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  admittedMemory,
  appendAt,
  canceled,
  claimed,
  finished,
  fits,
  leaseFrom,
  LEASE_SECONDS,
  newId,
  now,
  ownRunning,
  parseFor,
  RequestError,
  sameEnd,
  stamp,
  submitted,
  type Run,
  type Runner,
} from "./domain.ts";
import { LOCAL_URL, mcpServer, type Call } from "./mcp.ts";
import * as routes from "./schema.ts";
import type { Skill } from "./skill.ts";
import type { Store, StoredRunner } from "./store.ts";

export const SPEC_PATH = "/openapi.json";

export interface Tokens {
  /** Submitters': submit, read and cancel runs, list runners. Null: every such call answers 503. */
  submitter: string | null;
  /** Registers runners, and nothing else: each runner then calls with a token of its own. */
  registration: string | null;
}

export interface About {
  /** `package.json`'s version. */
  version: string;
  /** The commit it was built from, `-dirty` when built with uncommitted changes. */
  commit: string;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

const same = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

const publicRunner = ({ tokenHash: _, ...runner }: StoredRunner): Runner => runner;

export class JobApi {
  readonly hono: OpenAPIHono;

  private readonly store: Store;
  private readonly tokens: Tokens;
  private readonly skill: () => Skill;
  private readonly about: About;

  constructor(store: Store, tokens: Tokens, skill: () => Skill, about: About) {
    this.store = store;
    this.tokens = tokens;
    this.skill = skill;
    this.about = about;
    this.hono = new OpenAPIHono({
      defaultHook: (result, c) => (result.success ? undefined : c.json({ error: issues(result.error) }, 400)),
    });
    this.auth();
    this.routes();
    this.mcp();
    this.pages();
    this.spec();
  }

  get fetch() {
    return this.hono.fetch;
  }

  private auth(): void {
    const bearer = (token: string | null) => async (c: Context, next: Next) => {
      if (!token) return c.json({ error: "API token is not configured." }, 503);
      const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      if (!given || !same(given, token)) return c.json({ error: "Unauthorized." }, 401);
      await next();
    };
    const submitter = bearer(this.tokens.submitter);
    // A runner writes a run with PUT and PATCH, under its own token, checked by the route.
    const submitterReads = (c: Context, next: Next) => (["PUT", "PATCH"].includes(c.req.method) ? next() : submitter(c, next));
    this.hono.use("/skill", submitter);
    this.hono.use("/mcp", submitter);
    this.hono.use("/runs", submitter);
    this.hono.use("/runs/*", submitterReads);
    this.hono.on("POST", "/runners", bearer(this.tokens.registration));
    this.hono.on("GET", "/runners", submitter);
  }

  /** The runner whose own token the request carries: 401 for any other token. */
  private caller(c: Context): StoredRunner {
    const given = /^Bearer ([0-9a-f-]{36})\.(.+)$/.exec(c.req.header("authorization") ?? "");
    const runner = given ? this.store.runner(given[1]!) : null;
    const ok = runner && given && timingSafeEqual(Buffer.from(hash(given[2]!)), Buffer.from(runner.tokenHash));
    if (!ok) throw new RequestError("not a runner's token", 401);
    return runner;
  }

  private found(id: string): Run {
    const run = this.store.run(id);
    if (!run) throw new RequestError(`no run ${id}`, 404);
    return run;
  }

  private routes(): void {
    const app = this.hono;

    app.openapi(routes.healthRoute, (c) => c.json({ ok: true as const, ...this.about }, 200));

    app.openapi(routes.skillRoute, (c) => c.json(this.skill(), 200));

    app.openapi(routes.submitRoute, (c) => {
      const run = submitted(c.req.valid("json"), c.req.valid("header")["claimed-by"] ?? null);
      this.store.create(run);
      return c.json(run, 201);
    });

    app.openapi(routes.listRoute, (c) => {
      const { state, repo, submittedBy, for: f, limit } = c.req.valid("query");
      const runs = this.store.runs({ state, repo, submittedBy, ...(f !== undefined && { for: parseFor(f) }), limit });
      return c.json({ runs }, 200);
    });

    app.openapi(routes.getRoute, (c) => c.json(this.found(c.req.valid("param").id), 200));

    app.openapi(routes.logRoute, (c) => {
      const run = this.found(c.req.valid("param").id);
      const range = c.req.valid("header").range;
      const from = range ? Number(range.slice("bytes=".length, -1)) : 0;
      if (from > run.logSize) {
        c.header("content-range", `bytes */${run.logSize}`);
        throw new RequestError(`the log is ${run.logSize} bytes; there is nothing from ${from}`, 416);
      }
      const bytes = this.store.log(run, from, routes.LOG_READ_MAX);
      c.header("content-range", bytes.length ? `bytes ${from}-${from + bytes.length - 1}/${run.logSize}` : `bytes */${run.logSize}`);
      c.header("run-state", run.state);
      c.header("content-type", "text/plain; charset=utf-8");
      return c.body(bytes as Uint8Array<ArrayBuffer>, 206) as never;
    });

    app.openapi(routes.cancelRoute, (c) => {
      const run = this.found(c.req.valid("param").id);
      const next = canceled(run);
      // A running run that ends meanwhile is answered as it ended.
      if (run.state === "pending") this.store.update(next, run.updatedAt);
      else this.store.requestCancel(run.id, next.updatedAt);
      return c.json(this.found(run.id), 200);
    });

    app.openapi(routes.registerRoute, (c) => {
      const draft = c.req.valid("json");
      const secret = randomBytes(32).toString("base64url");
      const at = now();
      const runner: StoredRunner = { ...draft, id: newId(), createdAt: at, lastSeenAt: at, tokenHash: hash(secret) };
      this.store.createRunner(runner);
      return c.json({ runner: publicRunner(runner), token: `${runner.id}.${secret}` }, 201);
    });

    app.openapi(routes.runnersRoute, (c) => {
      const runners = this.store
        .runners()
        .map(publicRunner)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
      return c.json({ runners }, 200);
    });

    app.openapi(routes.claimRoute, (c) => {
      const runner = this.caller(c);
      if (runner.id !== c.req.valid("param").id) throw new RequestError("not this runner's token", 403);
      const { labels, free, hostId, can } = c.req.valid("json");
      this.store.seen(runner.id, now(), hostId);
      for (const run of this.store.pending()) {
        if (!fits(run, { labels: labels ?? runner.labels, free, can, hostId: hostId ?? runner.hostId })) continue;
        const next = claimed(run, runner.id);
        try {
          this.store.update(next, run.updatedAt);
        } catch (err) {
          // Canceled since it was read: try the next.
          if (err instanceof RequestError && err.status === 409) continue;
          throw err;
        }
        return c.json({ run: next, memory: admittedMemory(next), lease: LEASE_SECONDS }, 200);
      }
      return c.body(null, 204);
    });

    app.openapi(routes.appendRoute, async (c) => {
      const runner = this.caller(c);
      const id = c.req.valid("param").id;
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      // Read after the body: another append may have landed while it arrived.
      const run = this.found(id);
      ownRunning(run, runner.id);
      const range = c.req.valid("header")["content-range"];
      if (!range && bytes.length) throw new RequestError("an append with a body needs Content-Range: bytes S-E/*", 400);
      const [start, end] = range
        ? (range.slice("bytes ".length).split("/")[0]!.split("-").map(Number) as [number, number])
        : [run.logSize, run.logSize - 1];
      if (end - start + 1 !== bytes.length) throw new RequestError(`Content-Range says ${end - start + 1} bytes; the body has ${bytes.length}`, 400);
      try {
        appendAt(run, start, bytes.length);
      } catch (err) {
        if (err instanceof RequestError && err.status === 416) return c.json({ error: err.message, size: run.logSize }, 416);
        throw err;
      }
      const at = stamp(run);
      const next = this.store.append(run, start, bytes, leaseFrom(at), at);
      return c.json({ size: next.logSize, canceled: next.cancelRequested, leaseExpiresAt: next.leaseExpiresAt! }, 200);
    });

    app.openapi(routes.runsWithRoute, (c) => {
      const runner = this.caller(c);
      const run = this.found(c.req.valid("param").id);
      ownRunning(run, runner.id);
      return c.json(this.store.runsWith(run, c.req.valid("json"), stamp(run)), 200);
    });

    app.openapi(routes.reportRoute, (c) => {
      const runner = this.caller(c);
      const run = this.found(c.req.valid("param").id);
      const report = c.req.valid("json");
      if (run.runner === runner.id && run.state !== "running" && sameEnd(run, report)) return c.json(run, 200);
      ownRunning(run, runner.id);
      const next = finished(run, report);
      this.store.update(next, run.updatedAt);
      return c.json(next, 200);
    });

    // Hono throws HTTPException for a malformed body before any handler runs;
    // collapsing this to 500 would report a bad request as our failure.
    app.onError((err, c) => {
      if (err instanceof RequestError) return c.json({ error: err.message }, err.status);
      if (err instanceof HTTPException) return c.json({ error: err.message || "Bad request." }, err.status);
      console.error("Unhandled error:", err);
      return c.json({ error: "Internal error." }, 500);
    });
  }

  /**
   * The MCP server, at `/mcp`, stateless: each request gets its own, whose
   * tools make their API requests in-process with the request's own
   * `authorization` and `claimed-by`.
   */
  private mcp(): void {
    this.hono.all("/mcp", async (c) => {
      const authorization = c.req.header("authorization")!;
      const claimedBy = c.req.header("claimed-by");
      const call: Call = (method, path, init = {}) =>
        Promise.resolve(
          this.hono.fetch(
            new Request(`http://local${path}`, {
              method,
              headers: {
                authorization,
                ...(init.body !== undefined && { "content-type": "application/json" }),
                ...(claimedBy && { "claimed-by": claimedBy }),
                ...init.headers,
              },
              body: init.body === undefined ? undefined : JSON.stringify(init.body),
            }),
          ),
        );
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await mcpServer(this.about.version, call).connect(transport);
      return transport.handleRequest(c.req.raw);
    });
  }

  /** The API's and the MCP server's docs, read at their first request: none needs a token, and none holds data. */
  private pages(): void {
    const files = new Map<string, string>();
    const file = (path: string) => {
      if (!files.has(path)) files.set(path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
      return files.get(path)!;
    };
    const page = (path: string, type: string) => (c: Context) => c.body(file(path), 200, { "content-type": `${type}; charset=utf-8` });
    this.hono.get("/docs/api", page("docs/index.html", "text/html"));
    this.hono.get("/mcp.json", page("mcp.json", "application/json"));
    // The docs' example address is a local one; served, they give the address they were reached at.
    this.hono.get("/docs/mcp", (c) => {
      const url = new URL(c.req.url);
      const proto = c.req.header("x-forwarded-proto") ?? url.protocol.slice(0, -1);
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
      // Reflected into the page: only what an address can be.
      const at = /^https?$/.test(proto) && /^[\w.-]+(:\d+)?$/.test(host) ? `${proto}://${host}` : LOCAL_URL;
      return c.body(file("docs/mcp.html").replaceAll(LOCAL_URL, at), 200, { "content-type": "text/html; charset=utf-8" });
    });
  }

  private spec(): void {
    this.hono.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer" });
    this.hono.openAPIRegistry.registerComponent("securitySchemes", "runnerAuth", {
      type: "http",
      scheme: "bearer",
      description: "A runner's own token, `<runner id>.<secret>`, as `registerRunner` answered it.",
    });
    this.hono.doc(SPEC_PATH, {
      openapi: "3.1.0",
      info: {
        version: "0.1.0",
        title: "job-service",
        description:
          "A job is a named script in a repo's `jobs.toml`; a run is one execution of it, to completion at one commit, " +
          "by a runner that claims it. A run is submitted `pending`, claimed and `running`, and ends `succeeded`, " +
          "`failed` or `canceled` with its exit code, and says what it was for when its submitter said. Its log can be " +
          "read from any offset while it runs and after.",
      },
      tags: [{ name: "runs" }, { name: "runners" }, { name: "meta" }],
    });
  }
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
}
