# job-service

Runs jobs on a fleet of hosts. A **job** is a named script in a repo's
`jobs.toml`; a **run** is one execution of it at one commit, on a **host** that
claims it. A run is submitted `pending`, claimed and `running`, and ends
`succeeded`, `failed` or `canceled` with its exit code. Its log can be read
from any offset while it runs and after.

One Node 24 process serves the HTTP API, an MCP server and a page, with
everything in one SQLite file. The page, at `/`, takes the submitters' token
(kept in the browser), lists runs by state and label, shows a run and follows
its log, submits and cancels runs, and lists the hosts with their health. The
API's contract is [`openapi.json`](./openapi.json), rendered as an AWS API
reference in [`docs/API.md`](./docs/API.md), and by Redoc at `/docs/api`. The
MCP server's is [`mcp.json`](./mcp.json), rendered in
[`docs/MCP.md`](./docs/MCP.md) and served at `/docs/mcp`.

```
POST /runs               {repo, commit, job, args?, requirements?: {os, arch, memory, timeout}, labels?}  → run, pending
GET  /runs?state=…&repo=…&label=key=value
GET  /runs/{id}
GET  /runs/{id}/log      Range: bytes=N-     (Run-State says the run's state)
POST /runs/{id}/cancel
GET  /hosts              each host with its capacity, free capacity and metrics
```

`requirements` is everything a run needs from its host in one place; a host
claims a run when its os and arch match and its free memory covers the run's
(1024 MiB when none is given). `labels` describe the run, free-form (what it
is for, who asked), and `ListRuns` filters by them.

Hosts run job-runner, which calls in (hosts are behind NAT) and is never called:

```
POST  /hosts                 registration token → host id and its own token (same name again: same id, new token)
POST  /hosts/{id}/heartbeat  {free, metrics, running: [run ids]} → {cancel: [run ids], lease}
POST  /hosts/{id}/claim      {free: {slots, memory}} → {run, memory, lease}, or 204
PATCH /runs/{id}/log         Content-Range: bytes S-E/* → {size}
PUT   /runs/{id}             {state, exit, duration, reason?}
```

A claim is a conditional write, so two hosts never get the same run. A
running run's 60 s lease is renewed by its host's heartbeat, which a host sends
every few seconds with its free capacity and metrics (CPU load, memory, free
disk); a timer sweeps every minute and fails a running run whose lease lapsed,
and another, hourly, deletes log chunks over 90 days old. Each log append lands
at the log's current end or is refused (416, with the size to resend from).
The registration token (`RUNNER_TOKEN`) only registers: the host then calls
with `<host id>.<secret>`, which works for its own runs and nothing else.

What a run runs is the repo's business: `job` names a `[jobs.<name>]` in its
`jobs.toml` at `commit`, which the host reads after checking it out; this
service never reads the repo.

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
ops/runner beta <job-runner binary>        # the second job-runner, registered here as a host (api = "hosts")
ops/check                                  # a run of python-template's hello, claimed by this host, to `succeeded`
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

Agents call it through its MCP server at `/mcp`, with the submitters' token
(see [`docs/MCP.md`](./docs/MCP.md)); scripts call the HTTP API directly, as
`ops/check` does. There is no separate client to install.

## Develop

```sh
npm ci
AUTH_TOKEN=dev RUNNER_TOKEN=reg npm run dev    # on :4500, data in .job-service-dev.db (--port to change)
```

Checks: [the test skill](.claude/skills/test/SKILL.md).

This repo is `job-service-2` only while the AWS job-service is released from
`dakotacolorado/job-service`; everything in it is plain job-service.
