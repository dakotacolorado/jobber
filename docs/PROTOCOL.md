# Host connection

How jobber pushes work to the hosts of its fleet. jobber-host on each computer
holds one WebSocket open to jobber; jobber's scheduler places each
queued run on a host that fits and sends it over that host's connection. Hosts
sit behind NAT, so the host dials out; nothing dials in.

Logs and completion stay HTTP: `AppendRunLog` (`PATCH /runs/{id}/log`) and
`CompleteRun` (`PUT /runs/{id}`), each with `?attempt=<n>`, the attempt the
host was started on. A write naming any other attempt than the run's current
one is refused with 409, so a host still running an attempt that lapsed
cannot write to the retry.

## Connecting

`GET /hosts/{id}/connect`, upgraded to a WebSocket, with
`Authorization: Bearer <host id>.<secret>` (the host's own token, as
`RegisterHost` answered it). Before the upgrade, a wrong token is answered
401 and another host's path 403, as `{code, message}`.

A host says what it can do beyond running a run in a container in
`RegisterHost`'s `features`: `secrets` (it gives a run its secrets as
environment variables) and `hostRuns` (it runs a run `onHost` on the machine
itself, for a repo on its own allowlist). jobber places a run naming secrets
only on a host with `secrets`, and a run `onHost` only on the host it names,
and only if that host has `hostRuns`; a host that says neither (an older
jobber-host) is sent neither, and ignores fields it does not know.

One connection per host: a new one closes the one before with code 4000
(`replaced`).

Every message either way is one JSON text frame, an object with a `type`.

## Host → service

- `heartbeat`: `{"type": "heartbeat", "free": {"cpu", "memory"}, "metrics":
  {"cpuLoad", "memoryUsed", "memoryTotal", "diskFree", "cpus"}, "running":
  [{"id", "attempt"}]}`. `free` is what the host's own budget has free: its
  capacity less what its runs and image builds hold. The scheduler places runs
  within the least of that and the capacity less the requests it has placed
  there; `metrics` only say whether the host is well enough for more. Send one as soon as the connection opens, then at least
  every 15 seconds. The scheduler places nothing on a host until its first
  heartbeat on this connection, nor on one silent for 30 seconds. Renews the
  lease of each listed run still running here on that attempt. Answered by a
  `heartbeat` (below).
- `accept`: `{"type": "accept", "run": "<id>", "attempt": n}`, for an
  `assign`. Answered `start` or `drop`. Run the job only on `start`.
- `decline`: `{"type": "decline", "run": "<id>", "attempt": n, "reason":
  "…"}`, for an `assign` the host cannot take (its cpu or memory is not free). The run
  goes back to the queue. Not answered.

## Service → host

- `assign`: `{"type": "assign", "run": <Run>, "attempt": n, "cpu": CPUs,
  "memory": MiB, "lease": seconds}`: `cpu` and `memory` are what the run
  requests (its `requirements`, or their defaults), which the host reserves
  for it and gives its container. The `Run`'s `secrets` are names only; its
  `onHost` and `requirements.host` say to run it on this machine itself
  (refuse one whose repo is not on the host's allowlist by completing it
  `failed` with the reason, after `start`). Sent when the scheduler places a run here, and again,
  on connecting, for each run still assigned here. Answer `accept` or
  `decline`. An assignment neither accepted nor declined within 30 seconds
  goes back to the queue. An `assign` for a run and attempt the host already
  runs is answered `accept` again (and its `start` ignored): that is a resend
  after a reconnect, not a second run. One for a run still running here on an
  earlier attempt is declined, until that attempt stops.
- `start`: `{"type": "start", "run": "<id>", "attempt": n, "lease":
  seconds, "secrets": {"<NAME>": "<value>"}}`. The run is `running` here:
  start it, its lease running from now. `secrets`, present only for a run
  that names some, are their values: the only message that carries them. Give
  each to the run as an environment variable of its name, mask every value in
  its log, and keep them nowhere else (no log line, no file outside the run).
  A run whose secret was deleted after it was submitted is answered `drop`
  instead, and ends `failed`.
- `drop`: `{"type": "drop", "run": "<id>", "attempt": n, "reason": "…"}`.
  The run is no longer this host's (canceled, or its assignment expired and
  it went to another): do not run it, or, if it already runs, stop it without
  completing it.
- `cancel`: `{"type": "cancel", "run": "<id>", "attempt": n}`. `CancelRun`
  was called on a run running here: stop it and complete it `canceled`.
- `heartbeat`: `{"type": "heartbeat", "cancel": ["<id>"], "ended": ["<id>"],
  "lease": seconds}`, answering one. As `SendHeartbeat`'s answer: `cancel`,
  the listed runs to stop and complete `canceled`; `ended`, those no longer
  running here on that attempt (stop them, do not complete them).
- `error`: `{"type": "error", "message": "…"}`, for a message it could not
  read. The connection stays open.

## When the connection drops

Runs already started keep running, their logs and completions over HTTP as
ever. Reconnect with backoff (1s, doubling to 30s, with jitter). While
disconnected, send heartbeats by `SendHeartbeat` over HTTP (`running` as
ids) so the runs' leases hold. On reconnecting, the service resends every
assignment still waiting for this host, so none is lost; and, on the first
heartbeat, an `assign` for each run `running` here that the heartbeat does not
list (its `start` was lost with the connection), which the host accepts and
runs on `start`. An `accept` for an
attempt already running here is answered `start` again, which the host
ignores for an attempt it runs, so none runs twice.
