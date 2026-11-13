#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { banner } from "./banner.ts";
import { PACKAGE_VERSION } from "./build.ts";
import { start, type Running } from "./server.ts";
import { Store } from "./store.ts";

const USAGE = `job-service v${PACKAGE_VERSION}: runs of jobs, claimed by runners, over HTTP, on SQLite.

Usage:
  job-service [serve] [options]   run the server
  job-service backup <file>       copy the database, consistent while the server runs, to <file>

Options:
  --host <addr>   address to listen on (default 127.0.0.1, or JOB_SERVICE_HOST)
  --port <n>      port (default 4500, or JOB_SERVICE_PORT)
  --db <path>     the SQLite file (default ~/.local/share/job-service/job-service.db, or JOB_SERVICE_DB)
  --public-url <url>  its address behind a proxy, as https://host:8445: what the banner
                  gives (default this server's own, or JOBBER_PUBLIC_URL)
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
    "public-url": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const fail = (message: string): never => {
  process.stderr.write(`job-service: ${message}\n`);
  process.exit(1);
};

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const env = process.env;
const db = values.db ?? env.JOB_SERVICE_DB ?? join(homedir(), ".local", "share", "job-service", "job-service.db");
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

const host = values.host ?? env.JOB_SERVICE_HOST ?? "127.0.0.1";
const port = Number(values.port ?? env.JOB_SERVICE_PORT ?? 4500);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`--port must be a port number, not ${values.port ?? env.JOB_SERVICE_PORT}`);

const running: Running = start({ db: path, tokens: { submitter: env.AUTH_TOKEN || null, registration: env.RUNNER_TOKEN || null } });
const shown = (at: number) => `http://${host.includes(":") ? `[${host}]` : host}:${at}`;
const server = serve({ fetch: running.api.fetch, hostname: host, port }, (info) => {
  const missing = ["AUTH_TOKEN", "RUNNER_TOKEN"].filter((name) => !env[name]);
  const publicUrl = (values["public-url"] ?? env.JOBBER_PUBLIC_URL ?? shown(info.port)).replace(/\/+$/, "");
  const color = Boolean(process.stdout.isTTY) && !env.NO_COLOR;
  process.stdout.write(banner({ version: PACKAGE_VERSION, url: shown(info.port), publicUrl, db: path, missing, color }));
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
