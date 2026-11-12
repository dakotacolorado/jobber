# job-service

Runs of jobs. A **job** is a named script in a repo's `jobs.toml`; a **run**
is one execution of it, to completion at one commit, by a runner that claims
it. A run is submitted `pending`, claimed and `running`, and ends
`succeeded`, `failed` or `canceled` with its exit code. Its log can be read
from any offset while it runs and after.

One Node 24 process serves the HTTP API, an MCP server and a page, with
everything in one SQLite file. The page, at `/`, takes the submitters' token
(kept in the browser), lists runs by state with filters, shows a run and
follows its log, submits and cancels runs, and lists runners. The API's contract is [`openapi.json`](./openapi.json),
rendered in [`docs/API.md`](./docs/API.md) and served at `/docs/api`; the MCP
server's is [`mcp.json`](./mcp.json), rendered in [`docs/MCP.md`](./docs/MCP.md)
and served at `/docs/mcp`. Neither page needs a token.

`/mcp` is streamable HTTP, stateless, under the submitters' token: one tool per
operation that token calls (`submit_run`, `list_runs`, `get_run`,
`get_run_log`, `cancel_run`, `list_runners`), each one API request made with the
caller's `authorization` and `claimed-by`:

```json
{ "mcpServers": { "job-service": { "type": "http", "url": "https://<host>:8445/mcp", "headers": { "Authorization": "Bearer <AUTH_TOKEN>" } } } }
```

```
POST /runs               {repo, commit, job, args?, limits?, labels?, for?, routine?, host?}  → run, pending
GET  /runs?state=…&repo=…&submittedBy=…&for=<kind>:<id>
GET  /runs/{id}
GET  /runs/{id}/log      Range: bytes=N-     (Run-State says the run's state)
POST /runs/{id}/cancel
```

Runners call in, since hosts are behind NAT, after GitLab Runner's protocol:

```
POST  /runners               registration token → runner id and its own token
POST  /runners/{id}/claim    {labels?, can?, hostId?, free: {slots, memory}} → {run, memory, lease}, or 204
PATCH /runs/{id}/log         Content-Range: bytes S-E/* → {size, canceled, leaseExpiresAt}
PUT   /runs/{id}/runs-with   {memory, timeout, stall}
PUT   /runs/{id}             {state, exit, duration, reason?}
```

A claim is a conditional write, so two runners never get the same run. Each
log append lands at the log's current end or is refused (416, with the size
to resend from), and renews the run's 60 s lease; an empty append only renews
it. A timer in the process sweeps every minute and fails a running run whose
lease has lapsed; another, hourly, deletes log chunks over 90 days old. The
registration token (`RUNNER_TOKEN`) only registers: the runner then calls with
`<runner id>.<secret>`, which works for its own runs and nothing else.

What a run runs is the repo's business: `job` names a `[jobs.<name>]` in its
`jobs.toml` at `commit` (or in a routine's directory), which the runner reads
after checking it out; this service never reads the repo. `limits.memory` is
what a runner reserves for the run when it claims it; a run submitted without
one is admitted at 1024 MiB. Once its runner has read `jobs.toml`, the run's
`runsWith` says the memory, timeout and stall limit it actually runs with.
`labels` are what a runner must have, every key with that value.

## Run it

```sh
npm ci && npm run build
AUTH_TOKEN=… RUNNER_TOKEN=… node dist/cli.js --port 4500 --db ~/.local/share/job-service/job-service.db
node dist/cli.js backup /some/where/job-service.db   # consistent while it serves
```

`job-service --help` lists the options. `AUTH_TOKEN` is the submitters'
token, `RUNNER_TOKEN` the registration token; without one, what needs it
answers 503. `GET /health` answers the version and commit it runs, without a
token.

## On the hosts

Beta runs on `dakotajp-hp-laptop`, prod on `dakotajp-lenovo-laptop`, each at
`https://<host>.tail90863a.ts.net:8445` (`tailscale serve` to 127.0.0.1:4500),
from a checkout at the commit to release, as the hosts' user:

```sh
ops/deploy beta dakotajp-lenovo-laptop     # on the HP; prod: ops/deploy prod dakotajp-hp-laptop on the Lenovo
ops/runner beta <job-runner binary>        # the second job-runner, registered here (api = "runs")
ops/check                                  # a run of python-template's hello, claimed by it, to `succeeded`
```

`ops/deploy` installs the build under `~/.local/share/routines/job-service/`
(`current`, `previous`), makes the host's `AUTH_TOKEN` and `RUNNER_TOKEN` once
in `~/.config/job-service/env` (mode 600, never committed), restarts
`job-service.service`, checks `/health` answers the commit and puts the
previous release back if not, and installs `job-service-backup.timer`: each
night a consistent copy of `~/.local/share/job-service/job-service.db` goes
to the other host's `~/backups/job-service/`, 14 days kept. Run at an earlier
commit, it is the rollback. `ops/runner` installs `job-runner-local.service`
beside the host's own job-runner, which stays on the AWS job-service until
cutover, with its own config, identity, checkouts and `jobslocal.slice`.

## Client

`skill/bin/jobs` is the client a worker calls it with, served by `GET /skill`
with the reference it is generated from:

```sh
JS_URL=… JS_TOKEN=… skill/bin/jobs submit dakotacolorado/python-template <sha> hello
skill/bin/jobs log <id> -f      # follows it, then exits with the run's exit code
                                # (75 if job-service stays unreachable; a dropped call is retried and resumed)
skill/bin/jobs cancel <id>
```

## Develop

```sh
npm ci
AUTH_TOKEN=dev RUNNER_TOKEN=reg npm run dev    # on :4500, data in .job-service-dev.db (--port to change)
```

Checks: [the test skill](.claude/skills/test/SKILL.md).

This repo is `job-service-2` only while the AWS job-service is released from
`dakotacolorado/job-service`; everything in it is plain job-service.
