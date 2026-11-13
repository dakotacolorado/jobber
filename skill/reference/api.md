# job-service API

Generated from this deployment's `openapi.json`. `bin/` adds the address, the bearer token and `claimed-by`, so a path is all a call needs. A field marked `?` is optional.

Runs jobs on self-hosted runners. A **job** is a named script in a repo's `jobs.toml`; a **run** is one execution of it at a commit.

- **Submit** a run, then follow it: `pending` → `running` → `succeeded`, `failed` or `canceled`.
- **Read its log** with `GetRunLog`, from any byte offset, while it runs and after.
- **Runners** (job-runner) pull work through the *Runner protocol* calls. You don't call those.

**Auth:** `Authorization: Bearer <token>` with the submitters' token, on everything but `GetHealth`.

**Errors:** `{code, message}`, where `code` is an AWS-style exception name such as `ValidationException` or `ResourceNotFoundException`.

## ListRuns: GET /runs

List runs.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `state`? | query | `pending`, `running`, `succeeded`, `failed`, `canceled` | `pending` → `running` → `succeeded`, `failed` or `canceled`. |
| `repo`? | query | string (max 200) | GitHub repo, `owner/name`. |
| `submittedBy`? | query | string (min 1, max 200) | Only runs with this `submittedBy`. |
| `for`? | query | string | Only runs for this `<kind>:<id>`. |
| `limit`? | query | integer (≥ 1, ≤ 500) | Max results. Default: 100. |

- 200: The runs. → `ListRunsResponse`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## SubmitRun: POST /runs

Submit a run.

Queues a run as `pending` until a runner claims it. The repo isn't checked here: a missing job fails on its runner.

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

Complete a run.

Records how a run ended. Retrying with the same result is safe.

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

Get a run's log.

Reads up to 1 MiB from byte N (`Range: bytes=N-`). To follow a run, poll from the last `size` until `Run-State` has ended.

| Parameter | In | Type | |
| --- | --- | --- | --- |
| `id` | path | string (uuid) | The run's id. |

- 206: Log bytes from N, up to 1 MiB. → string
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 404: ResourceNotFoundException: No run has that id. → `Error`
- 416: InvalidRangeException: N is past the end of the log. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## AppendRunLog: PATCH /runs/{id}/log

Append to a log.

Appends bytes at the log's end (`Content-Range: bytes S-E/*`) and renews the lease; an empty body only renews. Max 256 KiB per call, 64 MiB per run.

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

Ends a pending run now. A running one is stopped by its runner within seconds.

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

List runners.

- 200: The runners. → `ListRunnersResponse`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## RegisterRunner: POST /runners

Register a runner.

Takes the registration token. Returns the runner's own token, once.

Body: `RegisterRunnerInput`. What the runner is and has.

- 201: Registered. → `RegisterRunnerResponse`
- 400: ValidationException: The request failed validation. → `Error`
- 401: UnauthorizedException: The bearer token is missing or is not the submitters'. → `Error`
- 503: ServiceUnavailableException: The service has no submitters' token configured. → `Error`

## ClaimRun: POST /runners/{id}/claim

Claim a run.

Takes the oldest pending run that fits this runner and marks it `running`. 204 if none fits.

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

Put run limits.

Records the memory, timeout and stall limit a run actually got, once its runner has read `jobs.toml`.

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
| `code` | `ValidationException`, `UnauthorizedException`, `AccessDeniedException`, `ResourceNotFoundException`, `ConflictException`, `PayloadTooLargeException`, `InvalidRangeException`, `InternalServerException`, `ServiceUnavailableException` | Exception name. |
| `message` | string | What went wrong. |

## Run

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) | The run's id. |
| `repo` | string (max 200) | GitHub repo, `owner/name`. |
| `commit` | string | Full commit sha to check out. |
| `job` | string | A `[jobs.<name>]` in the repo's `jobs.toml`. |
| `routine` | `Routine` |  |
| `host` | string or null | The host it must run on, if any. |
| `args` | string[] | Arguments appended to the job's command. |
| `limits` | `Limits` |  |
| `labels` | map of string | Key-value labels. On a run, what its runner must have. |
| `for` | `For` |  |
| `state` | `pending`, `running`, `succeeded`, `failed`, `canceled` | `pending` → `running` → `succeeded`, `failed` or `canceled`. |
| `reason` | string or null | Why it ended, when not plain (e.g. timed out). |
| `cancelRequested` | boolean | Cancel asked for; its runner will stop it. |
| `runner` | string (uuid) or null | Runner that claimed it. |
| `runsWith` | `RunsWith` |  |
| `exit` | integer or null | Exit code. |
| `duration` | number or null | Seconds it ran. |
| `logSize` | integer | Log size in bytes. |
| `submittedBy` | string or null | Who submitted it (`claimed-by`). |
| `createdAt` | string | Submitted at (ISO 8601). |
| `updatedAt` | string | Last changed at (ISO 8601). |
| `startedAt` | string or null | Claimed at (ISO 8601). |
| `endedAt` | string or null | Ended at (ISO 8601). |
| `leaseExpiresAt` | string or null | Fails at this time unless its runner checks in. |

## Routine

The routine it runs, if any.

| Field | Type | |
| --- | --- | --- |
| `repo` | string (max 200) | Repo holding the routine. |
| `commit` | string | Full commit sha of that repo. |
| `dir` | string (max 200) | Directory holding the routine's `jobs.toml`. |

## Limits

| Field | Type | |
| --- | --- | --- |
| `memory`? | integer (≥ 16, ≤ 1048576) or null | Memory in MiB. Default: `jobs.toml`'s, else 1024. |
| `timeout`? | integer (≥ 1, ≤ 86400) or null | Timeout in seconds. Default: `jobs.toml`'s. |

## For

What it is for, if given.

| Field | Type | |
| --- | --- | --- |
| `kind` | `batch`, `change`, `item`, `worker` | What kind of thing asked for it. |
| `id` | string | Its id. |

## RunsWith

Limits it actually runs with, once its runner says.

| Field | Type | |
| --- | --- | --- |
| `memory` | integer (≥ 1, ≤ 1048576) | Memory in MiB. |
| `timeout` | integer (≥ 1, ≤ 86400) | Timeout in seconds. |
| `stall` | integer (≥ 1, ≤ 86400) or null | Seconds without progress before it fails as stalled; null for never. |

## SubmitRunInput

| Field | Type | |
| --- | --- | --- |
| `repo` | string (max 200) | GitHub repo, `owner/name`. |
| `commit` | string | Full commit sha to check out. |
| `job` | string | A `[jobs.<name>]` in the repo's `jobs.toml`. |
| `args`? | string (max 4000)[] (at most 50) | Arguments appended to the job's command. |
| `limits`? | `Limits` |  |
| `labels`? | map of string | Key-value labels. On a run, what its runner must have. |
| `for`? | `For` and any |  |
| `routine`? | `Routine` and any |  |
| `host`? | string (min 1, max 200) or null | Run on this host itself, outside a container. Default: any runner, in a container. |

## ListRunsResponse

| Field | Type | |
| --- | --- | --- |
| `runs` | `Run`[] | Runs, newest first. |

## RegisterRunnerResponse

| Field | Type | |
| --- | --- | --- |
| `runner` | `Runner` |  |
| `token` | string | Its own token, `<id>.<secret>`. Shown only once. |

## Runner

The new runner.

| Field | Type | |
| --- | --- | --- |
| `id` | string (uuid) | The runner's id. |
| `name` | string | Display name; not unique. |
| `labels` | map of string | Key-value labels. On a run, what its runner must have. |
| `slots` | integer | Runs at once. |
| `memory` | integer | Memory for runs, in MiB. |
| `version` | string or null | job-runner version. |
| `hostId` | string or null | Host it runs on. |
| `createdAt` | string | Registered at (ISO 8601). |
| `lastSeenAt` | string | Last claim at (ISO 8601). |

## RegisterRunnerInput

| Field | Type | |
| --- | --- | --- |
| `name` | string (min 1, max 200) | Display name; not unique. |
| `labels`? | map of string | Key-value labels. On a run, what its runner must have. |
| `slots` | integer (≥ 1, ≤ 64) | Runs at once. |
| `memory` | integer (≥ 16, ≤ 1048576) | Memory for runs, in MiB. |
| `version`? | string (max 100) or null | job-runner version. |
| `hostId`? | string (min 1, max 200) or null | Host name, as worker-host knows it. |

## ListRunnersResponse

| Field | Type | |
| --- | --- | --- |
| `runners` | `Runner`[] | Runners, most recently seen first. |

## ClaimRunResponse

| Field | Type | |
| --- | --- | --- |
| `run` | `Run` and any |  |
| `memory` | integer | Memory to reserve, in MiB. |
| `lease` | integer | Seconds between check-ins before the run fails. |

## ClaimRunInput

| Field | Type | |
| --- | --- | --- |
| `labels`? | map of string | Labels now. Default: as registered. |
| `can`? | `routine`, `host`[] (at most 10) | Extra kinds of run it takes: `routine`, `host`. |
| `hostId`? | string (min 1, max 200) | Host it runs on now. |
| `free` | {slots: integer (≥ 0), memory: integer (≥ 0)} | Free capacity now. |

## AppendRunLogResponse

| Field | Type | |
| --- | --- | --- |
| `size` | integer | Log size: where the next append starts. |
| `canceled` | boolean | Cancel asked for: stop and complete as `canceled`. |
| `leaseExpiresAt` | string | Lease end (ISO 8601). |

## InvalidRangeError

Every error's body.

Every field of `Error`, and:

| Field | Type | |
| --- | --- | --- |
| `size` | integer | Log size: resend from here. |

## CompleteRunInput

| Field | Type | |
| --- | --- | --- |
| `state` | `succeeded`, `failed`, `canceled` | How it ended. |
| `exit` | integer or null | Exit code, if it ran. |
| `duration` | number (≥ 0) | Seconds from claim to end. |
| `reason`? | string (min 1, max 2000) or null | Why, if not plain (e.g. `timed out after 600s`). |
