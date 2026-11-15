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
  finished,
  fits,
  leaseFrom,
  LEASE_SECONDS,
  newId,
  now,
  ownRunning,
  parseLabel,
  attemptOf,
  due,
  reprioritized,
  RequestError,
  sameEnd,
  submitted,
  type Host,
  type Run,
} from "./domain.ts";
import { LETTERS_ONLY, MARK_ICON, MARK_PIXELS, SUMMARY, TAGLINE } from "./banner.ts";
import { DOCS_URL, mcpServer, type Call } from "./mcp.ts";
import * as routes from "./schema.ts";
import { ERROR_CODES, type ErrorStatus } from "./schema.ts";
import { NO_LINK, type Link } from "./scheduler.ts";
import { Secrets } from "./secrets.ts";
import type { Store, StoredHost } from "./store.ts";

export const SPEC_PATH = "/openapi.json";

/** The API's version, dated as AWS dates theirs: changed only when the contract is. */
export const API_VERSION = "2026-11-13";

/** The API's overview, at the top of its reference. Markdown. */
export const OVERVIEW = `Submit code to run on whatever computers you have. A **job** is a named script in a repo's \`jobs.toml\`; a **run** is one execution of it at a commit.

- **Submit** a run, with a \`priority\` if it should jump the queue, see where it waits with \`ListQueue\`, then follow it: \`pending\` → \`assigned\` → \`running\` → \`succeeded\`, \`failed\` or \`canceled\`.
- **Read its log** with \`GetRunLog\`, from any byte offset, while it runs and after.
- **Hosts** are the computers that run jobber-host, which registers, holds a connection over which it is sent its runs, and reports their logs and ends through the *Host protocol* calls. You don't call those.

- **Secrets** are set by an admin (\`PutSecret\`), stored encrypted, and never read back: a run naming them in \`secrets\` is given each as an environment variable.

**Auth:** \`Authorization: Bearer <token>\` with the submitters' token, on everything but \`GetHealth\` and the *Secrets* calls, which take the admin's.

**Errors:** \`{code, message}\`, where \`code\` is an AWS-style exception name such as \`ValidationException\` or \`ResourceNotFoundException\`.`;

export interface Tokens {
  /** Submitters': submit, read and cancel runs, list and delete hosts. Null: every such call answers 503. */
  submitter: string | null;
  /** Registers hosts, and nothing else: each host then calls with a token of its own. */
  registration: string | null;
  /** Sets, lists and deletes secrets, and nothing else. Null or absent: every such call answers 503. */
  admin?: string | null;
}

export interface About {
  /** `package.json`'s version. */
  version: string;
  /** The commit it was built from, `-dirty` when built with uncommitted changes. */
  commit: string;
}

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

const same = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

const publicHost = ({ tokenHash: _, deletedAt: _d, ...host }: StoredHost, connected: boolean): Host & { connected: boolean } => ({ ...host, connected });

export class JobApi {
  readonly hono: OpenAPIHono;

  private readonly store: Store;
  private readonly tokens: Tokens;
  private readonly about: About;
  private readonly link: Link;
  private readonly secrets: Secrets;

  /** `link` reaches the connected hosts: `ListHosts` says which, and a cancel reaches a running run's host through it at once. */
  constructor(store: Store, tokens: Tokens, about: About, link: Link = NO_LINK, secrets = new Secrets(store.db, null)) {
    this.store = store;
    this.secrets = secrets;
    this.tokens = tokens;
    this.about = about;
    this.link = link;
    this.hono = new OpenAPIHono({
      defaultHook: (result, c) => (result.success ? undefined : fail(c, 400, issues(result.error))),
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
      if (!token) return fail(c, 503, "The service has no token configured for this call.");
      const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      if (!given || !same(given, token)) return fail(c, 401, "The bearer token is missing or wrong.");
      await next();
    };
    const submitter = bearer(this.tokens.submitter);
    // A host writes a run with PUT and PATCH, under its own token, checked by the route.
    const submitterReads = (c: Context, next: Next) => (["PUT", "PATCH"].includes(c.req.method) ? next() : submitter(c, next));
    this.hono.use("/mcp", submitter);
    this.hono.use("/runs", submitter);
    this.hono.use("/runs/*", submitterReads);
    this.hono.on("POST", "/hosts", bearer(this.tokens.registration));
    this.hono.on("GET", "/hosts", submitter);
    this.hono.on("DELETE", "/hosts/:id", submitter);
    this.hono.use("/secrets", bearer(this.tokens.admin ?? null));
    this.hono.use("/secrets/*", bearer(this.tokens.admin ?? null));
  }

  /** The host whose own token the request carries: 401 for any other token. */
  private caller(c: Context): StoredHost {
    return this.hostOf(c.req.header("authorization"));
  }

  /** The host whose own token `authorization` carries: 401 for any other. */
  hostOf(authorization: string | undefined): StoredHost {
    const given = /^Bearer ([0-9a-f-]{36})\.(.+)$/.exec(authorization ?? "");
    const host = given ? this.store.host(given[1]!) : null;
    const ok = host && given && timingSafeEqual(Buffer.from(hash(given[2]!)), Buffer.from(host.tokenHash));
    if (!ok) throw new RequestError("not a host's token", 401);
    return host;
  }

  /** The calling host, which must be the one the path names. */
  private pathHost(c: Context, id: string): StoredHost {
    return this.hostAt(c.req.header("authorization"), id);
  }

  /** The host `authorization` carries the token of, which must be host `id`: 401 or 403 otherwise. */
  hostAt(authorization: string | undefined, id: string): StoredHost {
    const host = this.hostOf(authorization);
    if (host.id !== id) throw new RequestError("not this host's token", 403);
    return host;
  }

  private found(id: string): Run {
    const run = this.store.run(id);
    if (!run) throw new RequestError(`no run ${id}`, 404);
    return run;
  }

  private routes(): void {
    const app = this.hono;

    app.openapi(routes.healthRoute, (c) => c.json({ ok: true as const, ...this.about }, 200));

    app.openapi(routes.submitRoute, (c) => {
      const draft = c.req.valid("json");
      const unknown = this.secrets.missing(draft.secrets);
      if (unknown.length) throw new RequestError(`secrets: no secret ${unknown.join(", ")} is set`, 400);
      if (draft.onHost && draft.requirements.host === null) throw new RequestError("requirements.host: a run onHost names the host it runs on", 400);
      if (draft.requirements.host !== null && !this.store.hostNamed(draft.requirements.host)) throw new RequestError(`requirements.host: no host ${draft.requirements.host} is registered`, 400);
      const run = submitted(draft);
      this.store.create(run);
      return c.json(run, 201);
    });

    app.openapi(routes.listRoute, (c) => {
      const { state, repo, label, limit } = c.req.valid("query");
      const labels = (label === undefined ? [] : [label].flat()).map(parseLabel);
      return c.json({ runs: this.store.runs({ state, repo, labels, limit }) }, 200);
    });

    app.openapi(routes.queueRoute, (c) => c.json({ runs: this.store.pending().slice(0, c.req.valid("query").limit) }, 200));

    app.openapi(routes.getRoute, (c) => c.json(this.found(c.req.valid("param").id), 200));

    app.openapi(routes.logRoute, (c) => {
      const run = this.found(c.req.valid("param").id);
      const n = c.req.valid("query").attempt ?? run.attempt;
      const attempt = attemptOf(run, n);
      if (!attempt) throw new RequestError(`run ${run.id} has no attempt ${n}`, 404);
      const range = c.req.valid("header").range;
      const from = range ? Number(range.slice("bytes=".length, -1)) : 0;
      if (from > attempt.logSize) {
        c.header("content-range", `bytes */${attempt.logSize}`);
        throw new RequestError(`the log is ${attempt.logSize} bytes; there is nothing from ${from}`, 416);
      }
      const bytes = this.store.log(run, from, routes.LOG_READ_MAX, n, attempt.logSize);
      c.header("content-range", bytes.length ? `bytes ${from}-${from + bytes.length - 1}/${attempt.logSize}` : `bytes */${attempt.logSize}`);
      c.header("run-state", attempt.state);
      c.header("run-attempt", String(n));
      c.header("content-type", "text/plain; charset=utf-8");
      return c.body(bytes as Uint8Array<ArrayBuffer>, 206) as never;
    });

    app.openapi(routes.cancelRoute, (c) => {
      const run = this.found(c.req.valid("param").id);
      const next = canceled(run);
      // A running run that ends meanwhile is answered as it ended.
      if (run.state === "pending" || run.state === "assigned") this.store.update(next, run.updatedAt);
      else if (this.store.requestCancel(run.id, next.updatedAt)) this.link.cancel(run.host!, run);
      return c.json(this.found(run.id), 200);
    });

    app.openapi(routes.priorityRoute, (c) => {
      const run = this.found(c.req.valid("param").id);
      const next = reprioritized(run, c.req.valid("json").priority);
      this.store.update(next, run.updatedAt);
      return c.json(next, 200);
    });

    app.openapi(routes.registerRoute, (c) => {
      const draft = c.req.valid("json");
      const secret = randomBytes(32).toString("base64url");
      const at = now();
      const before = this.store.hostNamed(draft.name, { deleted: true });
      const host: StoredHost = {
        ...draft,
        id: before?.id ?? newId(),
        // What it had free was of the capacity it registered before.
        free: null,
        metrics: before?.metrics ?? null,
        createdAt: before?.createdAt ?? at,
        lastSeenAt: at,
        tokenHash: hash(secret),
      };
      this.store.putHost(host);
      return c.json({ host: publicHost(host, new Set(this.link.connected()).has(host.id)), token: `${host.id}.${secret}` }, 201);
    });

    app.openapi(routes.hostsRoute, (c) => {
      const connected = new Set(this.link.connected());
      const hosts = this.store
        .hosts()
        .map((h) => publicHost(h, connected.has(h.id)))
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
      return c.json({ hosts }, 200);
    });

    app.openapi(routes.deleteHostRoute, (c) => {
      const { id } = c.req.valid("param");
      const was = this.store.deleteHost(id, now());
      if (!was) throw new RequestError(`no host ${id}`, 404);
      return c.json(publicHost(was, new Set(this.link.connected()).has(id)), 200);
    });

    app.openapi(routes.heartbeatRoute, (c) => {
      const host = this.pathHost(c, c.req.valid("param").id);
      const { free, metrics, running } = c.req.valid("json");
      const at = now();
      this.store.seen(host.id, at, { free, metrics });
      const { cancel, ended } = this.store.renew(host.id, running.map((id) => ({ id })), leaseFrom(at), at);
      return c.json({ cancel, ended, lease: LEASE_SECONDS }, 200);
    });

    app.openapi(routes.listSecretsRoute, (c) => c.json({ secrets: this.secrets.list() }, 200));

    app.openapi(routes.putSecretRoute, (c) => c.json(this.secrets.put(c.req.valid("param").name, c.req.valid("json").value, now()), 200));

    app.openapi(routes.deleteSecretRoute, (c) => {
      const { name } = c.req.valid("param");
      const was = this.secrets.delete(name);
      if (!was) throw new RequestError(`no secret ${name}`, 404);
      return c.json(was, 200);
    });

    // An upgrade is taken by `Connections` before it reaches here.
    app.openapi(routes.connectRoute, (c) => {
      this.pathHost(c, c.req.valid("param").id);
      throw new RequestError("GET /hosts/{id}/connect opens a WebSocket: send it as an upgrade", 426);
    });

    app.openapi(routes.appendRoute, async (c) => {
      const host = this.caller(c);
      const id = c.req.valid("param").id;
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      // Read after the body: another append may have landed while it arrived.
      const run = this.found(id);
      ownRunning(run, host.id, c.req.valid("query").attempt);
      const range = c.req.valid("header")["content-range"];
      const [start, end] = range.slice("bytes ".length).split("/")[0]!.split("-").map(Number) as [number, number];
      if (end - start + 1 !== bytes.length) throw new RequestError(`Content-Range says ${end - start + 1} bytes; the body has ${bytes.length}`, 400);
      try {
        appendAt(run, start, bytes.length);
      } catch (err) {
        if (err instanceof RequestError && err.status === 416) return c.json({ code: ERROR_CODES[416], message: err.message, size: run.logSize }, 416);
        throw err;
      }
      const next = this.store.append(run, start, bytes, now());
      return c.json({ size: next.logSize }, 200);
    });

    app.openapi(routes.reportRoute, (c) => {
      const host = this.caller(c);
      const run = this.found(c.req.valid("param").id);
      const report = c.req.valid("json");
      const attempt = c.req.valid("query").attempt;
      // A host resending how an attempt ended, its first answer lost: that attempt may since have been retried.
      const repeated =
        run.host === host.id && run.state !== "running" && (attempt ?? run.attempt) === run.attempt
          ? run
          : run.attempts.findLast((a) => a.host === host.id && (attempt === undefined || a.attempt === attempt));
      if (repeated && sameEnd(repeated, report)) return c.json(run, 200);
      ownRunning(run, host.id, attempt);
      const next = finished(run, report);
      this.store.update(next, run.updatedAt);
      return c.json(next, 200);
    });

    // Hono throws HTTPException for a malformed body before any handler runs;
    // collapsing this to 500 would report a bad request as our failure.
    app.onError((err, c) => {
      if (err instanceof RequestError) return fail(c, err.status, err.message);
      if (err instanceof HTTPException) return fail(c, err.status in ERROR_CODES ? (err.status as ErrorStatus) : 400, err.message || "The request is malformed.");
      console.error("Unhandled error:", err);
      return fail(c, 500, "Something went wrong on our side.");
    });
  }

  /**
   * The MCP server, at `/mcp`, stateless: each request gets its own, whose
   * tools make their API requests in-process with the request's own
   * `authorization`.
   */
  private mcp(): void {
    this.hono.all("/mcp", async (c) => {
      const authorization = c.req.header("authorization")!;
      const call: Call = (method, path, init = {}) =>
        Promise.resolve(
          this.hono.fetch(
            new Request(`http://local${path}`, {
              method,
              headers: {
                authorization,
                ...(init.body !== undefined && { "content-type": "application/json" }),
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

  /** The page, and the API's and the MCP server's docs, read at their first request: none needs a token, and none holds data. */
  private pages(): void {
    const files = new Map<string, string>();
    const file = (path: string) => {
      if (!files.has(path)) files.set(path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
      return files.get(path)!;
    };
    const page = (path: string, type: string) => (c: Context) => c.body(file(path), 200, { "content-type": `${type}; charset=utf-8` });
    this.hono.get("/", page("ui/index.html", "text/html"));
    this.hono.get("/ui/app.js", page("ui/app.js", "text/javascript"));
    this.hono.get("/ui/style.css", page("ui/style.css", "text/css"));
    // The page's words and mark are banner.ts's own, so the terminal, the page and the tab cannot differ.
    const banner = Object.entries({ LETTERS: LETTERS_ONLY, MARK_PIXELS, TAGLINE, SUMMARY }).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};\n`).join("");
    this.hono.get("/ui/banner.js", (c) => c.body(banner, 200, { "content-type": "text/javascript; charset=utf-8" }));
    this.hono.get("/ui/mark.svg", (c) => c.body(MARK_ICON, 200, { "content-type": "image/svg+xml; charset=utf-8" }));
    this.hono.get("/docs/api", page("docs/index.html", "text/html"));
    this.hono.get("/mcp.json", page("mcp.json", "application/json"));
    // The docs' example address is a placeholder; served, they give the address they were reached at.
    this.hono.get("/docs/mcp", (c) => {
      const url = new URL(c.req.url);
      const proto = c.req.header("x-forwarded-proto") ?? url.protocol.slice(0, -1);
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
      // Reflected into the page: only what an address can be.
      const at = /^https?$/.test(proto) && /^[\w.-]+(:\d+)?$/.test(host) ? `${proto}://${host}` : DOCS_URL;
      return c.body(file("docs/mcp.html").replaceAll(DOCS_URL, at), 200, { "content-type": "text/html; charset=utf-8" });
    });
  }

  private spec(): void {
    this.hono.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer" });
    this.hono.openAPIRegistry.registerComponent("securitySchemes", "adminAuth", {
      type: "http",
      scheme: "bearer",
      description: "The admin's token, `ADMIN_TOKEN`: it manages secrets, and nothing else.",
    });
    this.hono.openAPIRegistry.registerComponent("securitySchemes", "hostAuth", {
      type: "http",
      scheme: "bearer",
      description: "A host's own token, `<host id>.<secret>`, as `RegisterHost` answered it.",
    });
    this.hono.doc(SPEC_PATH, {
      openapi: "3.1.0",
      info: { version: API_VERSION, title: "jobber", description: OVERVIEW },
      tags: [
        { name: "Runs", description: "Submit, follow and cancel runs." },
        { name: "Hosts", description: "See the fleet." },
        { name: "Secrets", description: "Set the secrets runs are given, by an admin." },
        { name: "Host protocol", description: "Called by jobber-host on each computer, not by you." },
        { name: "Platform", description: "Health." },
      ],
    });
  }
}

/** An error answer as an AWS API gives one: `{code, message}`, the code named for the status. */
function fail(c: Context, status: ErrorStatus, message: string) {
  return c.json({ code: ERROR_CODES[status], message }, status);
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
}
