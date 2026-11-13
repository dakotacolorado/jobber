# jobber

Submit code to run on whatever computers you have. Runs jobs on a fleet of hosts: a job is a named script in a repo's
`jobs.toml`, a run one execution of it at one commit, on a host the scheduler
pushes it to, which keeps it alive with heartbeats. Keep the model this simple: a run's
`requirements` and `labels`, hosts with capacity and metrics, nothing of any
one caller's (no release routines, no work-tracker kinds). One Node 24 process
(`src/cli.ts`) serving HTTP and the hosts' WebSockets (`src/connections.ts`),
its data in one SQLite file (`src/store.ts`), its scheduler
(`src/scheduler.ts`), lease sweep and log prune as in-process timers
(`src/sweep.ts`). Placing runs on hosts (`schedule`) is a pure function in
`src/domain.ts`; the host connection's messages are `docs/PROTOCOL.md`.

Keep it fact-dense: the code carries the facts. Prefer a mechanism to a
comment: a type, a test or a thrown error cannot rot. Comment only for a limit
a reader would otherwise violate, a deliberate choice that reads as a mistake,
or platform behaviour not visible in the source.

## Contract

`src/schema.ts` is the source of `openapi.json`, its AWS-layout reference
(`docs/API.md`, by `src/api-doc.ts`) and Redoc's page of it
(`docs/index.html`, served at `/docs/api`, as waypoint's is). `src/mcp.ts`,
whose tools are the API operations the submitters' token calls, is the
source of `mcp.json`, `docs/MCP.md` and `docs/mcp.html`. The MCP server is
the client: there is no other. The pre-commit hook regenerates all of them
(`npm run spec`); a test fails if any drifts.

Name an operation VerbNoun as AWS does, keep summaries to a few words,
describe every field, and answer errors as `{code, message}` with the
status's exception name (`ERROR_CODES`): tests hold all of it. Paths and
successful shapes are jobber-host's contract: change them with it.

The page is `ui/`, served as it is, with no build: it makes every element
as text, never HTML.

How a run moves between states is `src/domain.ts`, as pure functions: keep
every transition there, tested, and let the store only refuse a write that lost
a race. A database from an older shape is brought up to date when it opens
(`migrate` in `src/store.ts`), tested with one written in that shape.

## Tests

Colocated as `*.spec.ts`; test our rules, not the library's. `npm test` needs
no network: the store runs on SQLite in memory or in a temporary file, and
`src/cli.spec.ts` starts the server on ports the OS picks.
`integration.spec.ts` hits a running instance and skips without
`INTEGRATION_JS_URL`/`INTEGRATION_JS_TOKEN`. How to run the checks is the
`test` skill (`.claude/skills/test/SKILL.md`).
