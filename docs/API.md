# job-service API reference

API version 2026-11-12

Runs jobs on self-hosted runners. A **job** is a named script in a repo's `jobs.toml`; a **run** is one execution of it at a commit.

- **Submit** a run, then follow it: `pending` → `running` → `succeeded`, `failed` or `canceled`.
- **Read its log** with `GetRunLog`, from any byte offset, while it runs and after.
- **Runners** (job-runner) pull work through the *Runner protocol* calls. You don't call those.

**Auth:** `Authorization: Bearer <token>` with the submitters' token, on everything but `GetHealth`.

**Errors:** `{code, message}`, where `code` is an AWS-style exception name such as `ValidationException` or `ResourceNotFoundException`.

## Operations

- [AppendRunLog](#appendrunlog): Append to a log
- [CancelRun](#cancelrun): Cancel a run
- [ClaimRun](#claimrun): Claim a run
- [CompleteRun](#completerun): Complete a run
- [GetHealth](#gethealth): Get health
- [GetRun](#getrun): Get a run
- [GetRunLog](#getrunlog): Get a run's log
- [ListRunners](#listrunners): List runners
- [ListRuns](#listruns): List runs
- [PutRunsWith](#putrunswith): Put run limits
- [RegisterRunner](#registerrunner): Register a runner
- [SubmitRun](#submitrun): Submit a run

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

---

## AppendRunLog

Appends bytes at the log's end (`Content-Range: bytes S-E/*`) and renews the lease; an empty body only renews. Max 256 KiB per call, 64 MiB per run.

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
Log size: where the next append starts.  
Type: Integer.

**canceled**  
Cancel asked for: stop and complete as `canceled`.  
Type: Boolean.

**leaseExpiresAt**  
Lease end (ISO 8601).  
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

Ends a pending run now. A running one is stopped by its runner within seconds.

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
GitHub repo, `owner/name`.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
Full commit sha to check out.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml`.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
The routine it runs, if any.  
Type: [Routine](#routine) object.

**host**  
The host it must run on, if any.  
Type: String. Nullable: Yes.

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Key-value labels. On a run, what its runner must have.  
Type: Object.

**for**  
What it is for, if given.  
Type: [For](#for) object.

**state**  
`pending` → `running` → `succeeded`, `failed` or `canceled`.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its runner will stop it.  
Type: Boolean.

**runner**  
Runner that claimed it.  
Type: String. Nullable: Yes.

**runsWith**  
Limits it actually runs with, once its runner says.  
Type: [RunsWith](#runswith) object.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**submittedBy**  
Who submitted it (`claimed-by`).  
Type: String. Nullable: Yes.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Claimed at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its runner checks in.  
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

Takes the oldest pending run that fits this runner and marks it `running`. 204 if none fits.

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
Labels now. Default: as registered.  
Type: Object. Required: No.

**can**  
Extra kinds of run it takes: `routine`, `host`.  
Type: Array of strings. At most 10 items. Required: No.

**hostId**  
Host it runs on now.  
Type: String. Length: 1 to 200. Required: No.

**free**  
Free capacity now.  
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
The claimed run.  
Type: [Run](#run) object.

**memory**  
Memory to reserve, in MiB.  
Type: Integer.

**lease**  
Seconds between check-ins before the run fails.  
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

Records how a run ended. Retrying with the same result is safe.

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
How it ended.  
Type: String. Valid values: `succeeded` | `failed` | `canceled`. Required: Yes.

**exit**  
Exit code, if it ran.  
Type: Integer. Nullable: Yes. Required: Yes.

**duration**  
Seconds from claim to end.  
Type: Number. Range: 0 to any. Required: Yes.

**reason**  
Why, if not plain (e.g. `timed out after 600s`).  
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
GitHub repo, `owner/name`.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
Full commit sha to check out.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml`.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
The routine it runs, if any.  
Type: [Routine](#routine) object.

**host**  
The host it must run on, if any.  
Type: String. Nullable: Yes.

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Key-value labels. On a run, what its runner must have.  
Type: Object.

**for**  
What it is for, if given.  
Type: [For](#for) object.

**state**  
`pending` → `running` → `succeeded`, `failed` or `canceled`.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its runner will stop it.  
Type: Boolean.

**runner**  
Runner that claimed it.  
Type: String. Nullable: Yes.

**runsWith**  
Limits it actually runs with, once its runner says.  
Type: [RunsWith](#runswith) object.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**submittedBy**  
Who submitted it (`claimed-by`).  
Type: String. Nullable: Yes.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Claimed at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its runner checks in.  
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

Get health.

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
Always true.  
Type: Boolean.

**version**  
Package version.  
Type: String.

**commit**  
Commit it was built from.  
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
GitHub repo, `owner/name`.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
Full commit sha to check out.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml`.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
The routine it runs, if any.  
Type: [Routine](#routine) object.

**host**  
The host it must run on, if any.  
Type: String. Nullable: Yes.

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Key-value labels. On a run, what its runner must have.  
Type: Object.

**for**  
What it is for, if given.  
Type: [For](#for) object.

**state**  
`pending` → `running` → `succeeded`, `failed` or `canceled`.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its runner will stop it.  
Type: Boolean.

**runner**  
Runner that claimed it.  
Type: String. Nullable: Yes.

**runsWith**  
Limits it actually runs with, once its runner says.  
Type: [RunsWith](#runswith) object.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**submittedBy**  
Who submitted it (`claimed-by`).  
Type: String. Nullable: Yes.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Claimed at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its runner checks in.  
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

Reads up to 1 MiB from byte N (`Range: bytes=N-`). To follow a run, poll from the last `size` until `Run-State` has ended.

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

Log bytes from N, up to 1 MiB.
```

### Response elements

Log bytes from N, up to 1 MiB. As `text/plain`.

### Response headers

**content-range**  
`bytes N-M/size`; `size` is the log's length so far.  
Type: String.

**run-state**  
The run's state: stop polling once it has ended.  
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

## ListRunners

List runners.

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
Runners, most recently seen first.  
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

List runs.

### Request syntax

```http
GET /runs?state=state&repo=repo&submittedBy=submittedBy&for=for&limit=limit HTTP/1.1
Authorization: Bearer token
```

### Query parameters

**state**  
`pending` → `running` → `succeeded`, `failed` or `canceled`.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`. Required: No.

**repo**  
GitHub repo, `owner/name`.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`. Required: No.

**submittedBy**  
Only runs with this `submittedBy`.  
Type: String. Length: 1 to 200. Required: No.

**for**  
Only runs for this `<kind>:<id>`.  
Type: String. Required: No.

**limit**  
Max results. Default: 100.  
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
Runs, newest first.  
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

Records the memory, timeout and stall limit a run actually got, once its runner has read `jobs.toml`.

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
Memory in MiB.  
Type: Integer. Range: 1 to 1048576. Required: Yes.

**timeout**  
Timeout in seconds.  
Type: Integer. Range: 1 to 86400. Required: Yes.

**stall**  
Seconds without progress before it fails as stalled; null for never.  
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
GitHub repo, `owner/name`.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
Full commit sha to check out.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml`.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
The routine it runs, if any.  
Type: [Routine](#routine) object.

**host**  
The host it must run on, if any.  
Type: String. Nullable: Yes.

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Key-value labels. On a run, what its runner must have.  
Type: Object.

**for**  
What it is for, if given.  
Type: [For](#for) object.

**state**  
`pending` → `running` → `succeeded`, `failed` or `canceled`.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its runner will stop it.  
Type: Boolean.

**runner**  
Runner that claimed it.  
Type: String. Nullable: Yes.

**runsWith**  
Limits it actually runs with, once its runner says.  
Type: [RunsWith](#runswith) object.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**submittedBy**  
Who submitted it (`claimed-by`).  
Type: String. Nullable: Yes.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Claimed at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its runner checks in.  
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

Takes the registration token. Returns the runner's own token, once.

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
Display name; not unique.  
Type: String. Length: 1 to 200. Required: Yes.

**labels**  
Key-value labels. On a run, what its runner must have.  
Type: Object. Required: No.

**slots**  
Runs at once.  
Type: Integer. Range: 1 to 64. Required: Yes.

**memory**  
Memory for runs, in MiB.  
Type: Integer. Range: 16 to 1048576. Required: Yes.

**version**  
job-runner version.  
Type: String. Length: 0 to 100. Nullable: Yes. Required: No.

**hostId**  
Host name, as worker-host knows it.  
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
The new runner.  
Type: [Runner](#runner) object.

**token**  
Its own token, `<id>.<secret>`. Shown only once.  
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

Queues a run as `pending` until a runner claims it. The repo isn't checked here: a missing job fails on its runner.

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
Who is submitting; saved as `submittedBy`.  
Type: String. Length: 1 to 200. Required: No.

### Request body

**repo**  
GitHub repo, `owner/name`.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`. Required: Yes.

**commit**  
Full commit sha to check out.  
Type: String. Pattern: `^[0-9a-f]{40}$`. Required: Yes.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml`.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`. Required: Yes.

**args**  
Arguments appended to the job's command.  
Type: Array of strings. At most 50 items. Required: No.

**limits**  
Type: [Limits](#limits) object. Required: No.

**labels**  
Key-value labels. On a run, what its runner must have.  
Type: Object. Required: No.

**for**  
What the run is for: filter with `ListRuns?for=<kind>:<id>`.  
Type: [For](#for) object. Required: No.

**routine**  
Run a job from another repo's `jobs.toml` against this repo (used by release routines).  
Type: [Routine](#routine) object. Required: No.

**host**  
Run on this host itself, outside a container. Default: any runner, in a container.  
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
GitHub repo, `owner/name`.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`.

**commit**  
Full commit sha to check out.  
Type: String. Pattern: `^[0-9a-f]{40}$`.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml`.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`.

**routine**  
The routine it runs, if any.  
Type: [Routine](#routine) object.

**host**  
The host it must run on, if any.  
Type: String. Nullable: Yes.

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**limits**  
Type: [Limits](#limits) object.

**labels**  
Key-value labels. On a run, what its runner must have.  
Type: Object.

**for**  
What it is for, if given.  
Type: [For](#for) object.

**state**  
`pending` → `running` → `succeeded`, `failed` or `canceled`.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its runner will stop it.  
Type: Boolean.

**runner**  
Runner that claimed it.  
Type: String. Nullable: Yes.

**runsWith**  
Limits it actually runs with, once its runner says.  
Type: [RunsWith](#runswith) object.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**submittedBy**  
Who submitted it (`claimed-by`).  
Type: String. Nullable: Yes.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Claimed at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its runner checks in.  
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
Exception name.  
Type: String. Valid values: `ValidationException` | `UnauthorizedException` | `AccessDeniedException` | `ResourceNotFoundException` | `ConflictException` | `PayloadTooLargeException` | `InvalidRangeException` | `InternalServerException` | `ServiceUnavailableException`. Required: Yes.

**message**  
What went wrong.  
Type: String. Required: Yes.

## For

What it is for, if given.

### Contents

**kind**  
What kind of thing asked for it.  
Type: String. Valid values: `batch` | `change` | `item` | `worker`. Required: Yes.

**id**  
Its id.  
Type: String. Pattern: `^\S{1,200}$`. Required: Yes.

## Health

### Contents

**ok**  
Always true.  
Type: Boolean. Required: Yes.

**version**  
Package version.  
Type: String. Required: Yes.

**commit**  
Commit it was built from.  
Type: String. Required: Yes.

## InvalidRangeError

Every error's body.

### Contents

## Limits

### Contents

**memory**  
Memory in MiB. Default: `jobs.toml`'s, else 1024.  
Type: Integer. Range: 16 to 1048576. Nullable: Yes. Required: No.

**timeout**  
Timeout in seconds. Default: `jobs.toml`'s.  
Type: Integer. Range: 1 to 86400. Nullable: Yes. Required: No.

## Routine

The routine it runs, if any.

### Contents

**repo**  
Repo holding the routine.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`. Required: Yes.

**commit**  
Full commit sha of that repo.  
Type: String. Pattern: `^[0-9a-f]{40}$`. Required: Yes.

**dir**  
Directory holding the routine's `jobs.toml`.  
Type: String. Length: 0 to 200. Pattern: `^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$`. Required: Yes.

## Run

### Contents

**id**  
The run's id.  
Type: String. Required: Yes.

**repo**  
GitHub repo, `owner/name`.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`. Required: Yes.

**commit**  
Full commit sha to check out.  
Type: String. Pattern: `^[0-9a-f]{40}$`. Required: Yes.

**job**  
A `[jobs.<name>]` in the repo's `jobs.toml`.  
Type: String. Pattern: `^[a-z0-9][a-z0-9_-]{0,62}$`. Required: Yes.

**routine**  
The routine it runs, if any.  
Type: [Routine](#routine) object. Required: Yes.

**host**  
The host it must run on, if any.  
Type: String. Nullable: Yes. Required: Yes.

**args**  
Arguments appended to the job's command.  
Type: Array of strings. Required: Yes.

**limits**  
Type: [Limits](#limits) object. Required: Yes.

**labels**  
Key-value labels. On a run, what its runner must have.  
Type: Object. Required: Yes.

**for**  
What it is for, if given.  
Type: [For](#for) object. Required: Yes.

**state**  
`pending` → `running` → `succeeded`, `failed` or `canceled`.  
Type: String. Valid values: `pending` | `running` | `succeeded` | `failed` | `canceled`. Required: Yes.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes. Required: Yes.

**cancelRequested**  
Cancel asked for; its runner will stop it.  
Type: Boolean. Required: Yes.

**runner**  
Runner that claimed it.  
Type: String. Nullable: Yes. Required: Yes.

**runsWith**  
Limits it actually runs with, once its runner says.  
Type: [RunsWith](#runswith) object. Required: Yes.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes. Required: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes. Required: Yes.

**logSize**  
Log size in bytes.  
Type: Integer. Required: Yes.

**submittedBy**  
Who submitted it (`claimed-by`).  
Type: String. Nullable: Yes. Required: Yes.

**createdAt**  
Submitted at (ISO 8601).  
Type: String. Required: Yes.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String. Required: Yes.

**startedAt**  
Claimed at (ISO 8601).  
Type: String. Nullable: Yes. Required: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes. Required: Yes.

**leaseExpiresAt**  
Fails at this time unless its runner checks in.  
Type: String. Nullable: Yes. Required: Yes.

## Runner

The new runner.

### Contents

**id**  
The runner's id.  
Type: String. Required: Yes.

**name**  
Display name; not unique.  
Type: String. Required: Yes.

**labels**  
Key-value labels. On a run, what its runner must have.  
Type: Object. Required: Yes.

**slots**  
Runs at once.  
Type: Integer. Required: Yes.

**memory**  
Memory for runs, in MiB.  
Type: Integer. Required: Yes.

**version**  
job-runner version.  
Type: String. Nullable: Yes. Required: Yes.

**hostId**  
Host it runs on.  
Type: String. Nullable: Yes. Required: Yes.

**createdAt**  
Registered at (ISO 8601).  
Type: String. Required: Yes.

**lastSeenAt**  
Last claim at (ISO 8601).  
Type: String. Required: Yes.

## RunsWith

Limits it actually runs with, once its runner says.

### Contents

**memory**  
Memory in MiB.  
Type: Integer. Range: 1 to 1048576. Required: Yes.

**timeout**  
Timeout in seconds.  
Type: Integer. Range: 1 to 86400. Required: Yes.

**stall**  
Seconds without progress before it fails as stalled; null for never.  
Type: Integer. Range: 1 to 86400. Nullable: Yes. Required: Yes.

