# jobber

**Submit code to run on whatever computers you have available.**

```
     ██╗ ██████╗ ██████╗ ██████╗ ███████╗██████╗               ▄▄█▀▀█
     ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗  ▄▄▄▄▄   ▄▄▀▀  ▀▀▀▀
     ██║██║   ██║██████╔╝██████╔╝█████╗  ██████╔╝  █████▄██▄▄▄▄▄▄█▀▀█
██   ██║██║   ██║██╔══██╗██╔══██╗██╔══╝  ██╔══██╗  █████ ▀▀▄▄    ▀▀▀▀
╚█████╔╝╚██████╔╝██████╔╝██████╔╝███████╗██║  ██║            ▀▀▄▄█▀▀█
 ╚════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝                ▀▀▀▀
v0.1.0

Submit code to run on whatever computers you have available.
A queue of runs, each placed on a host that fits it and pushed there, with its log streamed back.

  ▸ Page      http://127.0.0.1:4500/
  ▸ API       http://127.0.0.1:4500/runs   docs http://127.0.0.1:4500/docs/api
  ▸ MCP       http://127.0.0.1:4500/mcp    docs http://127.0.0.1:4500/docs/mcp

  listening on http://127.0.0.1:4500, data in ~/.local/share/jobber/jobber.db
  Ctrl+C to stop.
```

One Node process serves an HTTP API, an MCP server and a web page, and keeps
everything in one SQLite file.

jobber was formerly called job-service.

## Try it on your machine

```sh
AUTH_TOKEN=pick-one RUNNER_TOKEN=pick-another npx github:dakotacolorado/jobber
```

(It installs from this repo and builds itself. Node 24 or later; nothing else.)
From a checkout it is the same: `npm ci`, then
`AUTH_TOKEN=… RUNNER_TOKEN=… npx .`.

1. Open http://127.0.0.1:4500/ and paste `AUTH_TOKEN` to sign in.
2. Put a computer to work: install
   [jobber-host](https://github.com/dakotacolorado/jobber-host#readme) on it
   and register it with `RUNNER_TOKEN`. It dials out to jobber, so the
   computer can sit behind NAT.
3. Submit a run with **Submit a run**, or through the API or MCP below. jobber
   pushes it to a host that fits, and the page follows its log.

![The runs page](./docs/images/runs.png)

The page lists runs by state, repo and label, shows a run and follows its log,
submits, cancels and reprioritises runs, and lists the hosts with their
capacity and health.

## How it works

- A **job** is a named script in a repo's `jobs.toml`. A **run** is one
  execution of it at one commit. What a run runs is the repo's business: the
  host reads `[jobs.<name>]` after checking the commit out, and jobber never
  reads the repo.
- A run is submitted `pending` into a queue ordered by `priority`, then age.
  The scheduler places it `assigned` on a connected host that fits its
  `requirements` (os, arch, memory) and has room, and pushes it there. The host
  takes it and it is `running`. It ends `succeeded`, `failed` or `canceled`,
  with its exit code. An assignment not taken in 30 s goes back to the queue.
- A run given `retry: {limit, backoff}` that fails goes back to the queue as
  its next `attempt`, `backoff` seconds later, doubling each time. Each attempt
  keeps its own log and exit.
- `labels` describe a run, free-form (what it is for, who asked), and runs are
  filtered by them.
- A **host** runs jobber-host. It registers once with `RUNNER_TOKEN` and then
  calls with its own token, which works for its own runs and nothing else. It
  holds a WebSocket open to jobber, over which runs are pushed
  ([`docs/PROTOCOL.md`](./docs/PROTOCOL.md)). It heartbeats every few seconds
  with its free capacity and metrics (CPU load, memory, free disk), which
  renews its running runs' 60 s leases. It appends their logs and completes
  them over HTTP.
- Every change of a run's state is a conditional write, so two hosts never get
  the same run. A timer fails a running run whose lease lapsed, and another
  deletes log chunks over 90 days old.

## The API

| Operation | |
|---|---|
| `SubmitRun`, `ListRuns` | `POST`, `GET /runs` |
| `GetRun`, `CompleteRun` | `GET`, `PUT /runs/{id}` |
| `GetRunLog`, `AppendRunLog` | `GET`, `PATCH /runs/{id}/log` |
| `CancelRun` | `POST /runs/{id}/cancel` |
| `UpdateRunPriority` | `POST /runs/{id}/priority` |
| `RegisterHost`, `ListHosts` | `POST`, `GET /hosts` |
| `SendHeartbeat` | `POST /hosts/{id}/heartbeat` |
| `ConnectHost` | `GET /hosts/{id}/connect` (WebSocket) |
| `GetHealth` | `GET /health` |

The reference is [`docs/API.md`](./docs/API.md), served by Redoc at
`/docs/api`. The contract is [`openapi.json`](./openapi.json).

```sh
curl -s -H "authorization: Bearer $AUTH_TOKEN" -H 'content-type: application/json' http://127.0.0.1:4500/runs \
  -d '{"repo": "dakotacolorado/python-template", "commit": "<sha>", "job": "hello", "labels": {"by": "me"}}'
curl -s -H "authorization: Bearer $AUTH_TOKEN" 'http://127.0.0.1:4500/runs?state=running'
```

## MCP

`/mcp` serves the submitters' operations as tools (`submit_run`, `list_runs`,
`get_run`, `get_run_log`, `cancel_run`, `update_run_priority`, `list_hosts`),
each one API request under `AUTH_TOKEN`. With Claude Code:

```sh
claude mcp add --transport http jobber http://127.0.0.1:4500/mcp --header "Authorization: Bearer $AUTH_TOKEN"
```

The tools are listed in [`docs/MCP.md`](./docs/MCP.md), served at `/docs/mcp`.
There is no separate client: agents use the MCP server, scripts the API.

## Options

| Flag | Environment | Default |
|---|---|---|
| `--host` | `JOBBER_HOST` | `127.0.0.1` |
| `--port` | `JOBBER_PORT` | `4500` |
| `--db` | `JOBBER_DB` | `~/.local/share/jobber/jobber.db` |
| `--public-url` | `JOBBER_PUBLIC_URL` | its own address: what the banner gives, behind a proxy |
| | `AUTH_TOKEN` | none: the submitters' token. Without it, all but `/health` and the docs answer 503 |
| | `RUNNER_TOKEN` | none: registers hosts. Without it, `RegisterHost` answers 503 |

The `JOB_SERVICE_*` names it had before are still read when the `JOBBER_*`
ones are unset, with a warning. `jobber --help` lists the options.
`jobber backup copy.db` takes SQLite's online backup of the database,
consistent while it serves.

## On the hosts

Beta runs on `dakotajp-hp-laptop` and prod on `dakotajp-lenovo-laptop`, each at
`https://<host>.tail90863a.ts.net:8445` (`tailscale serve` to 127.0.0.1:4500).
Deploy from a checkout at the commit to release, as the hosts' user:

```sh
ops/deploy beta dakotajp-lenovo-laptop     # on the HP; prod: ops/deploy prod dakotajp-hp-laptop on the Lenovo
ops/runner beta <runner binary>            # a host for this jobber, on this computer
ops/check                                  # a run of python-template's hello, pushed to this host, to `succeeded`
```

`ops/deploy` installs the build beside the previous one, makes the host's
`AUTH_TOKEN` and `RUNNER_TOKEN` once (mode 600, never committed), restarts the
service, checks that `/health` answers the commit, and puts the previous
release back if not. It also installs a nightly backup of the database to the
other host, keeping 14 days. Run at an earlier commit, it is the rollback. Each
script's header says where it puts things.

## Developing

```sh
npm ci                                       # also builds, and points git at .githooks/
AUTH_TOKEN=dev RUNNER_TOKEN=reg npm run dev  # on :4500, data in .jobber-dev.db (--port to change)
npm run typecheck
npm test
npm run build
```

`src/schema.ts` is the source of `openapi.json` and the API's docs, and
`src/mcp.ts` of `mcp.json` and the MCP docs. `npm run spec` regenerates them,
as the pre-commit hook does, and a test fails if any drifts. The page is
`ui/`, and its mark and words come from `src/banner.ts`. The checks are
[the test skill](.claude/skills/test/SKILL.md).

## License

MIT
