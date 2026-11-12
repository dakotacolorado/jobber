# job-service

Runs of jobs. A **job** is a named script in a repo's `jobs.toml`; a **run**
is one execution of it, to completion at one commit, by a runner that claims
it. A run is submitted `pending`, claimed and `running`, and ends
`succeeded`, `failed` or `canceled` with its exit code. Its log can be read
from any offset while it runs and after.

One Node 24 process serves the HTTP API, with everything in one SQLite file.
The contract is [`openapi.json`](./openapi.json), rendered in
[`docs/API.md`](./docs/API.md).

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
