# job-service API reference

API version 2026-11-12

Runs of jobs. A **job** is a named script in a repo's `jobs.toml`; a **run** is one execution of it, to completion at one commit, by a **runner** that claims it.

- A run is submitted `pending`, claimed and `running`, and ends `succeeded`, `failed` or `canceled` with its exit code. It says what it was for when its submitter said.
- A run's log is read from any byte offset, while it runs and after: `GetRunLog` from where the last read ended, until `Run-State` says the run has ended.
- Runners call in and are never called: one registers with the registration token, then claims runs, appends to their logs and completes them with its own token, `<runner id>.<secret>`.

Submitters send `Authorization: Bearer <token>` with the submitters' token, and may send `claimed-by`, recorded on a run they submit. `GetHealth` takes no token. Errors are `{code, message}`, the code an exception name for the HTTP status: `ValidationException` (400), `UnauthorizedException` (401), `AccessDeniedException` (403), `ResourceNotFoundException` (404), `ConflictException` (409), `PayloadTooLargeException` (413), `InvalidRangeException` (416), `InternalServerException` (500) and `ServiceUnavailableException` (503).

## Operations

- [AppendRunLog](#appendrunlog): Append to the log of a run in progress, and renew its lease
- [CancelRun](#cancelrun): Cancel a run
- [ClaimRun](#claimrun): Claim the oldest pending run that fits
- [CompleteRun](#completerun): Complete a run in progress, saying how it ended
- [GetHealth](#gethealth): Get the service's health and version
- [GetRun](#getrun): Get a run
- [GetRunLog](#getrunlog): Get a run's log from a byte offset
- [GetSkill](#getskill): Get the client workers call this deployment with
- [ListRunners](#listrunners): List runners, most recently seen first
- [ListRuns](#listruns): List runs, newest first
- [PutRunsWith](#putrunswith): Put what a run in progress runs with
- [RegisterRunner](#registerrunner): Register a runner
- [SubmitRun](#submitrun): Submit a run of a job: a named script in a repo at a commit

## Data types

- [Error](#error)
- [For](#for)
- [Health](#health)
- [InvalidRangeError](#invalidrangeerror)
- [Limits](#limits)
- [Routine](#routine)
- [Run](#run)
- [Runner](#runner)
- [RunsWith](#runswith)
- [Skill](#skill)
- [SkillFile](#skillfile)

---

## AppendRunLog

The body is the bytes, `Content-Range: bytes S-E/*` where S is the log's current size and E = S + length - 1. An empty body without `Content-Range` only renews the lease. 416 for any other S, with the size to resend from. At most 256 KiB per append and 64 MiB per run (413). The reply says whether a cancel was asked for.

### Request syntax

```http
PATCH /runs/{id}/log HTTP/1.1
Authorization: Bearer token
content-range: string
Content-type: application/octet-stream

The log's next bytes.
```

### URI request parameters

**id**  
The run's id.  
Type: String. Required: Yes.

### Request headers

**content-range**  
`bytes S-E/*`  
Type: String. Pattern: `^bytes \d+-\d+\/(\*|\d+)$`. Required: No.

### Request body

The log's next bytes., as `application/octet-stream`.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "size": number,
   "canceled": boolean,
   "leaseExpiresAt": "string"
}
```

### Response elements

**size**  
Bytes of log stored: the offset the next append starts at.  
Type: Integer.

**canceled**  
A cancel was asked for: stop the run and report it `canceled`.  
Type: Boolean.

**leaseExpiresAt**  
When the run fails unless another append renews it, as an ISO 8601 timestamp.  
Type: String.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is not a runner's own.  
HTTP status: 401

**AccessDeniedException**  
The run is another runner's, or the path names another runner.  
HTTP status: 403

**ResourceNotFoundException**  
No run has that id.  
HTTP status: 404

**ConflictException**  
The run is not running: it ended, perhaps by its lease lapsing.  
HTTP status: 409

**PayloadTooLargeException**  
Over 256 KiB, or the log would pass 64 MiB.  
HTTP status: 413

**InvalidRangeException**  
The append does not start at the log's end: resend from `size`.  
HTTP status: 416

---

## CancelRun

A pending run ends `canceled` at once. A running one is marked `cancelRequested`: its runner is told on its next log append, stops it, and reports it `canceled`.

### Request syntax

```http
POST /runs/{id}/cancel HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
The run's id.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "repo": "string",
   "commit": "string",
   "job": "string",
   "routine": {
      "repo": "string",
      "commit": "string",
      "dir": "string"
   },
   "host": "string",
   "args": [ "string" ],
   "limits": {
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "for": {
      "kind": "batch | change | item | worker",
      "id": "string"
   },
   "state": "pending | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "runner": "string",
   "runsWith": {
      "memory": number,
      "timeout": number,
      "stall": number
   },
   "exit": number,
   "duration": number,
   "logSize": number,
   "submittedBy": "string",
   "createdAt": "string",
   "updatedAt": "string",
   "startedAt": "string",
   "endedAt": "string",
   "leaseExpiresAt": "string"
}
```

### Response elements

**id**  
The run's id.  
Type: String.

**repo**  
`owner/name` on GitHub: checked out at `/work`; with a routine, its target.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
The commit to run, as a full lowercase sha: the runner checks out exactly this.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.  
Type: [Routine](#routine) object.

**host**  
The machine it must run on, on the host itself; null: any runner that fits.  
Type: String. Nullable: Yes.

**args**  
Appended to the job's `run` command from `jobs.toml`.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.  
Type: Object.

**for**  
What it was for; null when its submitter did not say.  
Type: [For](#for) object.

**state**  
`pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.  
Type: String. Nullable: Yes.

**cancelRequested**  
A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.  
Type: Boolean.

**runner**  
The runner that claimed it; null while pending.  
Type: String. Nullable: Yes.

**runsWith**  
What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.  
Type: [RunsWith](#runswith) object.

**exit**  
The run's exit code, once its runner reports one.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran, as its runner reported.  
Type: Number. Nullable: Yes.

**logSize**  
Bytes of log stored so far.  
Type: Integer.

**submittedBy**  
The `claimed-by` it was submitted with.  
Type: String. Nullable: Yes.

**createdAt**  
When it was submitted, as an ISO 8601 timestamp.  
Type: String.

**updatedAt**  
When it last changed, as an ISO 8601 timestamp.  
Type: String.

**startedAt**  
When a runner claimed it; null while pending.  
Type: String. Nullable: Yes.

**endedAt**  
When it ended; null until it does.  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
While running: if no log append renews it by then, the run fails.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the submitters'.  
HTTP status: 401

**ResourceNotFoundException**  
No run has that id.  
HTTP status: 404

**ConflictException**  
It has already ended.  
HTTP status: 409

**ServiceUnavailableException**  
The service has no submitters' token configured.  
HTTP status: 503

---

## ClaimRun

The oldest pending run whose labels the runner has, whose memory fits `free`, whose routine or host, if any, it `can` run, and whose `host`, if any, is the runner's own `hostId`, moved to `running` on this runner. Two claims never get the same run. 204 when none fits.

### Request syntax

```http
POST /runners/{id}/claim HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "labels": { },
   "can": [ "routine | host" ],
   "hostId": "string",
   "free": {
      "slots": number,
      "memory": number
   }
}
```

### URI request parameters

**id**  
The runner's id.  
Type: String. Required: Yes.

### Request body

**labels**  
What it has now; its registered labels when absent.  
Type: Object. Required: No.

**can**  
What it can run beyond a job in its repo's own `jobs.toml`: `routine`, a run with a routine; `host`, a run naming its host, run on the host itself. A run needing one it does not say is left for another.  
Type: Array of strings. At most 10 items. Required: No.

**hostId**  
The machine it runs on now, recorded on the runner, so one registered before it said keeps its id.  
Type: String. Length: 1 to 200. Required: No.

**free**  
What it can take on now.  
Type: Object. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "run": {
      "id": "string",
      "repo": "string",
      "commit": "string",
      "job": "string",
      "routine": {
         "repo": "string",
         "commit": "string",
         "dir": "string"
      },
      "host": "string",
      "args": [ "string" ],
      "limits": {
         "memory": number,
         "timeout": number
      },
      "labels": { },
      "for": {
         "kind": "batch | change | item | worker",
         "id": "string"
      },
      "state": "pending | running | succeeded | failed | canceled",
      "reason": "string",
      "cancelRequested": boolean,
      "runner": "string",
      "runsWith": {
         "memory": number,
         "timeout": number,
         "stall": number
      },
      "exit": number,
      "duration": number,
      "logSize": number,
      "submittedBy": "string",
      "createdAt": "string",
      "updatedAt": "string",
      "startedAt": "string",
      "endedAt": "string",
      "leaseExpiresAt": "string"
   },
   "memory": number,
   "lease": number
}
```

### Response elements

**run**  
The run, now running on this runner.  
Type: [Run](#run) object.

**memory**  
MiB the run was admitted with: reserve this, and run it with no more.  
Type: Integer.

**lease**  
Seconds the run lives without a log append. Append, or renew with an empty one, well within it.  
Type: Integer.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is not a runner's own.  
HTTP status: 401

**AccessDeniedException**  
The run is another runner's, or the path names another runner.  
HTTP status: 403

---

## CompleteRun

From the run's own runner. Sending the same end again answers it unchanged, so a lost reply can be retried.

### Request syntax

```http
PUT /runs/{id} HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "state": "succeeded | failed | canceled",
   "exit": number,
   "duration": number,
   "reason": "string"
}
```

### URI request parameters

**id**  
The run's id.  
Type: String. Required: Yes.

### Request body

**state**  
`canceled` when stopped for a cancel; `failed` for a non-zero exit, a timeout, or an image that would not build.  
Type: String. Valid values: `succeeded` | `failed` | `canceled`. Required: Yes.

**exit**  
The run's exit code; null when it never ran or was killed.  
Type: Integer. Nullable: Yes. Required: Yes.

**duration**  
Seconds from claim to end.  
Type: Number. Range: 0 to any. Required: Yes.

**reason**  
Why, when the state does not say: `timed out after 600s`, `image build failed`.  
Type: String. Length: 1 to 2000. Nullable: Yes. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "repo": "string",
   "commit": "string",
   "job": "string",
   "routine": {
      "repo": "string",
      "commit": "string",
      "dir": "string"
   },
   "host": "string",
   "args": [ "string" ],
   "limits": {
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "for": {
      "kind": "batch | change | item | worker",
      "id": "string"
   },
   "state": "pending | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "runner": "string",
   "runsWith": {
      "memory": number,
      "timeout": number,
      "stall": number
   },
   "exit": number,
   "duration": number,
   "logSize": number,
   "submittedBy": "string",
   "createdAt": "string",
   "updatedAt": "string",
   "startedAt": "string",
   "endedAt": "string",
   "leaseExpiresAt": "string"
}
```

### Response elements

**id**  
The run's id.  
Type: String.

**repo**  
`owner/name` on GitHub: checked out at `/work`; with a routine, its target.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
The commit to run, as a full lowercase sha: the runner checks out exactly this.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.  
Type: [Routine](#routine) object.

**host**  
The machine it must run on, on the host itself; null: any runner that fits.  
Type: String. Nullable: Yes.

**args**  
Appended to the job's `run` command from `jobs.toml`.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.  
Type: Object.

**for**  
What it was for; null when its submitter did not say.  
Type: [For](#for) object.

**state**  
`pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.  
Type: String. Nullable: Yes.

**cancelRequested**  
A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.  
Type: Boolean.

**runner**  
The runner that claimed it; null while pending.  
Type: String. Nullable: Yes.

**runsWith**  
What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.  
Type: [RunsWith](#runswith) object.

**exit**  
The run's exit code, once its runner reports one.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran, as its runner reported.  
Type: Number. Nullable: Yes.

**logSize**  
Bytes of log stored so far.  
Type: Integer.

**submittedBy**  
The `claimed-by` it was submitted with.  
Type: String. Nullable: Yes.

**createdAt**  
When it was submitted, as an ISO 8601 timestamp.  
Type: String.

**updatedAt**  
When it last changed, as an ISO 8601 timestamp.  
Type: String.

**startedAt**  
When a runner claimed it; null while pending.  
Type: String. Nullable: Yes.

**endedAt**  
When it ended; null until it does.  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
While running: if no log append renews it by then, the run fails.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is not a runner's own.  
HTTP status: 401

**AccessDeniedException**  
The run is another runner's, or the path names another runner.  
HTTP status: 403

**ResourceNotFoundException**  
No run has that id.  
HTTP status: 404

**ConflictException**  
It is not running, or ended otherwise.  
HTTP status: 409

---

## GetHealth

Get the service's health and version.

### Request syntax

```http
GET /health HTTP/1.1
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "ok": "true",
   "version": "string",
   "commit": "string"
}
```

### Response elements

**ok**  
Always true: an answer at all means it is up.  
Type: Boolean.

**version**  
The package's version.  
Type: String.

**commit**  
The commit it was built from, ending `-dirty` when built with uncommitted changes.  
Type: String.

---

## GetRun

Get a run.

### Request syntax

```http
GET /runs/{id} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
The run's id.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "repo": "string",
   "commit": "string",
   "job": "string",
   "routine": {
      "repo": "string",
      "commit": "string",
      "dir": "string"
   },
   "host": "string",
   "args": [ "string" ],
   "limits": {
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "for": {
      "kind": "batch | change | item | worker",
      "id": "string"
   },
   "state": "pending | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "runner": "string",
   "runsWith": {
      "memory": number,
      "timeout": number,
      "stall": number
   },
   "exit": number,
   "duration": number,
   "logSize": number,
   "submittedBy": "string",
   "createdAt": "string",
   "updatedAt": "string",
   "startedAt": "string",
   "endedAt": "string",
   "leaseExpiresAt": "string"
}
```

### Response elements

**id**  
The run's id.  
Type: String.

**repo**  
`owner/name` on GitHub: checked out at `/work`; with a routine, its target.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
The commit to run, as a full lowercase sha: the runner checks out exactly this.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.  
Type: [Routine](#routine) object.

**host**  
The machine it must run on, on the host itself; null: any runner that fits.  
Type: String. Nullable: Yes.

**args**  
Appended to the job's `run` command from `jobs.toml`.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.  
Type: Object.

**for**  
What it was for; null when its submitter did not say.  
Type: [For](#for) object.

**state**  
`pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.  
Type: String. Nullable: Yes.

**cancelRequested**  
A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.  
Type: Boolean.

**runner**  
The runner that claimed it; null while pending.  
Type: String. Nullable: Yes.

**runsWith**  
What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.  
Type: [RunsWith](#runswith) object.

**exit**  
The run's exit code, once its runner reports one.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran, as its runner reported.  
Type: Number. Nullable: Yes.

**logSize**  
Bytes of log stored so far.  
Type: Integer.

**submittedBy**  
The `claimed-by` it was submitted with.  
Type: String. Nullable: Yes.

**createdAt**  
When it was submitted, as an ISO 8601 timestamp.  
Type: String.

**updatedAt**  
When it last changed, as an ISO 8601 timestamp.  
Type: String.

**startedAt**  
When a runner claimed it; null while pending.  
Type: String. Nullable: Yes.

**endedAt**  
When it ended; null until it does.  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
While running: if no log append renews it by then, the run fails.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the submitters'.  
HTTP status: 401

**ResourceNotFoundException**  
No run has that id.  
HTTP status: 404

**ServiceUnavailableException**  
The service has no submitters' token configured.  
HTTP status: 503

---

## GetRunLog

Send `Range: bytes=N-` to read from offset N; without it, from 0. Answers 206 with `Content-Range: bytes N-M/size` and at most 1 MiB, or an empty body when N is the log's size, so a follower polls from where it got to. `Run-State` says the run's state, so it knows when to stop.

### Request syntax

```http
GET /runs/{id}/log HTTP/1.1
Authorization: Bearer token
range: string
```

### URI request parameters

**id**  
The run's id.  
Type: String. Required: Yes.

### Request headers

**range**  
`bytes=N-`  
Type: String. Pattern: `^bytes=\d+-$`. Required: No.

### Response syntax

```http
HTTP/1.1 206
content-range: string
run-state: string
Content-type: text/plain

The log from N, up to 1 MiB.
```

### Response elements

The log from N, up to 1 MiB. As `text/plain`.

### Response headers

**content-range**  
`bytes N-M/size` for the bytes sent, or `bytes */size` when there are none: `size` is the log's length so far.  
Type: String.

**run-state**  
The run's state: once it has ended and the log is read to `size`, there is no more.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the submitters'.  
HTTP status: 401

**ResourceNotFoundException**  
No run has that id.  
HTTP status: 404

**InvalidRangeException**  
N is past the end of the log.  
HTTP status: 416

**ServiceUnavailableException**  
The service has no submitters' token configured.  
HTTP status: 503

---

## GetSkill

The jobs skill's `bin/` and `reference/`, as this deployment was built with them, so a worker calls the API that is deployed.

### Request syntax

```http
GET /skill HTTP/1.1
Authorization: Bearer token
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "key": "string",
   "version": number,
   "commit": "string",
   "files": [ {
      "path": "string",
      "content": "string",
      "executable": boolean
   } ]
}
```

### Response elements

**key**  
The skill's name, which its files are under.  
Type: String.

**version**  
The deployed tree's commit count, 0 when deployed from outside git.  
Type: Integer.

**commit**  
The deployed commit, ending `-dirty` when deployed with uncommitted changes.  
Type: String.

**files**  
Every file of the skill, as a worker installs it.  
Type: Array of [SkillFile](#skillfile) objects.

### Errors

**UnauthorizedException**  
The bearer token is missing or is not the submitters'.  
HTTP status: 401

**ServiceUnavailableException**  
The service has no submitters' token configured.  
HTTP status: 503

---

## ListRunners

List runners, most recently seen first.

### Request syntax

```http
GET /runners HTTP/1.1
Authorization: Bearer token
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "runners": [ {
      "id": "string",
      "name": "string",
      "labels": { },
      "slots": number,
      "memory": number,
      "version": "string",
      "hostId": "string",
      "createdAt": "string",
      "lastSeenAt": "string"
   } ]
}
```

### Response elements

**runners**  
Every registered runner, most recently seen first.  
Type: Array of [Runner](#runner) objects.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the submitters'.  
HTTP status: 401

**ServiceUnavailableException**  
The service has no submitters' token configured.  
HTTP status: 503

---

## ListRuns

List runs, newest first.

### Request syntax

```http
GET /runs?state=state&repo=repo&submittedBy=submittedBy&for=for&limit=limit HTTP/1.1
Authorization: Bearer token
```

### Query parameters

**state**  
`pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`. Required: No.

**repo**  
`owner/name` on GitHub.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`. Required: No.

**submittedBy**  
Only the runs submitted with this `claimed-by`, as `submittedBy` records it.  
Type: String. Length: 1 to 200. Required: No.

**for**  
`<kind>:<id>`, e.g. `item:28af81bc-…`: only the runs submitted with that `for`.  
Type: String. Required: No.

**limit**  
At most this many, newest first.  
Type: Integer. Range: 1 to 500. Required: No.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "runs": [ {
      "id": "string",
      "repo": "string",
      "commit": "string",
      "job": "string",
      "routine": {
         "repo": "string",
         "commit": "string",
         "dir": "string"
      },
      "host": "string",
      "args": [ "string" ],
      "limits": {
         "memory": number,
         "timeout": number
      },
      "labels": { },
      "for": {
         "kind": "batch | change | item | worker",
         "id": "string"
      },
      "state": "pending | running | succeeded | failed | canceled",
      "reason": "string",
      "cancelRequested": boolean,
      "runner": "string",
      "runsWith": {
         "memory": number,
         "timeout": number,
         "stall": number
      },
      "exit": number,
      "duration": number,
      "logSize": number,
      "submittedBy": "string",
      "createdAt": "string",
      "updatedAt": "string",
      "startedAt": "string",
      "endedAt": "string",
      "leaseExpiresAt": "string"
   } ]
}
```

### Response elements

**runs**  
The runs, newest first.  
Type: Array of [Run](#run) objects.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the submitters'.  
HTTP status: 401

**ServiceUnavailableException**  
The service has no submitters' token configured.  
HTTP status: 503

---

## PutRunsWith

From the run's own runner, once it has read `jobs.toml` and before it starts the run's container. Sending it again replaces it.

### Request syntax

```http
PUT /runs/{id}/runs-with HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "memory": number,
   "timeout": number,
   "stall": number
}
```

### URI request parameters

**id**  
The run's id.  
Type: String. Required: Yes.

### Request body

**memory**  
MiB the container may use.  
Type: Integer. Range: 1 to 1048576. Required: Yes.

**timeout**  
Seconds before the runner stops it and it fails.  
Type: Integer. Range: 1 to 86400. Required: Yes.

**stall**  
Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.  
Type: Integer. Range: 1 to 86400. Nullable: Yes. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "repo": "string",
   "commit": "string",
   "job": "string",
   "routine": {
      "repo": "string",
      "commit": "string",
      "dir": "string"
   },
   "host": "string",
   "args": [ "string" ],
   "limits": {
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "for": {
      "kind": "batch | change | item | worker",
      "id": "string"
   },
   "state": "pending | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "runner": "string",
   "runsWith": {
      "memory": number,
      "timeout": number,
      "stall": number
   },
   "exit": number,
   "duration": number,
   "logSize": number,
   "submittedBy": "string",
   "createdAt": "string",
   "updatedAt": "string",
   "startedAt": "string",
   "endedAt": "string",
   "leaseExpiresAt": "string"
}
```

### Response elements

**id**  
The run's id.  
Type: String.

**repo**  
`owner/name` on GitHub: checked out at `/work`; with a routine, its target.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
The commit to run, as a full lowercase sha: the runner checks out exactly this.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.  
Type: [Routine](#routine) object.

**host**  
The machine it must run on, on the host itself; null: any runner that fits.  
Type: String. Nullable: Yes.

**args**  
Appended to the job's `run` command from `jobs.toml`.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.  
Type: Object.

**for**  
What it was for; null when its submitter did not say.  
Type: [For](#for) object.

**state**  
`pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.  
Type: String. Nullable: Yes.

**cancelRequested**  
A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.  
Type: Boolean.

**runner**  
The runner that claimed it; null while pending.  
Type: String. Nullable: Yes.

**runsWith**  
What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.  
Type: [RunsWith](#runswith) object.

**exit**  
The run's exit code, once its runner reports one.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran, as its runner reported.  
Type: Number. Nullable: Yes.

**logSize**  
Bytes of log stored so far.  
Type: Integer.

**submittedBy**  
The `claimed-by` it was submitted with.  
Type: String. Nullable: Yes.

**createdAt**  
When it was submitted, as an ISO 8601 timestamp.  
Type: String.

**updatedAt**  
When it last changed, as an ISO 8601 timestamp.  
Type: String.

**startedAt**  
When a runner claimed it; null while pending.  
Type: String. Nullable: Yes.

**endedAt**  
When it ended; null until it does.  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
While running: if no log append renews it by then, the run fails.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is not a runner's own.  
HTTP status: 401

**AccessDeniedException**  
The run is another runner's, or the path names another runner.  
HTTP status: 403

**ResourceNotFoundException**  
No run has that id.  
HTTP status: 404

**ConflictException**  
It is not running.  
HTTP status: 409

---

## RegisterRunner

With the registration token, not the submitters'. Answers the runner's own token once.

### Request syntax

```http
POST /runners HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "name": "string",
   "labels": { },
   "slots": number,
   "memory": number,
   "version": "string",
   "hostId": "string"
}
```

### Request body

**name**  
What it calls itself, e.g. its host's name: not unique.  
Type: String. Length: 1 to 200. Required: Yes.

**labels**  
Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.  
Type: Object. Required: No.

**slots**  
Runs it runs at once.  
Type: Integer. Range: 1 to 64. Required: Yes.

**memory**  
MiB it has for runs and their image builds.  
Type: Integer. Range: 16 to 1048576. Required: Yes.

**version**  
job-runner's version.  
Type: String. Length: 0 to 100. Nullable: Yes. Required: No.

**hostId**  
The machine it runs on: its worker-host's `host_id`, by default the hostname.  
Type: String. Length: 1 to 200. Nullable: Yes. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "runner": {
      "id": "string",
      "name": "string",
      "labels": { },
      "slots": number,
      "memory": number,
      "version": "string",
      "hostId": "string",
      "createdAt": "string",
      "lastSeenAt": "string"
   },
   "token": "string"
}
```

### Response elements

**runner**  
The runner, registered.  
Type: [Runner](#runner) object.

**token**  
Its own bearer token, `<runner id>.<secret>`, shown only here: keep it where only the runner's user can read it.  
Type: String.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the submitters'.  
HTTP status: 401

**ServiceUnavailableException**  
The service has no submitters' token configured.  
HTTP status: 503

---

## SubmitRun

One run, stored `pending` until a runner whose labels and free memory fit claims it, with what it was for when `for` says. Nothing is checked against the repo here: a run of a job missing from `jobs.toml` at that commit fails on its runner, saying so in its log.

### Request syntax

```http
POST /runs HTTP/1.1
Authorization: Bearer token
claimed-by: string
Content-type: application/json

{
   "repo": "string",
   "commit": "string",
   "job": "string",
   "args": [ "string" ],
   "limits": {
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "for": {
      "kind": "batch | change | item | worker",
      "id": "string"
   },
   "routine": {
      "repo": "string",
      "commit": "string",
      "dir": "string"
   },
   "host": "string"
}
```

### Request headers

**claimed-by**  
Who is submitting: recorded on the run as `submittedBy`.  
Type: String. Length: 1 to 200. Required: No.

### Request body

**repo**  
`owner/name` on GitHub.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`. Required: Yes.

**commit**  
The commit to run, as a full lowercase sha: the runner checks out exactly this.  
Type: String. Pattern: `^[0-9a-f]{40}$`. Required: Yes.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`. Required: Yes.

**args**  
Appended to the job's `run` command from `jobs.toml`.  
Type: Array of strings. At most 50 items. Required: No.

**limits**  
Type: [Limits](#limits) object. Required: No.

**labels**  
Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.  
Type: Object. Required: No.

**for**  
What the run was for, as `GET /runs?for=<kind>:<id>` lists it.  
Type: [For](#for) object. Required: No.

**routine**  
Where the job's steps live, when not in its own repo: `job` is read from `<dir>/jobs.toml` in `repo` at `commit`, and the run's own `repo` and `commit` are its target, the package checked out at `/work` beside the routine. Only a runner that says it `can` run a `routine` claims it.  
Type: [Routine](#routine) object. Required: No.

**host**  
The machine it must run on, as a runner's `hostId`: claimed only by that machine's runner, and only one that says it `can` run `host` runs, which runs it on the host itself, with the host's user services, if that host's config lets it. Null: any runner that fits.  
Type: String. Length: 1 to 200. Nullable: Yes. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "id": "string",
   "repo": "string",
   "commit": "string",
   "job": "string",
   "routine": {
      "repo": "string",
      "commit": "string",
      "dir": "string"
   },
   "host": "string",
   "args": [ "string" ],
   "limits": {
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "for": {
      "kind": "batch | change | item | worker",
      "id": "string"
   },
   "state": "pending | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "runner": "string",
   "runsWith": {
      "memory": number,
      "timeout": number,
      "stall": number
   },
   "exit": number,
   "duration": number,
   "logSize": number,
   "submittedBy": "string",
   "createdAt": "string",
   "updatedAt": "string",
   "startedAt": "string",
   "endedAt": "string",
   "leaseExpiresAt": "string"
}
```

### Response elements

**id**  
The run's id.  
Type: String.

**repo**  
`owner/name` on GitHub: checked out at `/work`; with a routine, its target.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
The commit to run, as a full lowercase sha: the runner checks out exactly this.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.  
Type: [Routine](#routine) object.

**host**  
The machine it must run on, on the host itself; null: any runner that fits.  
Type: String. Nullable: Yes.

**args**  
Appended to the job's `run` command from `jobs.toml`.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.  
Type: Object.

**for**  
What it was for; null when its submitter did not say.  
Type: [For](#for) object.

**state**  
`pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.  
Type: String. Nullable: Yes.

**cancelRequested**  
A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.  
Type: Boolean.

**runner**  
The runner that claimed it; null while pending.  
Type: String. Nullable: Yes.

**runsWith**  
What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.  
Type: [RunsWith](#runswith) object.

**exit**  
The run's exit code, once its runner reports one.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran, as its runner reported.  
Type: Number. Nullable: Yes.

**logSize**  
Bytes of log stored so far.  
Type: Integer.

**submittedBy**  
The `claimed-by` it was submitted with.  
Type: String. Nullable: Yes.

**createdAt**  
When it was submitted, as an ISO 8601 timestamp.  
Type: String.

**updatedAt**  
When it last changed, as an ISO 8601 timestamp.  
Type: String.

**startedAt**  
When a runner claimed it; null while pending.  
Type: String. Nullable: Yes.

**endedAt**  
When it ended; null until it does.  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
While running: if no log append renews it by then, the run fails.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the submitters'.  
HTTP status: 401

**ServiceUnavailableException**  
The service has no submitters' token configured.  
HTTP status: 503

---

# Data types

## Error

Every error's body.

### Contents

**code**  
What went wrong, as an exception name: one per HTTP status.  
Type: String. Valid values: `ValidationException` | `UnauthorizedException` | `AccessDeniedException` | `ResourceNotFoundException` | `ConflictException` | `PayloadTooLargeException` | `InvalidRangeException` | `InternalServerException` | `ServiceUnavailableException`. Required: Yes.

**message**  
What went wrong, in words.  
Type: String. Required: Yes.

## For

What it was for; null when its submitter did not say.

### Contents

**kind**  
What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.  
Type: String. Valid values: `batch` | `change` | `item` | `worker`. Required: Yes.

**id**  
Its id there, without spaces.  
Type: String. Pattern: `^\S{1,200}$`. Required: Yes.

## Health

### Contents

**ok**  
Always true: an answer at all means it is up.  
Type: Boolean. Required: Yes.

**version**  
The package's version.  
Type: String. Required: Yes.

**commit**  
The commit it was built from, ending `-dirty` when built with uncommitted changes.  
Type: String. Required: Yes.

## InvalidRangeError

Every error's body.

### Contents

## Limits

### Contents

**memory**  
MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.  
Type: Integer. Range: 16 to 1048576. Nullable: Yes. Required: No.

**timeout**  
Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.  
Type: Integer. Range: 1 to 86400. Nullable: Yes. Required: No.

## Routine

Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.

### Contents

**repo**  
`owner/name` on GitHub: the repo the routine is in.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`. Required: Yes.

**commit**  
The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.  
Type: String. Pattern: `^[0-9a-f]{40}$`. Required: Yes.

**dir**  
The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.  
Type: String. Length: 0 to 200. Pattern: `^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$`. Required: Yes.

## Run

### Contents

**id**  
The run's id.  
Type: String. Required: Yes.

**repo**  
`owner/name` on GitHub: checked out at `/work`; with a routine, its target.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`. Required: Yes.

**commit**  
The commit to run, as a full lowercase sha: the runner checks out exactly this.  
Type: String. Pattern: `^[0-9a-f]{40}$`. Required: Yes.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`. Required: Yes.

**routine**  
Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.  
Type: [Routine](#routine) object. Required: Yes.

**host**  
The machine it must run on, on the host itself; null: any runner that fits.  
Type: String. Nullable: Yes. Required: Yes.

**args**  
Appended to the job's `run` command from `jobs.toml`.  
Type: Array of strings. Required: Yes.

**limits**  
Type: [Limits](#limits) object. Required: Yes.

**labels**  
Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.  
Type: Object. Required: Yes.

**for**  
What it was for; null when its submitter did not say.  
Type: [For](#for) object. Required: Yes.

**state**  
`pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`. Required: Yes.

**reason**  
Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.  
Type: String. Nullable: Yes. Required: Yes.

**cancelRequested**  
A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.  
Type: Boolean. Required: Yes.

**runner**  
The runner that claimed it; null while pending.  
Type: String. Nullable: Yes. Required: Yes.

**runsWith**  
What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.  
Type: [RunsWith](#runswith) object. Required: Yes.

**exit**  
The run's exit code, once its runner reports one.  
Type: Integer. Nullable: Yes. Required: Yes.

**duration**  
Seconds it ran, as its runner reported.  
Type: Number. Nullable: Yes. Required: Yes.

**logSize**  
Bytes of log stored so far.  
Type: Integer. Required: Yes.

**submittedBy**  
The `claimed-by` it was submitted with.  
Type: String. Nullable: Yes. Required: Yes.

**createdAt**  
When it was submitted, as an ISO 8601 timestamp.  
Type: String. Required: Yes.

**updatedAt**  
When it last changed, as an ISO 8601 timestamp.  
Type: String. Required: Yes.

**startedAt**  
When a runner claimed it; null while pending.  
Type: String. Nullable: Yes. Required: Yes.

**endedAt**  
When it ended; null until it does.  
Type: String. Nullable: Yes. Required: Yes.

**leaseExpiresAt**  
While running: if no log append renews it by then, the run fails.  
Type: String. Nullable: Yes. Required: Yes.

## Runner

The runner, registered.

### Contents

**id**  
The runner's id.  
Type: String. Required: Yes.

**name**  
What it calls itself, e.g. its host's name: not unique.  
Type: String. Required: Yes.

**labels**  
Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.  
Type: Object. Required: Yes.

**slots**  
Runs it runs at once.  
Type: Integer. Required: Yes.

**memory**  
MiB it has for runs and their image builds.  
Type: Integer. Required: Yes.

**version**  
job-runner's version, as it said.  
Type: String. Nullable: Yes. Required: Yes.

**hostId**  
The machine it runs on, the same as that machine's worker-host's `host_id` (by default its hostname); null until it says.  
Type: String. Nullable: Yes. Required: Yes.

**createdAt**  
When it registered, as an ISO 8601 timestamp.  
Type: String. Required: Yes.

**lastSeenAt**  
When it last asked for a run, as an ISO 8601 timestamp.  
Type: String. Required: Yes.

## RunsWith

What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.

### Contents

**memory**  
MiB the container may use.  
Type: Integer. Range: 1 to 1048576. Required: Yes.

**timeout**  
Seconds before the runner stops it and it fails.  
Type: Integer. Range: 1 to 86400. Required: Yes.

**stall**  
Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.  
Type: Integer. Range: 1 to 86400. Nullable: Yes. Required: Yes.

## Skill

### Contents

**key**  
The skill's name, which its files are under.  
Type: String. Required: Yes.

**version**  
The deployed tree's commit count, 0 when deployed from outside git.  
Type: Integer. Required: Yes.

**commit**  
The deployed commit, ending `-dirty` when deployed with uncommitted changes.  
Type: String. Required: Yes.

**files**  
Every file of the skill, as a worker installs it.  
Type: Array of [SkillFile](#skillfile) objects. Required: Yes.

## SkillFile

### Contents

**path**  
Under the worker's Claude Code folder: `skills/jobs/bin/…` or `skills/jobs/reference/…`.  
Type: String. Required: Yes.

**content**  
The file's text.  
Type: String. Required: Yes.

**executable**  
Whether to install it executable: true for everything under `bin/`.  
Type: Boolean. Required: Yes.

