# job-service

Runs jobs on a fleet of hosts. A **job** is a named script in a repo's
`jobs.toml`; a **run** is one execution of it at one commit, on a **host** the
scheduler places it on. A run is submitted `pending` into a queue ordered by
`priority`, then age; the scheduler `assigned` it to a host that fits and
pushes it there; the host takes it and it is `running`; it ends `succeeded`,
`failed` or `canceled` with its exit code. Its log can be read
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
POST /runs               {repo, commit, job, args?, requirements?: {os, arch, memory, timeout}, labels?, priority?, retry?: {limit, backoff}}  → run, pending
GET  /runs?state=…&repo=…&label=key=value
GET  /runs/{id}
GET  /runs/{id}/log?attempt=n  Range: bytes=N-     (the latest attempt's unless named; Run-State says its state)
POST /runs/{id}/cancel
POST /runs/{id}/priority {priority}   moves a run not yet ended in the queue
GET  /hosts              each host with its capacity, free capacity and metrics
```

`requirements` is everything a run needs from its host in one place; a run
fits a host when its os and arch match and the host's free memory covers the
run's (1024 MiB when none is given). Every second the scheduler takes the
queue in order and places each run on the fitting connected host with the most
room, passing over one no host fits; an assignment not taken in 30 s goes back
to the queue. A run given `retry: {limit, backoff}` that fails (not one
canceled) goes back to the queue as its next `attempt`, `backoff` seconds
later, doubling each time (at most an hour), up to `limit` times; it keeps its
id, each attempt keeps its own log and exit, and `attempts` lists the earlier
ones. `labels` describe the run, free-form (what it
is for, who asked), and `ListRuns` filters by them.

Hosts run job-runner, which calls in (hosts are behind NAT) and is never called:
it holds a WebSocket open, over which job-service pushes its runs, as
[`docs/PROTOCOL.md`](./docs/PROTOCOL.md) sets out.

```
POST  /hosts                    registration token → host id and its own token (same name again: same id, new token)
GET   /hosts/{id}/connect       WebSocket: assign/start/drop/cancel pushed; heartbeat/accept/decline sent
POST  /hosts/{id}/heartbeat     {free, metrics, running: [run ids]} → {cancel, ended, lease}, while not connected
POST  /hosts/{id}/claim         {free: {slots, memory}} → {run, memory, lease}, or 204: the old pull, until every host connects
PATCH /runs/{id}/log?attempt=n  Content-Range: bytes S-E/* → {size}
PUT   /runs/{id}?attempt=n      {state, exit, duration, reason?}
```

Every change of a run's state is a conditional write, so two hosts never get
the same run, and a host runs one only once job-service answers its accept
with `start`. A
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
