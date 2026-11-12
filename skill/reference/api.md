# job-service API

Generated from this deployment's `openapi.json`. `bin/` adds the address, the bearer token and `claimed-by`, so a path is all a call needs. A field marked `?` is optional.

Runs of jobs. A **job** is a named script in a repo's `jobs.toml`; a **run** is one execution of it, to completion at one commit, by a **runner** that claims it.

- A run is submitted `pending`, claimed and `running`, and ends `succeeded`, `failed` or `canceled` with its exit code. It says what it was for when its submitter said.
- A run's log is read from any byte offset, while it runs and after: `GetRunLog` from where the last read ended, until `Run-State` says the run has ended.
- Runners call in and are never called: one registers with the registration token, then claims runs, appends to their logs and completes them with its own token, `<runner id>.<secret>`.

Submitters send `Authorization: Bearer <token>` with the submitters' token, and may send `claimed-by`, recorded on a run they submit. `GetHealth` takes no token. Errors are `{code, message}`, the code an exception name for the HTTP status: `ValidationException` (400), `UnauthorizedException` (401), `AccessDeniedException` (403), `ResourceNotFoundException` (404), `ConflictException` (409), `PayloadTooLargeException` (413), `InvalidRangeException` (416), `InternalServerException` (500) and `ServiceUnavailableException` (503).

## ListRuns: GET /runs

List runs, newest first.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `state`? | query | `pending`, `running`, `succeeded`, `failed`, `canceled` | `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves. |
| `repo`? | query | string (max 200) | `owner/name` on GitHub. |
| `submittedBy`? | query | string (min 1, max 200) | Only the runs submitted with this `claimed-by`, as `submittedBy` records it. |
| `for`? | query | string | `<kind>:<id>`, e.g. `item:28af81bc-…`: only the runs submitted with that `for`. |
| `limit`? | query | integer (≥ 1, ≤ 500) | At most this many, newest first. |

- 200: The runs. → `ListRunsResponse`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## SubmitRun: POST /runs

Submit a run of a job: a named script in a repo at a commit.

One run, stored `pending` until a runner whose labels and free memory fit claims it, with what it was for when `for` says. Nothing is checked against the repo here: a run of a job missing from `jobs.toml` at that commit fails on its runner, saying so in its log.

Body: `SubmitRunInput`. What to run, and where it may run.

- 201: Stored, `pending`. → `Run`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## GetRun: GET /runs/{id}

Get a run.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The run's id. |

- 200: The run. → `Run`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 404: ResourceNotFoundException: No run has that id. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## CompleteRun: PUT /runs/{id}

Complete a run in progress, saying how it ended.

From the run's own runner. Sending the same end again answers it unchanged, so a lost reply can be retried.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The run's id. |

Body: `CompleteRunInput`. How it ended.

- 200: The run, ended. → `Run`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is not a runner's own. → `Error`
- 403: AccessDeniedException: The run is another runner's, or the path names another runner. → `Error`
- 404: ResourceNotFoundException: No run has that id. → `Error`
- 409: ConflictException: It is not running, or ended otherwise. → `Error`

## GetRunLog: GET /runs/{id}/log

Get a run's log from a byte offset.

Send `Range: bytes=N-` to read from offset N; without it, from 0. Answers 206 with `Content-Range: bytes N-M/size` and at most 1 MiB, or an empty body when N is the log's size, so a follower polls from where it got to. `Run-State` says the run's state, so it knows when to stop.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The run's id. |

- 206: The log from N, up to 1 MiB. → string
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 404: ResourceNotFoundException: No run has that id. → `Error`
- 416: InvalidRangeException: N is past the end of the log. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## AppendRunLog: PATCH /runs/{id}/log

Append to the log of a run in progress, and renew its lease.

The body is the bytes, `Content-Range: bytes S-E/*` where S is the log's current size and E = S + length - 1. An empty body without `Content-Range` only renews the lease. 416 for any other S, with the size to resend from. At most 256 KiB per append and 64 MiB per run (413). The reply says whether a cancel was asked for.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The run's id. |

Body: string (binary). The log's next bytes.

- 200: Stored, and the lease renewed. → `AppendRunLogResponse`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is not a runner's own. → `Error`
- 403: AccessDeniedException: The run is another runner's, or the path names another runner. → `Error`
- 404: ResourceNotFoundException: No run has that id. → `Error`
- 409: ConflictException: The run is not running: it ended, perhaps by its lease lapsing. → `Error`
- 413: PayloadTooLargeException: Over 256 KiB, or the log would pass 64 MiB. → `Error`
- 416: InvalidRangeException: The append does not start at the log's end: resend from `size`. → `InvalidRangeError`

## CancelRun: POST /runs/{id}/cancel

Cancel a run.

A pending run ends `canceled` at once. A running one is marked `cancelRequested`: its runner is told on its next log append, stops it, and reports it `canceled`.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The run's id. |

- 200: The run, canceled or marked. → `Run`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 404: ResourceNotFoundException: No run has that id. → `Error`
- 409: ConflictException: It has already ended. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## ListRunners: GET /runners

List runners, most recently seen first.

- 200: The runners. → `ListRunnersResponse`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## RegisterRunner: POST /runners

Register a runner.

With the registration token, not the submitters'. Answers the runner's own token once.

Body: `RegisterRunnerInput`. What the runner is and has.

- 201: Registered. → `RegisterRunnerResponse`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## ClaimRun: POST /runners/{id}/claim

Claim the oldest pending run that fits.

The oldest pending run whose labels the runner has, whose memory fits `free`, whose routine or host, if any, it `can` run, and whose `host`, if any, is the runner's own `hostId`, moved to `running` on this runner. Two claims never get the same run. 204 when none fits.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The runner's id. |

Body: `ClaimRunInput`. What the runner can take on.

- 200: A run, now running here. → `ClaimRunResponse`
- 204: No pending run fits.
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is not a runner's own. → `Error`
- 403: AccessDeniedException: The run is another runner's, or the path names another runner. → `Error`

## PutRunsWith: PUT /runs/{id}/runs-with

Put what a run in progress runs with.

From the run's own runner, once it has read `jobs.toml` and before it starts the run's container. Sending it again replaces it.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The run's id. |

Body: `RunsWith`. Its memory, timeout and stall limit.

- 200: The run, with `runsWith`. → `Run`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is not a runner's own. → `Error`
- 403: AccessDeniedException: The run is another runner's, or the path names another runner. → `Error`
- 404: ResourceNotFoundException: No run has that id. → `Error`
- 409: ConflictException: It is not running. → `Error`

# Schemas

## Error

Every error's body.

| Field | Type | |
| --- | --- | --- |
| `code` | `ValidationException`, `UnauthorizedException`, `AccessDeniedException`, `ResourceNotFoundException`, `ConflictException`, `PayloadTooLargeException`, `InvalidRangeException`, `InternalServerException`, `ServiceUnavailableException` | What went wrong, as an exception name: one per HTTP status. |
| `message` | string | What went wrong, in words. |

## Run

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) | The run's id. |
| `repo` | string (max 200) | `owner/name` on GitHub: checked out at `/work`; with a routine, its target. |
| `commit` | string | The commit to run, as a full lowercase sha: the runner checks out exactly this. |
| `job` | string | A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine. |
| `routine` | `Routine` |  |
| `host` | string or null | The machine it must run on, on the host itself; null: any runner that fits. |
| `args` | string[] | Appended to the job's `run` command from `jobs.toml`. |
| `limits` | `Limits` |  |
| `labels` | map of string | Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has. |
| `for` | `For` |  |
| `state` | `pending`, `running`, `succeeded`, `failed`, `canceled` | `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves. |
| `reason` | string or null | Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout. |
| `cancelRequested` | boolean | A cancel was asked for: the runner of a run in progress is told to stop it on its next log append. |
| `runner` | string (uuid) or null | The runner that claimed it; null while pending. |
| `runsWith` | `RunsWith` |  |
| `exit` | integer or null | The run's exit code, once its runner reports one. |
| `duration` | number or null | Seconds it ran, as its runner reported. |
| `logSize` | integer | Bytes of log stored so far. |
| `submittedBy` | string or null | The `claimed-by` it was submitted with. |
| `createdAt` | string | When it was submitted, as an ISO 8601 timestamp. |
| `updatedAt` | string | When it last changed, as an ISO 8601 timestamp. |
| `startedAt` | string or null | When a runner claimed it; null while pending. |
| `endedAt` | string or null | When it ended; null until it does. |
| `leaseExpiresAt` | string or null | While running: if no log append renews it by then, the run fails. |

## Routine

Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.

| Field | Type | |
| --- | --- | --- |
| `repo` | string (max 200) | `owner/name` on GitHub: the repo the routine is in. |
| `commit` | string | The routine repo's commit, as a full lowercase sha: the runner checks out exactly this. |
| `dir` | string (max 200) | The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`. |

## Limits

| Field | Type | |
| --- | --- | --- |
| `memory`? | integer (≥ 16, ≤ 1048576) or null | MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with. |
| `timeout`? | integer (≥ 1, ≤ 86400) or null | Seconds before the runner stops it and it fails. Null: `jobs.toml`'s. |

## For

What it was for; null when its submitter did not say.

| Field | Type | |
| --- | --- | --- |
| `kind` | `batch`, `change`, `item`, `worker` | What asked for the run: an approval-service batch or change, a work-tracker item, or a worker. |
| `id` | string | Its id there, without spaces. |

## RunsWith

What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.

| Field | Type | |
| --- | --- | --- |
| `memory` | integer (≥ 1, ≤ 1048576) | MiB the container may use. |
| `timeout` | integer (≥ 1, ≤ 86400) | Seconds before the runner stops it and it fails. |
| `stall` | integer (≥ 1, ≤ 86400) or null | Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does. |

## SubmitRunInput

| Field | Type | |
| --- | --- | --- |
| `repo` | string (max 200) | `owner/name` on GitHub. |
| `commit` | string | The commit to run, as a full lowercase sha: the runner checks out exactly this. |
| `job` | string | A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine. |
| `args`? | string (max 4000)[] (at most 50) | Appended to the job's `run` command from `jobs.toml`. |
| `limits`? | `Limits` |  |
| `labels`? | map of string | Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has. |
| `for`? | `For` and any |  |
| `routine`? | `Routine` and any |  |
| `host`? | string (min 1, max 200) or null | The machine it must run on, as a runner's `hostId`: claimed only by that machine's runner, and only one that says it `can` run `host` runs, which runs it on the host itself, with the host's user services, if that host's config lets it. Null: any runner that fits. |

## ListRunsResponse

| Field | Type | |
| --- | --- | --- |
| `runs` | `Run`[] | The runs, newest first. |

## RegisterRunnerResponse

| Field | Type | |
| --- | --- | --- |
| `runner` | `Runner` |  |
| `token` | string | Its own bearer token, `<runner id>.<secret>`, shown only here: keep it where only the runner's user can read it. |

## Runner

The runner, registered.

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) | The runner's id. |
| `name` | string | What it calls itself, e.g. its host's name: not unique. |
| `labels` | map of string | Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has. |
| `slots` | integer | Runs it runs at once. |
| `memory` | integer | MiB it has for runs and their image builds. |
| `version` | string or null | job-runner's version, as it said. |
| `hostId` | string or null | The machine it runs on, the same as that machine's worker-host's `host_id` (by default its hostname); null until it says. |
| `createdAt` | string | When it registered, as an ISO 8601 timestamp. |
| `lastSeenAt` | string | When it last asked for a run, as an ISO 8601 timestamp. |

## RegisterRunnerInput

| Field | Type | |
| --- | --- | --- |
| `name` | string (min 1, max 200) | What it calls itself, e.g. its host's name: not unique. |
| `labels`? | map of string | Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has. |
| `slots` | integer (≥ 1, ≤ 64) | Runs it runs at once. |
| `memory` | integer (≥ 16, ≤ 1048576) | MiB it has for runs and their image builds. |
| `version`? | string (max 100) or null | job-runner's version. |
| `hostId`? | string (min 1, max 200) or null | The machine it runs on: its worker-host's `host_id`, by default the hostname. |

## ListRunnersResponse

| Field | Type | |
| --- | --- | --- |
| `runners` | `Runner`[] | Every registered runner, most recently seen first. |

## ClaimRunResponse

| Field | Type | |
| --- | --- | --- |
| `run` | `Run` and any |  |
| `memory` | integer | MiB the run was admitted with: reserve this, and run it with no more. |
| `lease` | integer | Seconds the run lives without a log append. Append, or renew with an empty one, well within it. |

## ClaimRunInput

| Field | Type | |
| --- | --- | --- |
| `labels`? | map of string | What it has now; its registered labels when absent. |
| `can`? | `routine`, `host`[] (at most 10) | What it can run beyond a job in its repo's own `jobs.toml`: `routine`, a run with a routine; `host`, a run naming its host, run on the host itself. A run needing one it does not say is left for another. |
| `hostId`? | string (min 1, max 200) | The machine it runs on now, recorded on the runner, so one registered before it said keeps its id. |
| `free` | {slots: integer (≥ 0), memory: integer (≥ 0)} | What it can take on now. |

## AppendRunLogResponse

| Field | Type | |
| --- | --- | --- |
| `size` | integer | Bytes of log stored: the offset the next append starts at. |
| `canceled` | boolean | A cancel was asked for: stop the run and report it `canceled`. |
| `leaseExpiresAt` | string | When the run fails unless another append renews it, as an ISO 8601 timestamp. |

## InvalidRangeError

Every error's body.

Every field of `Error`, and:

| Field | Type | |
| --- | --- | --- |
| `size` | integer | Bytes of log stored: the offset to resend from. |

## CompleteRunInput

| Field | Type | |
| --- | --- | --- |
| `state` | `succeeded`, `failed`, `canceled` | `canceled` when stopped for a cancel; `failed` for a non-zero exit, a timeout, or an image that would not build. |
| `exit` | integer or null | The run's exit code; null when it never ran or was killed. |
| `duration` | number (≥ 0) | Seconds from claim to end. |
| `reason`? | string (min 1, max 2000) or null | Why, when the state does not say: `timed out after 600s`, `image build failed`. |
