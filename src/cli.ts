#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PACKAGE_VERSION } from "./build.ts";
import { start, type Running } from "./server.ts";
import { Store } from "./store.ts";

const USAGE = `jobber v${PACKAGE_VERSION}: submit code to run on whatever computers you have available.

Usage:
  jobber [serve] [options]   run the server
  jobber backup <file>       copy the database, consistent while the server runs, to <file>

Options:
  --host <addr>   address to listen on (default 127.0.0.1, or JOBBER_HOST)
  --port <n>      port (default 4500, or JOBBER_PORT)
  --db <path>     the SQLite file (default ~/.local/share/jobber/jobber.db, or JOBBER_DB)
  -h, --help      this

Environment:
  AUTH_TOKEN      the submitters' bearer token: submit, read and cancel runs, list runners
  RUNNER_TOKEN    the registration token: registers runners, which then call with their own

Without AUTH_TOKEN, every call but /health, /openapi.json, /mcp.json and the
docs at /docs/api and /docs/mcp answers 503; without RUNNER_TOKEN, so does
registering a runner. /mcp is the MCP server, under AUTH_TOKEN.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    port: { type: "string" },
    db: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const fail = (message: string): never => {
  process.stderr.write(`jobber: ${message}\n`);
  process.exit(1);
};

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const env = process.env;
/** A JOBBER_* setting, else the JOB_SERVICE_* it was called before the rename, with a warning, so a host whose units still set the old names keeps working. */
const setting = (name: "PORT" | "HOST" | "DB"): string | undefined => {
  const now = env[`JOBBER_${name}`];
  if (now !== undefined) return now;
  const old = env[`JOB_SERVICE_${name}`];
  if (old !== undefined) process.stderr.write(`jobber: JOB_SERVICE_${name} is deprecated: set JOBBER_${name} instead\n`);
  return old;
};
const db = values.db ?? setting("DB") ?? join(homedir(), ".local", "share", "jobber", "jobber.db");
const path = db === ":memory:" ? db : resolve(db);
if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
const [command = "serve", file] = positionals;

if (command === "backup") {
  if (!file) fail("backup needs the file to write");
  const store = Store.open(path);
  try {
    const pages = await store.backup(resolve(file!));
    process.stdout.write(`backed up ${path} to ${resolve(file!)} (${pages} pages)\n`);
  } catch (err) {
    fail(`backup failed: ${(err as Error).message}`);
  }
  store.close();
  process.exit(0);
}

if (command !== "serve") fail(`unknown command "${command}"\n\n${USAGE}`);

const host = values.host ?? setting("HOST") ?? "127.0.0.1";
const portSetting = values.port ?? setting("PORT");
const port = Number(portSetting ?? 4500);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, not ${portSetting}`);

const running: Running = start({ db: path, tokens: { submitter: env.AUTH_TOKEN || null, registration: env.RUNNER_TOKEN || null } });
const server = serve({ fetch: running.api.fetch, hostname: host, port }, (info) => {
  const missing = [!env.AUTH_TOKEN && "AUTH_TOKEN", !env.RUNNER_TOKEN && "RUNNER_TOKEN"].filter(Boolean);
  process.stdout.write(
    `jobber v${PACKAGE_VERSION} on http://${host.includes(":") ? `[${host}]` : host}:${info.port}, data in ${path}` +
      (missing.length ? ` (${missing.join(" and ")} not set)` : "") +
      "\n",
  );
});

running.connections.attach(server as import("node:http").Server, (authorization, id) => running.api.hostAt(authorization, id));

server.on("error", (err) => {
  running.close();
  fail(`cannot serve on ${host}:${port}: ${err.message}`);
});

const stop = () => {
  server.close();
  running.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
