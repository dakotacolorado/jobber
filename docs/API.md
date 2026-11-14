# jobber API reference

API version 2026-11-13

Submit code to run on whatever computers you have. A **job** is a named script in a repo's `jobs.toml`; a **run** is one execution of it at a commit.

- **Submit** a run, with a `priority` if it should jump the queue, see where it waits with `ListQueue`, then follow it: `pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`.
- **Read its log** with `GetRunLog`, from any byte offset, while it runs and after.
- **Hosts** are the computers that run jobber-host, which registers, holds a connection over which it is sent its runs, and reports their logs and ends through the *Host protocol* calls. You don't call those.

- **Secrets** are set by an admin (`PutSecret`), stored encrypted, and never read back: a run naming them in `secrets` is given each as an environment variable.

**Auth:** `Authorization: Bearer <token>` with the submitters' token, on everything but `GetHealth` and the *Secrets* calls, which take the admin's.

**Errors:** `{code, message}`, where `code` is an AWS-style exception name such as `ValidationException` or `ResourceNotFoundException`.

## Operations

- [AppendRunLog](#appendrunlog): Append to a log
- [CancelRun](#cancelrun): Cancel a run
- [CompleteRun](#completerun): Complete a run
- [ConnectHost](#connecthost): Connect a host
- [DeleteSecret](#deletesecret): Delete a secret
- [GetHealth](#gethealth): Get health
- [GetRun](#getrun): Get a run
- [GetRunLog](#getrunlog): Get a run's log
- [ListHosts](#listhosts): List hosts
- [ListQueue](#listqueue): List the queue
- [ListRuns](#listruns): List runs
- [ListSecrets](#listsecrets): List secrets
- [PutSecret](#putsecret): Put a secret
- [RegisterHost](#registerhost): Register a host
- [SendHeartbeat](#sendheartbeat): Send a heartbeat
- [SubmitRun](#submitrun): Submit a run
- [UpdateRunPriority](#updaterunpriority): Update run priority

## Data types

- [Attempt](#attempt)
- [Capacity](#capacity)
- [Error](#error)
- [Free](#free)
- [Health](#health)
- [Host](#host)
- [InvalidRangeError](#invalidrangeerror)
- [Metrics](#metrics)
- [Requirements](#requirements)
- [Retry](#retry)
- [Run](#run)
- [Secret](#secret)

---

## AppendRunLog

Appends bytes at the log's end (`Content-Range: bytes S-E/*`). Max 256 KiB per call, 64 MiB per run.

### Request syntax

```http
PATCH /runs/{id}/log?attempt=attempt HTTP/1.1
Authorization: Bearer token
content-range: string
Content-type: application/octet-stream

The log's next bytes.
```

### URI request parameters

**id**  
The run's id.  
Type: String. Required: Yes.

### Query parameters

**attempt**  
The attempt it was started on. Refused with 409 if the run has moved on.  
Type: Integer. Range: 1 to any. Required: No.

### Request headers

**content-range**  
`bytes S-E/*`  
Type: String. Pattern: `^bytes \d+-\d+\/(\*|\d+)$`. Required: Yes.

### Request body

The log's next bytes., as `application/octet-stream`.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "size": number
}
```

### Response elements

**size**  
Log size: where the next append starts.  
Type: Integer.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is not a host's own.  
HTTP status: 401

**AccessDeniedException**  
The run is another host's, or the path names another host.  
HTTP status: 403

**ResourceNotFoundException**  
No run has that id.  
HTTP status: 404

**ConflictException**  
The run is not running, or not on that attempt: it ended, perhaps by its lease lapsing.  
HTTP status: 409

**PayloadTooLargeException**  
Over 256 KiB, or the log would pass 64 MiB.  
HTTP status: 413

**InvalidRangeException**  
The append does not start at the log's end: resend from `size`.  
HTTP status: 416

---

## CancelRun

Ends a run not yet started (pending or assigned) now. A running one is stopped by its host within seconds.

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
   "args": [ "string" ],
   "requirements": {
      "os": "linux | macos | windows | ",
      "arch": "x86_64 | aarch64 | ",
      "cpu": number,
      "memory": number,
      "gpu": number,
      "gpuMemory": number,
      "timeout": number,
      "host": "string"
   },
   "labels": { },
   "priority": number,
   "retry": {
      "limit": number,
      "backoff": number
   },
   "secrets": [ "string" ],
   "onHost": boolean,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
   "attempts": [ {
      "attempt": number,
      "host": "string",
      "state": "succeeded | failed | canceled",
      "exit": number,
      "reason": "string",
      "duration": number,
      "logSize": number,
      "startedAt": "string",
      "endedAt": "string"
   } ],
   "retryAt": "string",
   "host": "string",
   "assignedAt": "string",
   "exit": number,
   "duration": number,
   "logSize": number,
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

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**requirements**  
What the run needs from its host.  
Type: [Requirements](#requirements) object.

**labels**  
Free-form key-value labels.  
Type: Object.

**priority**  
Higher is placed first; equal ones oldest first. -1000 to 1000.  
Type: Integer. Range: -1000 to 1000.

**retry**  
Retries a failed attempt (not a canceled one).  
Type: [Retry](#retry) object.

**secrets**  
Secrets its host gives it as environment variables of their names.  
Type: Array of strings. At most 50 items.

**onHost**  
Run on the host `requirements.host` names itself, as its user, in the checkout, outside a container. That host's jobber-host runs it only for a repo on its `host_runs` allowlist, and fails it otherwise. Default: false.  
Type: Boolean.

**state**  
`pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`. An assignment not taken goes back to `pending`.  
Type: String. Valid values: `pending` | `assigned` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its host will stop it.  
Type: Boolean.

**attempt**  
Which try this is, from 1: the run's other fields are this attempt's.  
Type: Integer. Range: 1 to any.

**attempts**  
Earlier attempts, oldest first.  
Type: Array of [Attempt](#attempt) objects.

**retryAt**  
A retry waits in the queue until then (ISO 8601).  
Type: String. Nullable: Yes.

**host**  
Host it is assigned to or ran on.  
Type: String. Nullable: Yes.

**assignedAt**  
Placed on `host` at (ISO 8601), while `assigned`.  
Type: String. Nullable: Yes.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Started on its host at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its host's heartbeat renews it.  
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

## CompleteRun

Records how a run ended. Retrying with the same result is safe.

### Request syntax

```http
PUT /runs/{id}?attempt=attempt HTTP/1.1
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

### Query parameters

**attempt**  
The attempt it was started on. Refused with 409 if the run has moved on.  
Type: Integer. Range: 1 to any. Required: No.

### Request body

**state**  
How it ended.  
Type: String. Valid values: `succeeded` | `failed` | `canceled`. Required: Yes.

**exit**  
Exit code, if it ran.  
Type: Integer. Nullable: Yes. Required: Yes.

**duration**  
Seconds from start to end.  
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
   "args": [ "string" ],
   "requirements": {
      "os": "linux | macos | windows | ",
      "arch": "x86_64 | aarch64 | ",
      "cpu": number,
      "memory": number,
      "gpu": number,
      "gpuMemory": number,
      "timeout": number,
      "host": "string"
   },
   "labels": { },
   "priority": number,
   "retry": {
      "limit": number,
      "backoff": number
   },
   "secrets": [ "string" ],
   "onHost": boolean,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
   "attempts": [ {
      "attempt": number,
      "host": "string",
      "state": "succeeded | failed | canceled",
      "exit": number,
      "reason": "string",
      "duration": number,
      "logSize": number,
      "startedAt": "string",
      "endedAt": "string"
   } ],
   "retryAt": "string",
   "host": "string",
   "assignedAt": "string",
   "exit": number,
   "duration": number,
   "logSize": number,
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

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**requirements**  
What the run needs from its host.  
Type: [Requirements](#requirements) object.

**labels**  
Free-form key-value labels.  
Type: Object.

**priority**  
Higher is placed first; equal ones oldest first. -1000 to 1000.  
Type: Integer. Range: -1000 to 1000.

**retry**  
Retries a failed attempt (not a canceled one).  
Type: [Retry](#retry) object.

**secrets**  
Secrets its host gives it as environment variables of their names.  
Type: Array of strings. At most 50 items.

**onHost**  
Run on the host `requirements.host` names itself, as its user, in the checkout, outside a container. That host's jobber-host runs it only for a repo on its `host_runs` allowlist, and fails it otherwise. Default: false.  
Type: Boolean.

**state**  
`pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`. An assignment not taken goes back to `pending`.  
Type: String. Valid values: `pending` | `assigned` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its host will stop it.  
Type: Boolean.

**attempt**  
Which try this is, from 1: the run's other fields are this attempt's.  
Type: Integer. Range: 1 to any.

**attempts**  
Earlier attempts, oldest first.  
Type: Array of [Attempt](#attempt) objects.

**retryAt**  
A retry waits in the queue until then (ISO 8601).  
Type: String. Nullable: Yes.

**host**  
Host it is assigned to or ran on.  
Type: String. Nullable: Yes.

**assignedAt**  
Placed on `host` at (ISO 8601), while `assigned`.  
Type: String. Nullable: Yes.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Started on its host at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its host's heartbeat renews it.  
Type: String. Nullable: Yes.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is not a host's own.  
HTTP status: 401

**AccessDeniedException**  
The run is another host's, or the path names another host.  
HTTP status: 403

**ResourceNotFoundException**  
No run has that id.  
HTTP status: 404

**ConflictException**  
It is not running, not on that attempt, or ended otherwise.  
HTTP status: 409

---

## ConnectHost

Opens the WebSocket over which jobber pushes runs to the host and the host sends heartbeats and takes them. Its messages are in `docs/PROTOCOL.md`. A request that is not an upgrade gets 426.

### Request syntax

```http
GET /hosts/{id}/connect HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**id**  
The host's id.  
Type: String. Required: Yes.

### Response syntax

```http
HTTP/1.1 101
```

Switched to the WebSocket.

### Errors

**Switched to the WebSocket.**  
  
HTTP status: 101

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is not a host's own.  
HTTP status: 401

**AccessDeniedException**  
The run is another host's, or the path names another host.  
HTTP status: 403

**UpgradeRequiredException**  
Not a WebSocket upgrade.  
HTTP status: 426

---

## DeleteSecret

Deletes a secret. A run naming it that has not started yet fails when its host would start it. Takes the admin's token.

### Request syntax

```http
DELETE /secrets/{name} HTTP/1.1
Authorization: Bearer token
```

### URI request parameters

**name**  
A secret's name, which is the environment variable a run is given it in: capitals, digits and `_`.  
Type: String. Pattern: `^[A-Z_][A-Z0-9_]{0,127}$`. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "name": "string",
   "createdAt": "string",
   "updatedAt": "string"
}
```

### Response elements

**name**  
A secret's name, which is the environment variable a run is given it in: capitals, digits and `_`.  
Type: String. Pattern: `^[A-Z_][A-Z0-9_]{0,127}$`.

**createdAt**  
First set at (ISO 8601).  
Type: String.

**updatedAt**  
Last set at (ISO 8601).  
Type: String.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the admin's.  
HTTP status: 401

**ResourceNotFoundException**  
No secret has that name.  
HTTP status: 404

**ServiceUnavailableException**  
The service has no admin token, or (to set one) no secrets key, configured.  
HTTP status: 503

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
   "args": [ "string" ],
   "requirements": {
      "os": "linux | macos | windows | ",
      "arch": "x86_64 | aarch64 | ",
      "cpu": number,
      "memory": number,
      "gpu": number,
      "gpuMemory": number,
      "timeout": number,
      "host": "string"
   },
   "labels": { },
   "priority": number,
   "retry": {
      "limit": number,
      "backoff": number
   },
   "secrets": [ "string" ],
   "onHost": boolean,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
   "attempts": [ {
      "attempt": number,
      "host": "string",
      "state": "succeeded | failed | canceled",
      "exit": number,
      "reason": "string",
      "duration": number,
      "logSize": number,
      "startedAt": "string",
      "endedAt": "string"
   } ],
   "retryAt": "string",
   "host": "string",
   "assignedAt": "string",
   "exit": number,
   "duration": number,
   "logSize": number,
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

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**requirements**  
What the run needs from its host.  
Type: [Requirements](#requirements) object.

**labels**  
Free-form key-value labels.  
Type: Object.

**priority**  
Higher is placed first; equal ones oldest first. -1000 to 1000.  
Type: Integer. Range: -1000 to 1000.

**retry**  
Retries a failed attempt (not a canceled one).  
Type: [Retry](#retry) object.

**secrets**  
Secrets its host gives it as environment variables of their names.  
Type: Array of strings. At most 50 items.

**onHost**  
Run on the host `requirements.host` names itself, as its user, in the checkout, outside a container. That host's jobber-host runs it only for a repo on its `host_runs` allowlist, and fails it otherwise. Default: false.  
Type: Boolean.

**state**  
`pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`. An assignment not taken goes back to `pending`.  
Type: String. Valid values: `pending` | `assigned` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its host will stop it.  
Type: Boolean.

**attempt**  
Which try this is, from 1: the run's other fields are this attempt's.  
Type: Integer. Range: 1 to any.

**attempts**  
Earlier attempts, oldest first.  
Type: Array of [Attempt](#attempt) objects.

**retryAt**  
A retry waits in the queue until then (ISO 8601).  
Type: String. Nullable: Yes.

**host**  
Host it is assigned to or ran on.  
Type: String. Nullable: Yes.

**assignedAt**  
Placed on `host` at (ISO 8601), while `assigned`.  
Type: String. Nullable: Yes.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Started on its host at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its host's heartbeat renews it.  
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

Reads up to 1 MiB from byte N (`Range: bytes=N-`) of the latest attempt's log, or `attempt`'s. To follow a run, poll from the last `size` until `Run-State` has ended.

### Request syntax

```http
GET /runs/{id}/log?attempt=attempt HTTP/1.1
Authorization: Bearer token
range: string
```

### URI request parameters

**id**  
The run's id.  
Type: String. Required: Yes.

### Query parameters

**attempt**  
Which attempt's log. Default: the latest.  
Type: Integer. Range: 1 to any. Required: No.

### Request headers

**range**  
`bytes=N-`  
Type: String. Pattern: `^bytes=\d+-$`. Required: No.

### Response syntax

```http
HTTP/1.1 206
content-range: string
run-state: string
run-attempt: string
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
The attempt's state: stop polling once it has ended.  
Type: String. Valid values: `pending` | `assigned` | `running` | `succeeded` | `failed` | `canceled`.

**run-attempt**  
Which attempt's log this is.  
Type: String.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the submitters'.  
HTTP status: 401

**ResourceNotFoundException**  
No run has that id, or it has no such attempt.  
HTTP status: 404

**InvalidRangeException**  
N is past the end of the log.  
HTTP status: 416

**ServiceUnavailableException**  
The service has no submitters' token configured.  
HTTP status: 503

---

## ListHosts

List hosts.

### Request syntax

```http
GET /hosts HTTP/1.1
Authorization: Bearer token
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "hosts": [ {
      "id": "string",
      "name": "string",
      "os": "linux | macos | windows",
      "arch": "x86_64 | aarch64",
      "capacity": {
         "cpu": number,
         "memory": number,
         "gpu": number,
         "gpuMemory": number
      },
      "labels": { },
      "version": "string",
      "features": [ "string" ],
      "free": {
         "cpu": number,
         "memory": number,
         "gpu": number
      },
      "metrics": {
         "cpuLoad": number,
         "memoryUsed": number,
         "memoryTotal": number,
         "diskFree": number,
         "cpus": number
      },
      "createdAt": "string",
      "lastSeenAt": "string",
      "connected": boolean
   } ]
}
```

### Response elements

**hosts**  
Hosts, most recently seen first.  
Type: Array of [Host](#host) objects.

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

## ListQueue

The `pending` runs in the order the scheduler places them: highest `priority` first, then oldest. The first is next to go to a host that fits it; one no host fits is passed over, not waited for, and one waiting out a retry's backoff is listed with its `retryAt`. Move a run with `UpdateRunPriority`.

### Request syntax

```http
GET /queue?limit=limit HTTP/1.1
Authorization: Bearer token
```

### Query parameters

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
      "args": [ "string" ],
      "requirements": {
         "os": "linux | macos | windows | ",
         "arch": "x86_64 | aarch64 | ",
         "cpu": number,
         "memory": number,
         "gpu": number,
         "gpuMemory": number,
         "timeout": number,
         "host": "string"
      },
      "labels": { },
      "priority": number,
      "retry": {
         "limit": number,
         "backoff": number
      },
      "secrets": [ "string" ],
      "onHost": boolean,
      "state": "pending | assigned | running | succeeded | failed | canceled",
      "reason": "string",
      "cancelRequested": boolean,
      "attempt": number,
      "attempts": [ {
         "attempt": number,
         "host": "string",
         "state": "succeeded | failed | canceled",
         "exit": number,
         "reason": "string",
         "duration": number,
         "logSize": number,
         "startedAt": "string",
         "endedAt": "string"
      } ],
      "retryAt": "string",
      "host": "string",
      "assignedAt": "string",
      "exit": number,
      "duration": number,
      "logSize": number,
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
Pending runs, next first.  
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

## ListRuns

List runs.

### Request syntax

```http
GET /runs?state=state&repo=repo&label=label&limit=limit HTTP/1.1
Authorization: Bearer token
```

### Query parameters

**state**  
`pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`. An assignment not taken goes back to `pending`.  
Type: String. Valid values: `pending` | `assigned` | `running` | `succeeded` | `failed` | `canceled`. Required: No.

**repo**  
GitHub repo, `owner/name`.  
Type: String. Length: 0 to 200. Pattern: `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`. Required: No.

**label**  
Only runs with this label, as `key=value`. Repeat to require several.  
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
      "args": [ "string" ],
      "requirements": {
         "os": "linux | macos | windows | ",
         "arch": "x86_64 | aarch64 | ",
         "cpu": number,
         "memory": number,
         "gpu": number,
         "gpuMemory": number,
         "timeout": number,
         "host": "string"
      },
      "labels": { },
      "priority": number,
      "retry": {
         "limit": number,
         "backoff": number
      },
      "secrets": [ "string" ],
      "onHost": boolean,
      "state": "pending | assigned | running | succeeded | failed | canceled",
      "reason": "string",
      "cancelRequested": boolean,
      "attempt": number,
      "attempts": [ {
         "attempt": number,
         "host": "string",
         "state": "succeeded | failed | canceled",
         "exit": number,
         "reason": "string",
         "duration": number,
         "logSize": number,
         "startedAt": "string",
         "endedAt": "string"
      } ],
      "retryAt": "string",
      "host": "string",
      "assignedAt": "string",
      "exit": number,
      "duration": number,
      "logSize": number,
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

## ListSecrets

Lists the secrets' names and when each was set, never their values. Takes the admin's token.

### Request syntax

```http
GET /secrets HTTP/1.1
Authorization: Bearer token
```

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "secrets": [ {
      "name": "string",
      "createdAt": "string",
      "updatedAt": "string"
   } ]
}
```

### Response elements

**secrets**  
Secrets, by name.  
Type: Array of [Secret](#secret) objects.

### Errors

**UnauthorizedException**  
The bearer token is missing or is not the admin's.  
HTTP status: 401

**ServiceUnavailableException**  
The service has no admin token, or (to set one) no secrets key, configured.  
HTTP status: 503

---

## PutSecret

Sets a secret, or replaces its value (to rotate it): runs started after get the new one. Takes the admin's token. The value is stored encrypted under `JOBBER_SECRETS_KEY` and is never returned by any call.

### Request syntax

```http
PUT /secrets/{name} HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "value": "string"
}
```

### URI request parameters

**name**  
A secret's name, which is the environment variable a run is given it in: capitals, digits and `_`.  
Type: String. Pattern: `^[A-Z_][A-Z0-9_]{0,127}$`. Required: Yes.

### Request body

**value**  
The value, up to 64 KiB. Stored encrypted; never returned.  
Type: String. Length: 1 to 65536. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "name": "string",
   "createdAt": "string",
   "updatedAt": "string"
}
```

### Response elements

**name**  
A secret's name, which is the environment variable a run is given it in: capitals, digits and `_`.  
Type: String. Pattern: `^[A-Z_][A-Z0-9_]{0,127}$`.

**createdAt**  
First set at (ISO 8601).  
Type: String.

**updatedAt**  
Last set at (ISO 8601).  
Type: String.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is missing or is not the admin's.  
HTTP status: 401

**ServiceUnavailableException**  
The service has no admin token, or (to set one) no secrets key, configured.  
HTTP status: 503

---

## RegisterHost

Takes the registration token. Returns the host's own token, once. Registering the same name again keeps its id, replaces its token, and updates what it is and offers: a host registers each time it starts.

### Request syntax

```http
POST /hosts HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "name": "string",
   "os": "linux | macos | windows",
   "arch": "x86_64 | aarch64",
   "capacity": {
      "cpu": number,
      "memory": number,
      "gpu": number,
      "gpuMemory": number
   },
   "labels": { },
   "version": "string",
   "features": [ "string" ]
}
```

### Request body

**name**  
Unique host name. Registering it again keeps its id.  
Type: String. Length: 1 to 200. Required: Yes.

**os**  
Operating system.  
Type: String. Valid values: `linux` | `macos` | `windows`. Required: Yes.

**arch**  
CPU architecture.  
Type: String. Valid values: `x86_64` | `aarch64`. Required: Yes.

**capacity**  
What the host offers runs: what it measured, less what it keeps back for the rest of the machine.  
Type: [Capacity](#capacity) object. Required: Yes.

**labels**  
Free-form key-value labels.  
Type: Object. Required: No.

**version**  
jobber-host version.  
Type: String. Length: 0 to 100. Nullable: Yes. Required: No.

**features**  
What its jobber-host can do beyond container runs, of `secrets`, `hostRuns`: a run naming secrets goes only to a host with `secrets`, a run `onHost` only to one with `hostRuns`. Others are kept and ignored.  
Type: Array of strings. At most 50 items. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "host": {
      "id": "string",
      "name": "string",
      "os": "linux | macos | windows",
      "arch": "x86_64 | aarch64",
      "capacity": {
         "cpu": number,
         "memory": number,
         "gpu": number,
         "gpuMemory": number
      },
      "labels": { },
      "version": "string",
      "features": [ "string" ],
      "free": {
         "cpu": number,
         "memory": number,
         "gpu": number
      },
      "metrics": {
         "cpuLoad": number,
         "memoryUsed": number,
         "memoryTotal": number,
         "diskFree": number,
         "cpus": number
      },
      "createdAt": "string",
      "lastSeenAt": "string",
      "connected": boolean
   },
   "token": "string"
}
```

### Response elements

**host**  
The host.  
Type: [Host](#host) object.

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

## SendHeartbeat

Reports free capacity and health, and renews the leases of the runs it lists. Send one at least every 15 seconds.

### Request syntax

```http
POST /hosts/{id}/heartbeat HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "free": {
      "cpu": number,
      "memory": number,
      "gpu": number
   },
   "metrics": {
      "cpuLoad": number,
      "memoryUsed": number,
      "memoryTotal": number,
      "diskFree": number,
      "cpus": number
   },
   "running": [ "string" ]
}
```

### URI request parameters

**id**  
The host's id.  
Type: String. Required: Yes.

### Request body

**free**  
What the host has free for runs now: its capacity less what its runs and image builds hold.  
Type: [Free](#free) object. Required: Yes.

**metrics**  
The host's health.  
Type: [Metrics](#metrics) object. Required: Yes.

**running**  
Runs it is running: their leases are renewed.  
Type: Array of strings. At most 10000 items. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "cancel": [ "string" ],
   "ended": [ "string" ],
   "lease": number
}
```

### Response elements

**cancel**  
Of those runs, the ones to stop and complete as `canceled`.  
Type: Array of strings.

**ended**  
Of those runs, the ones no longer running on this host (e.g. failed by a lapsed lease): stop them, without completing them.  
Type: Array of strings.

**lease**  
Seconds before a run fails without another heartbeat.  
Type: Integer.

### Errors

**ValidationException**  
The request failed validation.  
HTTP status: 400

**UnauthorizedException**  
The bearer token is not a host's own.  
HTTP status: 401

**AccessDeniedException**  
The run is another host's, or the path names another host.  
HTTP status: 403

---

## SubmitRun

Queues a run as `pending`, by `priority` then age, until a host that meets its requirements takes it. The repo isn't checked here: a missing job fails on its host. Refused if a secret it names is not set, if `requirements.host` names no registered host, or if it is `onHost` without one.

### Request syntax

```http
POST /runs HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "repo": "string",
   "commit": "string",
   "job": "string",
   "args": [ "string" ],
   "requirements": {
      "os": "linux | macos | windows | ",
      "arch": "x86_64 | aarch64 | ",
      "cpu": number,
      "memory": number,
      "gpu": number,
      "gpuMemory": number,
      "timeout": number,
      "host": "string"
   },
   "labels": { },
   "priority": number,
   "retry": {
      "limit": number,
      "backoff": number
   },
   "secrets": [ "string" ],
   "onHost": boolean
}
```

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

**requirements**  
What the run needs from its host.  
Type: [Requirements](#requirements) object. Required: No.

**labels**  
Labels to find it by, e.g. what it is for and who asked.  
Type: Object. Required: No.

**priority**  
Higher is placed first; equal ones oldest first. -1000 to 1000. Default: 0.  
Type: Integer. Range: -1000 to 1000. Required: No.

**retry**  
Retries a failed attempt (not a canceled one).  
Type: [Retry](#retry) object. Required: No.

**secrets**  
Secrets its host gives it, each as an environment variable of its name, masked in its log. Each must be set (`PutSecret`). Default: none.  
Type: Array of strings. At most 50 items. Required: No.

**onHost**  
Run on the host `requirements.host` names itself, as its user, in the checkout, outside a container. That host's jobber-host runs it only for a repo on its `host_runs` allowlist, and fails it otherwise. Default: false.  
Type: Boolean. Required: No.

### Response syntax

```http
HTTP/1.1 201
Content-type: application/json

{
   "id": "string",
   "repo": "string",
   "commit": "string",
   "job": "string",
   "args": [ "string" ],
   "requirements": {
      "os": "linux | macos | windows | ",
      "arch": "x86_64 | aarch64 | ",
      "cpu": number,
      "memory": number,
      "gpu": number,
      "gpuMemory": number,
      "timeout": number,
      "host": "string"
   },
   "labels": { },
   "priority": number,
   "retry": {
      "limit": number,
      "backoff": number
   },
   "secrets": [ "string" ],
   "onHost": boolean,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
   "attempts": [ {
      "attempt": number,
      "host": "string",
      "state": "succeeded | failed | canceled",
      "exit": number,
      "reason": "string",
      "duration": number,
      "logSize": number,
      "startedAt": "string",
      "endedAt": "string"
   } ],
   "retryAt": "string",
   "host": "string",
   "assignedAt": "string",
   "exit": number,
   "duration": number,
   "logSize": number,
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

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**requirements**  
What the run needs from its host.  
Type: [Requirements](#requirements) object.

**labels**  
Free-form key-value labels.  
Type: Object.

**priority**  
Higher is placed first; equal ones oldest first. -1000 to 1000.  
Type: Integer. Range: -1000 to 1000.

**retry**  
Retries a failed attempt (not a canceled one).  
Type: [Retry](#retry) object.

**secrets**  
Secrets its host gives it as environment variables of their names.  
Type: Array of strings. At most 50 items.

**onHost**  
Run on the host `requirements.host` names itself, as its user, in the checkout, outside a container. That host's jobber-host runs it only for a repo on its `host_runs` allowlist, and fails it otherwise. Default: false.  
Type: Boolean.

**state**  
`pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`. An assignment not taken goes back to `pending`.  
Type: String. Valid values: `pending` | `assigned` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its host will stop it.  
Type: Boolean.

**attempt**  
Which try this is, from 1: the run's other fields are this attempt's.  
Type: Integer. Range: 1 to any.

**attempts**  
Earlier attempts, oldest first.  
Type: Array of [Attempt](#attempt) objects.

**retryAt**  
A retry waits in the queue until then (ISO 8601).  
Type: String. Nullable: Yes.

**host**  
Host it is assigned to or ran on.  
Type: String. Nullable: Yes.

**assignedAt**  
Placed on `host` at (ISO 8601), while `assigned`.  
Type: String. Nullable: Yes.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Started on its host at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its host's heartbeat renews it.  
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

## UpdateRunPriority

Moves a run not yet ended up or down the queue. A running one keeps its host.

### Request syntax

```http
POST /runs/{id}/priority HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "priority": number
}
```

### URI request parameters

**id**  
The run's id.  
Type: String. Required: Yes.

### Request body

**priority**  
Higher is placed first; equal ones oldest first. -1000 to 1000.  
Type: Integer. Range: -1000 to 1000. Required: Yes.

### Response syntax

```http
HTTP/1.1 200
Content-type: application/json

{
   "id": "string",
   "repo": "string",
   "commit": "string",
   "job": "string",
   "args": [ "string" ],
   "requirements": {
      "os": "linux | macos | windows | ",
      "arch": "x86_64 | aarch64 | ",
      "cpu": number,
      "memory": number,
      "gpu": number,
      "gpuMemory": number,
      "timeout": number,
      "host": "string"
   },
   "labels": { },
   "priority": number,
   "retry": {
      "limit": number,
      "backoff": number
   },
   "secrets": [ "string" ],
   "onHost": boolean,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
   "attempts": [ {
      "attempt": number,
      "host": "string",
      "state": "succeeded | failed | canceled",
      "exit": number,
      "reason": "string",
      "duration": number,
      "logSize": number,
      "startedAt": "string",
      "endedAt": "string"
   } ],
   "retryAt": "string",
   "host": "string",
   "assignedAt": "string",
   "exit": number,
   "duration": number,
   "logSize": number,
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

**args**  
Arguments appended to the job's command.  
Type: Array of strings.

**requirements**  
What the run needs from its host.  
Type: [Requirements](#requirements) object.

**labels**  
Free-form key-value labels.  
Type: Object.

**priority**  
Higher is placed first; equal ones oldest first. -1000 to 1000.  
Type: Integer. Range: -1000 to 1000.

**retry**  
Retries a failed attempt (not a canceled one).  
Type: [Retry](#retry) object.

**secrets**  
Secrets its host gives it as environment variables of their names.  
Type: Array of strings. At most 50 items.

**onHost**  
Run on the host `requirements.host` names itself, as its user, in the checkout, outside a container. That host's jobber-host runs it only for a repo on its `host_runs` allowlist, and fails it otherwise. Default: false.  
Type: Boolean.

**state**  
`pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`. An assignment not taken goes back to `pending`.  
Type: String. Valid values: `pending` | `assigned` | `running` | `succeeded` | `failed` | `canceled`.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes.

**cancelRequested**  
Cancel asked for; its host will stop it.  
Type: Boolean.

**attempt**  
Which try this is, from 1: the run's other fields are this attempt's.  
Type: Integer. Range: 1 to any.

**attempts**  
Earlier attempts, oldest first.  
Type: Array of [Attempt](#attempt) objects.

**retryAt**  
A retry waits in the queue until then (ISO 8601).  
Type: String. Nullable: Yes.

**host**  
Host it is assigned to or ran on.  
Type: String. Nullable: Yes.

**assignedAt**  
Placed on `host` at (ISO 8601), while `assigned`.  
Type: String. Nullable: Yes.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes.

**logSize**  
Log size in bytes.  
Type: Integer.

**createdAt**  
Submitted at (ISO 8601).  
Type: String.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String.

**startedAt**  
Started on its host at (ISO 8601).  
Type: String. Nullable: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes.

**leaseExpiresAt**  
Fails at this time unless its host's heartbeat renews it.  
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

# Data types

## Attempt

An earlier attempt of a run.

### Contents

**attempt**  
Which try, from 1.  
Type: Integer. Range: 1 to any. Required: Yes.

**host**  
Host it ran on.  
Type: String. Nullable: Yes. Required: Yes.

**state**  
How it ended.  
Type: String. Valid values: `succeeded` | `failed` | `canceled`. Required: Yes.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes. Required: Yes.

**reason**  
Why it ended, when not plain.  
Type: String. Nullable: Yes. Required: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes. Required: Yes.

**logSize**  
Its log's size in bytes: read it with `GetRunLog?attempt=`.  
Type: Integer. Required: Yes.

**startedAt**  
Started at (ISO 8601).  
Type: String. Nullable: Yes. Required: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Required: Yes.

## Capacity

What the host offers runs: what it measured, less what it keeps back for the rest of the machine.

### Contents

**cpu**  
CPUs for runs, a decimal number.  
Type: Number. Range: 0.001 to 65536. Required: Yes.

**memory**  
Memory for runs, in MiB.  
Type: Integer. Range: 16 to 67108864. Required: Yes.

**gpu**  
Whole GPUs for runs. Default: 0.  
Type: Integer. Range: 0 to 64. Required: No.

**gpuMemory**  
MiB of memory of its smallest GPU, each given whole to one run. Default: 0.  
Type: Integer. Range: 0 to 1048576. Required: No.

## Error

Every error's body.

### Contents

**code**  
Exception name.  
Type: String. Valid values: `ValidationException` | `UnauthorizedException` | `AccessDeniedException` | `ResourceNotFoundException` | `ConflictException` | `PayloadTooLargeException` | `InvalidRangeException` | `UpgradeRequiredException` | `InternalServerException` | `ServiceUnavailableException`. Required: Yes.

**message**  
What went wrong.  
Type: String. Required: Yes.

## Free

Free capacity, as last reported.

### Contents

**cpu**  
CPUs free for runs.  
Type: Number. Range: 0 to 65536. Required: Yes.

**memory**  
Memory free for runs, in MiB.  
Type: Integer. Range: 0 to 67108864. Required: Yes.

**gpu**  
Whole GPUs free for runs. Default: 0.  
Type: Integer. Range: 0 to 64. Required: No.

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

## Host

The host.

### Contents

**id**  
The host's id.  
Type: String. Required: Yes.

**name**  
Unique host name.  
Type: String. Required: Yes.

**os**  
Operating system.  
Type: String. Valid values: `linux` | `macos` | `windows`. Required: Yes.

**arch**  
CPU architecture.  
Type: String. Valid values: `x86_64` | `aarch64`. Required: Yes.

**capacity**  
What the host offers runs: what it measured, less what it keeps back for the rest of the machine.  
Type: [Capacity](#capacity) object. Required: Yes.

**labels**  
Free-form key-value labels.  
Type: Object. Required: Yes.

**version**  
jobber-host version, as it last registered.  
Type: String. Nullable: Yes. Required: Yes.

**features**  
What its jobber-host can do beyond container runs, of `secrets`, `hostRuns`: a run naming secrets goes only to a host with `secrets`, a run `onHost` only to one with `hostRuns`. Others are kept and ignored.  
Type: Array of strings. At most 50 items. Required: Yes.

**free**  
Free capacity, as last reported.  
Type: [Free](#free) object. Required: Yes.

**metrics**  
Health, as last reported.  
Type: [Metrics](#metrics) object. Required: Yes.

**createdAt**  
First registered at (ISO 8601).  
Type: String. Required: Yes.

**lastSeenAt**  
Last heartbeat at (ISO 8601).  
Type: String. Required: Yes.

**connected**  
Holds a connection open now: the scheduler can push runs to it.  
Type: Boolean. Required: Yes.

## InvalidRangeError

Every error's body.

### Contents

## Metrics

Health, as last reported.

### Contents

**cpuLoad**  
1-minute load average.  
Type: Number. Range: 0 to any. Required: Yes.

**memoryUsed**  
Memory in use, in MiB.  
Type: Integer. Range: 0 to any. Required: Yes.

**memoryTotal**  
Total memory, in MiB.  
Type: Integer. Range: 0 to any. Required: Yes.

**diskFree**  
Free disk where runs work, in MiB.  
Type: Integer. Range: 0 to any. Required: Yes.

**cpus**  
CPUs the machine has, all of them; 0 if unknown.  
Type: Integer. Range: 0 to 65536. Required: Yes.

## Requirements

What the run needs from its host.

### Contents

**os**  
Operating system it needs. Default: any.  
Type: String. Valid values: `linux` | `macos` | `windows` | `null`. Nullable: Yes. Required: No.

**arch**  
CPU architecture it needs. Default: any.  
Type: String. Valid values: `x86_64` | `aarch64` | `null`. Nullable: Yes. Required: No.

**cpu**  
CPUs, a decimal number (e.g. 0.5). Default: 0.5.  
Type: Number. Range: 0.001 to 65536. Nullable: Yes. Required: No.

**memory**  
Memory in MiB. Default: `jobs.toml`'s, else 1024.  
Type: Integer. Range: 16 to 1048576. Nullable: Yes. Required: No.

**gpu**  
Whole GPUs, each its container's own. Default: 1 if it names `gpuMemory`, else none; a job whose `jobs.toml` asks for more fails on its host.  
Type: Integer. Range: 0 to 64. Nullable: Yes. Required: No.

**gpuMemory**  
MiB of memory each of its GPUs must have: it runs only on a host whose GPUs are at least this large. Default: any.  
Type: Integer. Range: 1 to 1048576. Nullable: Yes. Required: No.

**timeout**  
Timeout in seconds. Default: `jobs.toml`'s.  
Type: Integer. Range: 1 to 86400. Nullable: Yes. Required: No.

**host**  
Name of the host it must run on, which must be registered. Default: any. A run `onHost` names one.  
Type: String. Length: 1 to 200. Nullable: Yes. Required: No.

## Retry

Retries a failed attempt (not a canceled one).

### Contents

**limit**  
Retries after a failed attempt, 0 to 10. Default: 0.  
Type: Integer. Range: 0 to 10. Required: No.

**backoff**  
Seconds before the first retry, doubling for each after, at most 3600. Default: 10.  
Type: Integer. Range: 1 to 3600. Required: No.

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

**args**  
Arguments appended to the job's command.  
Type: Array of strings. Required: Yes.

**requirements**  
What the run needs from its host.  
Type: [Requirements](#requirements) object. Required: Yes.

**labels**  
Free-form key-value labels.  
Type: Object. Required: Yes.

**priority**  
Higher is placed first; equal ones oldest first. -1000 to 1000.  
Type: Integer. Range: -1000 to 1000. Required: Yes.

**retry**  
Retries a failed attempt (not a canceled one).  
Type: [Retry](#retry) object. Required: Yes.

**secrets**  
Secrets its host gives it as environment variables of their names.  
Type: Array of strings. At most 50 items. Required: Yes.

**onHost**  
Run on the host `requirements.host` names itself, as its user, in the checkout, outside a container. That host's jobber-host runs it only for a repo on its `host_runs` allowlist, and fails it otherwise. Default: false.  
Type: Boolean. Required: Yes.

**state**  
`pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`. An assignment not taken goes back to `pending`.  
Type: String. Valid values: `pending` | `assigned` | `running` | `succeeded` | `failed` | `canceled`. Required: Yes.

**reason**  
Why it ended, when not plain (e.g. timed out).  
Type: String. Nullable: Yes. Required: Yes.

**cancelRequested**  
Cancel asked for; its host will stop it.  
Type: Boolean. Required: Yes.

**attempt**  
Which try this is, from 1: the run's other fields are this attempt's.  
Type: Integer. Range: 1 to any. Required: Yes.

**attempts**  
Earlier attempts, oldest first.  
Type: Array of [Attempt](#attempt) objects. Required: Yes.

**retryAt**  
A retry waits in the queue until then (ISO 8601).  
Type: String. Nullable: Yes. Required: Yes.

**host**  
Host it is assigned to or ran on.  
Type: String. Nullable: Yes. Required: Yes.

**assignedAt**  
Placed on `host` at (ISO 8601), while `assigned`.  
Type: String. Nullable: Yes. Required: Yes.

**exit**  
Exit code.  
Type: Integer. Nullable: Yes. Required: Yes.

**duration**  
Seconds it ran.  
Type: Number. Nullable: Yes. Required: Yes.

**logSize**  
Log size in bytes.  
Type: Integer. Required: Yes.

**createdAt**  
Submitted at (ISO 8601).  
Type: String. Required: Yes.

**updatedAt**  
Last changed at (ISO 8601).  
Type: String. Required: Yes.

**startedAt**  
Started on its host at (ISO 8601).  
Type: String. Nullable: Yes. Required: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes. Required: Yes.

**leaseExpiresAt**  
Fails at this time unless its host's heartbeat renews it.  
Type: String. Nullable: Yes. Required: Yes.

## Secret

A secret, without its value: no call returns that.

### Contents

**name**  
A secret's name, which is the environment variable a run is given it in: capitals, digits and `_`.  
Type: String. Pattern: `^[A-Z_][A-Z0-9_]{0,127}$`. Required: Yes.

**createdAt**  
First set at (ISO 8601).  
Type: String. Required: Yes.

**updatedAt**  
Last set at (ISO 8601).  
Type: String. Required: Yes.

