# job-service API reference

API version 2026-11-12

Runs jobs on a fleet of hosts. A **job** is a named script in a repo's `jobs.toml`; a **run** is one execution of it at a commit.

- **Submit** a run, with a `priority` if it should jump the queue, then follow it: `pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`.
- **Read its log** with `GetRunLog`, from any byte offset, while it runs and after.
- **Hosts** run job-runner, which registers, sends heartbeats and claims runs through the *Host protocol* calls. You don't call those.

**Auth:** `Authorization: Bearer <token>` with the submitters' token, on everything but `GetHealth`.

**Errors:** `{code, message}`, where `code` is an AWS-style exception name such as `ValidationException` or `ResourceNotFoundException`.

## Operations

- [AppendRunLog](#appendrunlog): Append to a log
- [CancelRun](#cancelrun): Cancel a run
- [ClaimRun](#claimrun): Claim a run
- [CompleteRun](#completerun): Complete a run
- [ConnectHost](#connecthost): Connect a host
- [GetHealth](#gethealth): Get health
- [GetRun](#getrun): Get a run
- [GetRunLog](#getrunlog): Get a run's log
- [ListHosts](#listhosts): List hosts
- [ListRuns](#listruns): List runs
- [RegisterHost](#registerhost): Register a host
- [SendHeartbeat](#sendheartbeat): Send a heartbeat
- [SubmitRun](#submitrun): Submit a run
- [UpdateRunPriority](#updaterunpriority): Update run priority

## Data types

- [Error](#error)
- [Free](#free)
- [Health](#health)
- [Host](#host)
- [InvalidRangeError](#invalidrangeerror)
- [Metrics](#metrics)
- [Requirements](#requirements)
- [Run](#run)

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
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "priority": number,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
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
Which try this is, from 1.  
Type: Integer. Range: 1 to any.

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
Claimed at (ISO 8601).  
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

## ClaimRun

Takes the first queued run (highest priority, then oldest) whose requirements this host meets and marks it `running`. 204 if none fits.

### Request syntax

```http
POST /hosts/{id}/claim HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "free": {
      "slots": number,
      "memory": number
   }
}
```

### URI request parameters

**id**  
The host's id.  
Type: String. Required: Yes.

### Request body

**free**  
Capacity free now.  
Type: [Free](#free) object. Required: Yes.

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
      "args": [ "string" ],
      "requirements": {
         "os": "linux | macos | windows | ",
         "arch": "x86_64 | aarch64 | ",
         "memory": number,
         "timeout": number
      },
      "labels": { },
      "priority": number,
      "state": "pending | assigned | running | succeeded | failed | canceled",
      "reason": "string",
      "cancelRequested": boolean,
      "attempt": number,
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
Seconds before the run fails without a heartbeat.  
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
   "args": [ "string" ],
   "requirements": {
      "os": "linux | macos | windows | ",
      "arch": "x86_64 | aarch64 | ",
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "priority": number,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
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
Which try this is, from 1.  
Type: Integer. Range: 1 to any.

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
Claimed at (ISO 8601).  
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

Opens the WebSocket over which job-service pushes runs to the host and the host sends heartbeats and takes them. Its messages are in `docs/PROTOCOL.md`. A request that is not an upgrade gets 426.

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
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "priority": number,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
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
Which try this is, from 1.  
Type: Integer. Range: 1 to any.

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
Claimed at (ISO 8601).  
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
Type: String. Valid values: `pending` | `assigned` | `running` | `succeeded` | `failed` | `canceled`.

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
      "slots": number,
      "memory": number,
      "labels": { },
      "version": "string",
      "free": {
         "slots": number,
         "memory": number
      },
      "metrics": {
         "cpuLoad": number,
         "memoryUsed": number,
         "memoryTotal": number,
         "diskFree": number
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
         "memory": number,
         "timeout": number
      },
      "labels": { },
      "priority": number,
      "state": "pending | assigned | running | succeeded | failed | canceled",
      "reason": "string",
      "cancelRequested": boolean,
      "attempt": number,
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

## RegisterHost

Takes the registration token. Returns the host's own token, once; registering the same name again replaces it.

### Request syntax

```http
POST /hosts HTTP/1.1
Authorization: Bearer token
Content-type: application/json

{
   "name": "string",
   "os": "linux | macos | windows",
   "arch": "x86_64 | aarch64",
   "slots": number,
   "memory": number,
   "labels": { },
   "version": "string"
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

**slots**  
Runs at once.  
Type: Integer. Range: 1 to 64. Required: Yes.

**memory**  
Memory for runs, in MiB.  
Type: Integer. Range: 16 to 1048576. Required: Yes.

**labels**  
Free-form key-value labels.  
Type: Object. Required: No.

**version**  
job-runner version.  
Type: String. Length: 0 to 100. Nullable: Yes. Required: No.

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
      "slots": number,
      "memory": number,
      "labels": { },
      "version": "string",
      "free": {
         "slots": number,
         "memory": number
      },
      "metrics": {
         "cpuLoad": number,
         "memoryUsed": number,
         "memoryTotal": number,
         "diskFree": number
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
      "slots": number,
      "memory": number
   },
   "metrics": {
      "cpuLoad": number,
      "memoryUsed": number,
      "memoryTotal": number,
      "diskFree": number
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
Capacity free now.  
Type: [Free](#free) object. Required: Yes.

**metrics**  
The host's health.  
Type: [Metrics](#metrics) object. Required: Yes.

**running**  
Runs it is running: their leases are renewed.  
Type: Array of strings. At most 64 items. Required: Yes.

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

Queues a run as `pending`, by `priority` then age, until a host that meets its requirements takes it. The repo isn't checked here: a missing job fails on its host.

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
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "priority": number
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
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "priority": number,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
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
Which try this is, from 1.  
Type: Integer. Range: 1 to any.

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
Claimed at (ISO 8601).  
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
      "memory": number,
      "timeout": number
   },
   "labels": { },
   "priority": number,
   "state": "pending | assigned | running | succeeded | failed | canceled",
   "reason": "string",
   "cancelRequested": boolean,
   "attempt": number,
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
Which try this is, from 1.  
Type: Integer. Range: 1 to any.

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
Claimed at (ISO 8601).  
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

**slots**  
Free run slots.  
Type: Integer. Range: 0 to any. Required: Yes.

**memory**  
Free memory for runs, in MiB.  
Type: Integer. Range: 0 to any. Required: Yes.

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

**slots**  
Runs at once.  
Type: Integer. Required: Yes.

**memory**  
Memory for runs, in MiB.  
Type: Integer. Required: Yes.

**labels**  
Free-form key-value labels.  
Type: Object. Required: Yes.

**version**  
job-runner version.  
Type: String. Nullable: Yes. Required: Yes.

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
Last heartbeat or claim at (ISO 8601).  
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

## Requirements

What the run needs from its host.

### Contents

**os**  
Operating system it needs. Default: any.  
Type: String. Valid values: `linux` | `macos` | `windows` | `null`. Nullable: Yes. Required: No.

**arch**  
CPU architecture it needs. Default: any.  
Type: String. Valid values: `x86_64` | `aarch64` | `null`. Nullable: Yes. Required: No.

**memory**  
Memory in MiB. Default: `jobs.toml`'s, else 1024.  
Type: Integer. Range: 16 to 1048576. Nullable: Yes. Required: No.

**timeout**  
Timeout in seconds. Default: `jobs.toml`'s.  
Type: Integer. Range: 1 to 86400. Nullable: Yes. Required: No.

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
Which try this is, from 1.  
Type: Integer. Range: 1 to any. Required: Yes.

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
Claimed at (ISO 8601).  
Type: String. Nullable: Yes. Required: Yes.

**endedAt**  
Ended at (ISO 8601).  
Type: String. Nullable: Yes. Required: Yes.

**leaseExpiresAt**  
Fails at this time unless its host's heartbeat renews it.  
Type: String. Nullable: Yes. Required: Yes.

