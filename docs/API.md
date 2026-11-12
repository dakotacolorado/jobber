# job-service

> Version 0.1.0

A job is a named script in a repo's `jobs.toml`; a run is one execution of it, to completion at one commit, by a runner that claims it. A run is submitted `pending`, claimed and `running`, and ends `succeeded`, `failed` or `canceled` with its exit code, and says what it was for when its submitter said. Its log can be read from any offset while it runs and after.


## Path Table

| Method | Path | Description |
| --- | --- | --- |
| GET | [/health](#gethealth) | Liveness check |
| GET | [/skill](#getskill) | Read the client workers call this deployment with |
| POST | [/runs](#postruns) | Submit a run of a job: a named script in a repo at a commit |
| GET | [/runs](#getruns) | List runs, newest first |
| GET | [/runs/{id}](#getrunsid) | Read one run |
| PUT | [/runs/{id}](#putrunsid) | Report how a run in progress ended |
| GET | [/runs/{id}/log](#getrunsidlog) | Read a run's log from a byte offset |
| PATCH | [/runs/{id}/log](#patchrunsidlog) | Append to the log of a run in progress, and renew its lease |
| POST | [/runs/{id}/cancel](#postrunsidcancel) | Cancel a run |
| POST | [/runners](#postrunners) | Register a runner |
| GET | [/runners](#getrunners) | List runners, most recently seen first |
| POST | [/runners/{id}/claim](#postrunnersidclaim) | Claim the oldest pending run that fits |
| PUT | [/runs/{id}/runs-with](#putrunsidruns-with) | Say what a run in progress runs with |

## Reference Table

| Name | Path | Description |
| --- | --- | --- |
| bearerAuth | [#/components/securitySchemes/bearerAuth](#componentssecurityschemesbearerauth) |  |
| runnerAuth | [#/components/securitySchemes/runnerAuth](#componentssecurityschemesrunnerauth) | A runner's own token, `<runner id>.<secret>`, as `registerRunner` answered it. |
| Skill | [#/components/schemas/Skill](#componentsschemasskill) |  |
| Error | [#/components/schemas/Error](#componentsschemaserror) |  |
| Run | [#/components/schemas/Run](#componentsschemasrun) |  |
| Routine | [#/components/schemas/Routine](#componentsschemasroutine) | Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are. |
| Limits | [#/components/schemas/Limits](#componentsschemaslimits) |  |
| For | [#/components/schemas/For](#componentsschemasfor) | What it was for; null when its submitter did not say. |
| RunsWith | [#/components/schemas/RunsWith](#componentsschemasrunswith) | What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say. |
| Submit | [#/components/schemas/Submit](#componentsschemassubmit) |  |
| Registered | [#/components/schemas/Registered](#componentsschemasregistered) |  |
| Runner | [#/components/schemas/Runner](#componentsschemasrunner) |  |
| Register | [#/components/schemas/Register](#componentsschemasregister) |  |
| Claim | [#/components/schemas/Claim](#componentsschemasclaim) |  |
| ClaimRequest | [#/components/schemas/ClaimRequest](#componentsschemasclaimrequest) |  |
| Appended | [#/components/schemas/Appended](#componentsschemasappended) |  |
| Report | [#/components/schemas/Report](#componentsschemasreport) |  |

## Path Details

***

### [GET]/health

- Summary  
  Liveness check

- Operation id  
  healthCheck

- Tags  
  meta

#### Responses

- 200 Service is up.

`application/json`

```typescript
{
  ok: enum[true]
  // The package's version.
  version: string
  // The commit it was built from, ending `-dirty` when built with uncommitted changes.
  commit: string
}
```

***

### [GET]/skill

- Summary  
  Read the client workers call this deployment with

- Operation id  
  getSkill

- Description  
  The jobs skill's `bin/` and `reference/`, as this deployment was built with them, so a worker calls the API that is deployed.

- Tags  
  meta

- Security  
  bearerAuth

#### Responses

- 200 The skill's files.

`application/json`

```typescript
{
  // The skill's name, which its files are under.
  key: string
  // The deployed tree's commit count, 0 when deployed from outside git.
  version: integer
  // The deployed commit, ending `-dirty` when deployed with uncommitted changes.
  commit: string
  files: {
    // Under the worker's Claude Code folder: `skills/jobs/bin/…` or `skills/jobs/reference/…`.
    path: string
    content: string
    executable: boolean
  }[]
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/runs

- Summary  
  Submit a run of a job: a named script in a repo at a commit

- Operation id  
  submitRun

- Description  
  One run, stored `pending` until a runner whose labels and free memory fit claims it, with what it was for when `for` says. Nothing is checked against the repo here: a run of a job missing from `jobs.toml` at that commit fails on its runner, saying so in its log.

- Tags  
  runs

- Security  
  bearerAuth

#### Headers

```typescript
// Who is submitting: recorded on the run as `submittedBy`.
// Who is submitting: recorded on the run as `submittedBy`.
claimed-by?: string //minLength: 1 //maxLength: 200
```

#### RequestBody

What to run, and where it may run.

- application/json

```typescript
{
  // `owner/name` on GitHub.
  repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
  // The commit to run, as a full lowercase sha: the runner checks out exactly this.
  commit: string //pattern: ^[0-9a-f]{40}$
  // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
  job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
  args?: string[] //maxLength: 4000 //maxItems: 50
  limits: {
    // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
    memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
    // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
    timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
  }
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  for?: #/components/schemas/For & 
  routine?: #/components/schemas/Routine & 
  // The machine it must run on, as a runner's `hostId`: claimed only by that machine's runner, and only one that says it `can` run `host` runs, which runs it on the host itself, with the host's user services, if that host's config lets it. Null: any runner that fits.
  host?: string | null //minLength: 1 //maxLength: 200 //default: null
}
```

#### Responses

- 201 Stored, `pending`.

`application/json`

```typescript
{
  id: string //format: uuid
  // `owner/name` on GitHub: checked out at `/work`; with a routine, its target.
  repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
  // The commit to run, as a full lowercase sha: the runner checks out exactly this.
  commit: string //pattern: ^[0-9a-f]{40}$
  // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
  job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
  // Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
  routine: {
    // `owner/name` on GitHub: the repo the routine is in.
    repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
    // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
    commit: string //pattern: ^[0-9a-f]{40}$
    // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
    dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
  }
  // The machine it must run on, on the host itself; null: any runner that fits.
  host: string | null
  args: string[]
  limits: {
    // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
    memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
    // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
    timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
  }
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  // What it was for; null when its submitter did not say.
  for: {
    // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
    kind: enum[batch, change, item, worker]
    // Its id there, without spaces.
    id: string //pattern: ^\S{1,200}$
  }
  // `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
  state: enum[pending, running, succeeded, failed, canceled]
  // Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.
  reason: string | null
  // A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.
  cancelRequested: boolean
  // The runner that claimed it; null while pending.
  runner: string | null //format: uuid
  // What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
  runsWith: {
    // MiB the container may use.
    memory: integer //minimum: 1 //maximum: 1048576
    // Seconds before the runner stops it and it fails.
    timeout: integer //minimum: 1 //maximum: 86400
    // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
    stall: integer | null //minimum: 1 //maximum: 86400
  }
  // The run's exit code, once its runner reports one.
  exit: integer | null
  // Seconds it ran, as its runner reported.
  duration: number | null
  // Bytes of log stored so far.
  logSize: integer
  // The `claimed-by` it was submitted with.
  submittedBy: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
  // While running: if no log append renews it by then, the run fails.
  leaseExpiresAt: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/runs

- Summary  
  List runs, newest first

- Operation id  
  listRuns

- Tags  
  runs

- Security  
  bearerAuth

#### Parameters(Query)

```typescript
// `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
// `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
state?: enum[pending, running, succeeded, failed, canceled]
```

```typescript
// `owner/name` on GitHub.
// `owner/name` on GitHub.
repo?: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
```

```typescript
// Only the runs submitted with this `claimed-by`, as `submittedBy` records it.
// Only the runs submitted with this `claimed-by`, as `submittedBy` records it.
submittedBy?: string //minLength: 1 //maxLength: 200
```

```typescript
// `<kind>:<id>`, e.g. `item:28af81bc-…`: only the runs submitted with that `for`.
// `<kind>:<id>`, e.g. `item:28af81bc-…`: only the runs submitted with that `for`.
for?: string
```

```typescript
// At most this many, newest first.
// At most this many, newest first.
limit?: integer //minimum: 1 //maximum: 500 //default: 100
```

#### Responses

- 200 The runs.

`application/json`

```typescript
{
  runs: {
    id: string //format: uuid
    // `owner/name` on GitHub: checked out at `/work`; with a routine, its target.
    repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
    // The commit to run, as a full lowercase sha: the runner checks out exactly this.
    commit: string //pattern: ^[0-9a-f]{40}$
    // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
    job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
    // Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
    routine: {
      // `owner/name` on GitHub: the repo the routine is in.
      repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
      // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
      commit: string //pattern: ^[0-9a-f]{40}$
      // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
      dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
    }
    // The machine it must run on, on the host itself; null: any runner that fits.
    host: string | null
    args: string[]
    limits: {
      // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
      memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
      // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
      timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
    }
    // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
    labels: {
      [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
    }
    // What it was for; null when its submitter did not say.
    for: {
      // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
      kind: enum[batch, change, item, worker]
      // Its id there, without spaces.
      id: string //pattern: ^\S{1,200}$
    }
    // `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
    state: enum[pending, running, succeeded, failed, canceled]
    // Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.
    reason: string | null
    // A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.
    cancelRequested: boolean
    // The runner that claimed it; null while pending.
    runner: string | null //format: uuid
    // What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
    runsWith: {
      // MiB the container may use.
      memory: integer //minimum: 1 //maximum: 1048576
      // Seconds before the runner stops it and it fails.
      timeout: integer //minimum: 1 //maximum: 86400
      // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
      stall: integer | null //minimum: 1 //maximum: 86400
    }
    // The run's exit code, once its runner reports one.
    exit: integer | null
    // Seconds it ran, as its runner reported.
    duration: number | null
    // Bytes of log stored so far.
    logSize: integer
    // The `claimed-by` it was submitted with.
    submittedBy: string | null
    createdAt: string
    updatedAt: string
    startedAt: string | null
    endedAt: string | null
    // While running: if no log append renews it by then, the run fails.
    leaseExpiresAt: string | null
  }[]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/runs/{id}

- Summary  
  Read one run

- Operation id  
  getRun

- Tags  
  runs

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
id: string //format: uuid
```

#### Responses

- 200 The run.

`application/json`

```typescript
{
  id: string //format: uuid
  // `owner/name` on GitHub: checked out at `/work`; with a routine, its target.
  repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
  // The commit to run, as a full lowercase sha: the runner checks out exactly this.
  commit: string //pattern: ^[0-9a-f]{40}$
  // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
  job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
  // Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
  routine: {
    // `owner/name` on GitHub: the repo the routine is in.
    repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
    // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
    commit: string //pattern: ^[0-9a-f]{40}$
    // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
    dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
  }
  // The machine it must run on, on the host itself; null: any runner that fits.
  host: string | null
  args: string[]
  limits: {
    // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
    memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
    // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
    timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
  }
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  // What it was for; null when its submitter did not say.
  for: {
    // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
    kind: enum[batch, change, item, worker]
    // Its id there, without spaces.
    id: string //pattern: ^\S{1,200}$
  }
  // `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
  state: enum[pending, running, succeeded, failed, canceled]
  // Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.
  reason: string | null
  // A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.
  cancelRequested: boolean
  // The runner that claimed it; null while pending.
  runner: string | null //format: uuid
  // What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
  runsWith: {
    // MiB the container may use.
    memory: integer //minimum: 1 //maximum: 1048576
    // Seconds before the runner stops it and it fails.
    timeout: integer //minimum: 1 //maximum: 86400
    // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
    stall: integer | null //minimum: 1 //maximum: 86400
  }
  // The run's exit code, once its runner reports one.
  exit: integer | null
  // Seconds it ran, as its runner reported.
  duration: number | null
  // Bytes of log stored so far.
  logSize: integer
  // The `claimed-by` it was submitted with.
  submittedBy: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
  // While running: if no log append renews it by then, the run fails.
  leaseExpiresAt: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No run with that id.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [PUT]/runs/{id}

- Summary  
  Report how a run in progress ended

- Operation id  
  reportRun

- Description  
  From the run's own runner. Sending the same end again answers it unchanged, so a lost reply can be retried.

- Tags  
  runners

- Security  
  runnerAuth

#### Parameters(Path)

```typescript
id: string //format: uuid
```

#### RequestBody

How it ended.

- application/json

```typescript
{
  // `canceled` when stopped for a cancel; `failed` for a non-zero exit, a timeout, or an image that would not build.
  state: enum[succeeded, failed, canceled]
  // The run's exit code; null when it never ran or was killed.
  exit: integer | null
  // Seconds from claim to end.
  duration: number //minimum: 0
  // Why, when the state does not say: `timed out after 600s`, `image build failed`.
  reason?: string | null //minLength: 1 //maxLength: 2000 //default: null
}
```

#### Responses

- 200 The run, ended.

`application/json`

```typescript
{
  id: string //format: uuid
  // `owner/name` on GitHub: checked out at `/work`; with a routine, its target.
  repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
  // The commit to run, as a full lowercase sha: the runner checks out exactly this.
  commit: string //pattern: ^[0-9a-f]{40}$
  // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
  job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
  // Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
  routine: {
    // `owner/name` on GitHub: the repo the routine is in.
    repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
    // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
    commit: string //pattern: ^[0-9a-f]{40}$
    // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
    dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
  }
  // The machine it must run on, on the host itself; null: any runner that fits.
  host: string | null
  args: string[]
  limits: {
    // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
    memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
    // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
    timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
  }
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  // What it was for; null when its submitter did not say.
  for: {
    // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
    kind: enum[batch, change, item, worker]
    // Its id there, without spaces.
    id: string //pattern: ^\S{1,200}$
  }
  // `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
  state: enum[pending, running, succeeded, failed, canceled]
  // Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.
  reason: string | null
  // A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.
  cancelRequested: boolean
  // The runner that claimed it; null while pending.
  runner: string | null //format: uuid
  // What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
  runsWith: {
    // MiB the container may use.
    memory: integer //minimum: 1 //maximum: 1048576
    // Seconds before the runner stops it and it fails.
    timeout: integer //minimum: 1 //maximum: 86400
    // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
    stall: integer | null //minimum: 1 //maximum: 86400
  }
  // The run's exit code, once its runner reports one.
  exit: integer | null
  // Seconds it ran, as its runner reported.
  duration: number | null
  // Bytes of log stored so far.
  logSize: integer
  // The `claimed-by` it was submitted with.
  submittedBy: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
  // While running: if no log append renews it by then, the run fails.
  leaseExpiresAt: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Not a runner's token.

`application/json`

```typescript
{
  error: string
}
```

- 403 Another runner's run.

`application/json`

```typescript
{
  error: string
}
```

- 404 No run with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 It is not running, or ended otherwise.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/runs/{id}/log

- Summary  
  Read a run's log from a byte offset

- Operation id  
  getRunLog

- Description  
  Send `Range: bytes=N-` to read from offset N; without it, from 0. Answers 206 with `Content-Range: bytes N-M/size` and at most 1 MiB, or an empty body when N is the log's size, so a follower polls from where it got to. `Run-State` says the run's state, so it knows when to stop.

- Tags  
  runs

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
id: string //format: uuid
```

#### Headers

```typescript
// `bytes=N-`
// `bytes=N-`
range?: string //pattern: ^bytes=\d+-$
```

#### Responses

- 206 The log from N, up to 1 MiB.

`text/plain`

```typescript
string
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No run with that id.

`application/json`

```typescript
{
  error: string
}
```

- 416 N is past the end of the log.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [PATCH]/runs/{id}/log

- Summary  
  Append to the log of a run in progress, and renew its lease

- Operation id  
  appendRunLog

- Description  
  The body is the bytes, `Content-Range: bytes S-E/*` where S is the log's current size and E = S + length - 1. An empty body without `Content-Range` only renews the lease. 416 for any other S, with the size to resend from. At most 256 KiB per append and 64 MiB per run (413). The reply says whether a cancel was asked for.

- Tags  
  runners

- Security  
  runnerAuth

#### Parameters(Path)

```typescript
id: string //format: uuid
```

#### Headers

```typescript
// `bytes S-E/*`
// `bytes S-E/*`
content-range?: string //pattern: ^bytes \d+-\d+\/(\*|\d+)$
```

#### RequestBody

The log's next bytes.

- application/octet-stream

```typescript
string //format: binary
```

#### Responses

- 200 Stored, and the lease renewed.

`application/json`

```typescript
{
  // Bytes of log stored: the offset the next append starts at.
  size: integer
  // A cancel was asked for: stop the run and report it `canceled`.
  canceled: boolean
  leaseExpiresAt: string
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Not a runner's token.

`application/json`

```typescript
{
  error: string
}
```

- 403 Another runner's run.

`application/json`

```typescript
{
  error: string
}
```

- 404 No run with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 The run is not running: it ended, perhaps by its lease lapsing.

`application/json`

```typescript
{
  error: string
}
```

- 413 Over 256 KiB, or the log would pass 64 MiB.

`application/json`

```typescript
{
  error: string
}
```

- 416 Not at the log's end: resend from `size`.

`application/json`

```typescript
{
  error: string
  size: integer
}
```

***

### [POST]/runs/{id}/cancel

- Summary  
  Cancel a run

- Operation id  
  cancelRun

- Description  
  A pending run ends `canceled` at once. A running one is marked `cancelRequested`: its runner is told on its next log append, stops it, and reports it `canceled`.

- Tags  
  runs

- Security  
  bearerAuth

#### Parameters(Path)

```typescript
id: string //format: uuid
```

#### Responses

- 200 The run, canceled or marked.

`application/json`

```typescript
{
  id: string //format: uuid
  // `owner/name` on GitHub: checked out at `/work`; with a routine, its target.
  repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
  // The commit to run, as a full lowercase sha: the runner checks out exactly this.
  commit: string //pattern: ^[0-9a-f]{40}$
  // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
  job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
  // Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
  routine: {
    // `owner/name` on GitHub: the repo the routine is in.
    repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
    // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
    commit: string //pattern: ^[0-9a-f]{40}$
    // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
    dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
  }
  // The machine it must run on, on the host itself; null: any runner that fits.
  host: string | null
  args: string[]
  limits: {
    // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
    memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
    // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
    timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
  }
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  // What it was for; null when its submitter did not say.
  for: {
    // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
    kind: enum[batch, change, item, worker]
    // Its id there, without spaces.
    id: string //pattern: ^\S{1,200}$
  }
  // `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
  state: enum[pending, running, succeeded, failed, canceled]
  // Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.
  reason: string | null
  // A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.
  cancelRequested: boolean
  // The runner that claimed it; null while pending.
  runner: string | null //format: uuid
  // What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
  runsWith: {
    // MiB the container may use.
    memory: integer //minimum: 1 //maximum: 1048576
    // Seconds before the runner stops it and it fails.
    timeout: integer //minimum: 1 //maximum: 86400
    // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
    stall: integer | null //minimum: 1 //maximum: 86400
  }
  // The run's exit code, once its runner reports one.
  exit: integer | null
  // Seconds it ran, as its runner reported.
  duration: number | null
  // Bytes of log stored so far.
  logSize: integer
  // The `claimed-by` it was submitted with.
  submittedBy: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
  // While running: if no log append renews it by then, the run fails.
  leaseExpiresAt: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 404 No run with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 It has already ended.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/runners

- Summary  
  Register a runner

- Operation id  
  registerRunner

- Description  
  With the registration token, not the submitters'. Answers the runner's own token once.

- Tags  
  runners

- Security  
  bearerAuth

#### RequestBody

What the runner is and has.

- application/json

```typescript
{
  name: string //minLength: 1 //maxLength: 200
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  slots: integer //minimum: 1 //maximum: 64
  // MiB.
  memory: integer //minimum: 16 //maximum: 1048576
  version?: string | null //maxLength: 100 //default: null
  // The machine it runs on: its worker-host's `host_id`, by default the hostname.
  hostId?: string | null //minLength: 1 //maxLength: 200 //default: null
}
```

#### Responses

- 201 Registered.

`application/json`

```typescript
{
  runner: {
    id: string //format: uuid
    // What it calls itself, e.g. its host's name: not unique.
    name: string
    // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
    labels: {
      [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
    }
    // Runs it runs at once.
    slots: integer
    // MiB it has for runs and their image builds.
    memory: integer
    // job-runner's version, as it said.
    version: string | null
    // The machine it runs on, the same as that machine's worker-host's `host_id` (by default its hostname); null until it says.
    hostId: string | null
    createdAt: string
    // Its last claim.
    lastSeenAt: string
  }
  // Its own bearer token, `<runner id>.<secret>`, shown only here: keep it where only the runner's user can read it.
  token: string
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [GET]/runners

- Summary  
  List runners, most recently seen first

- Operation id  
  listRunners

- Tags  
  runners

- Security  
  bearerAuth

#### Responses

- 200 The runners.

`application/json`

```typescript
{
  runners: {
    id: string //format: uuid
    // What it calls itself, e.g. its host's name: not unique.
    name: string
    // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
    labels: {
      [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
    }
    // Runs it runs at once.
    slots: integer
    // MiB it has for runs and their image builds.
    memory: integer
    // job-runner's version, as it said.
    version: string | null
    // The machine it runs on, the same as that machine's worker-host's `host_id` (by default its hostname); null until it says.
    hostId: string | null
    createdAt: string
    // Its last claim.
    lastSeenAt: string
  }[]
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Missing or incorrect bearer token.

`application/json`

```typescript
{
  error: string
}
```

- 503 No API token is configured.

`application/json`

```typescript
{
  error: string
}
```

***

### [POST]/runners/{id}/claim

- Summary  
  Claim the oldest pending run that fits

- Operation id  
  claimRun

- Description  
  The oldest pending run whose labels the runner has, whose memory fits `free`, whose routine or host, if any, it `can` run, and whose `host`, if any, is the runner's own `hostId`, moved to `running` on this runner. Two claims never get the same run. 204 when none fits.

- Tags  
  runners

- Security  
  runnerAuth

#### Parameters(Path)

```typescript
id: string //format: uuid
```

#### RequestBody

What the runner can take on.

- application/json

```typescript
{
  // What it has now; its registered labels when absent.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  can?: enum[routine, host][] //maxItems: 10
  // The machine it runs on now, recorded on the runner, so one registered before it said keeps its id.
  hostId?: string //minLength: 1 //maxLength: 200
  // What it can take on now.
  free: {
    // Slots not taken by a run.
    slots: integer //minimum: 0
    // MiB not reserved by a run in progress or an image build.
    memory: integer //minimum: 0
  }
}
```

#### Responses

- 200 A run, now running here.

`application/json`

```typescript
{
  run: {
    id: string //format: uuid
    // `owner/name` on GitHub: checked out at `/work`; with a routine, its target.
    repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
    // The commit to run, as a full lowercase sha: the runner checks out exactly this.
    commit: string //pattern: ^[0-9a-f]{40}$
    // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
    job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
    // Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
    routine: {
      // `owner/name` on GitHub: the repo the routine is in.
      repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
      // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
      commit: string //pattern: ^[0-9a-f]{40}$
      // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
      dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
    }
    // The machine it must run on, on the host itself; null: any runner that fits.
    host: string | null
    args: string[]
    limits: {
      // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
      memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
      // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
      timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
    }
    // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
    labels: {
      [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
    }
    // What it was for; null when its submitter did not say.
    for: {
      // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
      kind: enum[batch, change, item, worker]
      // Its id there, without spaces.
      id: string //pattern: ^\S{1,200}$
    }
    // `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
    state: enum[pending, running, succeeded, failed, canceled]
    // Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.
    reason: string | null
    // A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.
    cancelRequested: boolean
    // The runner that claimed it; null while pending.
    runner: string | null //format: uuid
    // What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
    runsWith: {
      // MiB the container may use.
      memory: integer //minimum: 1 //maximum: 1048576
      // Seconds before the runner stops it and it fails.
      timeout: integer //minimum: 1 //maximum: 86400
      // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
      stall: integer | null //minimum: 1 //maximum: 86400
    }
    // The run's exit code, once its runner reports one.
    exit: integer | null
    // Seconds it ran, as its runner reported.
    duration: number | null
    // Bytes of log stored so far.
    logSize: integer
    // The `claimed-by` it was submitted with.
    submittedBy: string | null
    createdAt: string
    updatedAt: string
    startedAt: string | null
    endedAt: string | null
    // While running: if no log append renews it by then, the run fails.
    leaseExpiresAt: string | null
  }
  // MiB the run was admitted with: reserve this, and run it with no more.
  memory: integer
  // Seconds the run lives without a log append. Append, or renew with an empty one, well within it.
  lease: integer
}
```

- 204 No pending run fits.

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Not a runner's token.

`application/json`

```typescript
{
  error: string
}
```

- 403 Another runner's run.

`application/json`

```typescript
{
  error: string
}
```

***

### [PUT]/runs/{id}/runs-with

- Summary  
  Say what a run in progress runs with

- Operation id  
  setRunsWith

- Description  
  From the run's own runner, once it has read `jobs.toml` and before it starts the run's container. Sending it again replaces it.

- Tags  
  runners

- Security  
  runnerAuth

#### Parameters(Path)

```typescript
id: string //format: uuid
```

#### RequestBody

Its memory, timeout and stall limit.

- application/json

```typescript
// What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
{
  // MiB the container may use.
  memory: integer //minimum: 1 //maximum: 1048576
  // Seconds before the runner stops it and it fails.
  timeout: integer //minimum: 1 //maximum: 86400
  // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
  stall: integer | null //minimum: 1 //maximum: 86400
}
```

#### Responses

- 200 The run, with `runsWith`.

`application/json`

```typescript
{
  id: string //format: uuid
  // `owner/name` on GitHub: checked out at `/work`; with a routine, its target.
  repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
  // The commit to run, as a full lowercase sha: the runner checks out exactly this.
  commit: string //pattern: ^[0-9a-f]{40}$
  // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
  job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
  // Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
  routine: {
    // `owner/name` on GitHub: the repo the routine is in.
    repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
    // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
    commit: string //pattern: ^[0-9a-f]{40}$
    // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
    dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
  }
  // The machine it must run on, on the host itself; null: any runner that fits.
  host: string | null
  args: string[]
  limits: {
    // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
    memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
    // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
    timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
  }
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  // What it was for; null when its submitter did not say.
  for: {
    // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
    kind: enum[batch, change, item, worker]
    // Its id there, without spaces.
    id: string //pattern: ^\S{1,200}$
  }
  // `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
  state: enum[pending, running, succeeded, failed, canceled]
  // Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.
  reason: string | null
  // A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.
  cancelRequested: boolean
  // The runner that claimed it; null while pending.
  runner: string | null //format: uuid
  // What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
  runsWith: {
    // MiB the container may use.
    memory: integer //minimum: 1 //maximum: 1048576
    // Seconds before the runner stops it and it fails.
    timeout: integer //minimum: 1 //maximum: 86400
    // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
    stall: integer | null //minimum: 1 //maximum: 86400
  }
  // The run's exit code, once its runner reports one.
  exit: integer | null
  // Seconds it ran, as its runner reported.
  duration: number | null
  // Bytes of log stored so far.
  logSize: integer
  // The `claimed-by` it was submitted with.
  submittedBy: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
  // While running: if no log append renews it by then, the run fails.
  leaseExpiresAt: string | null
}
```

- 400 The request failed validation.

`application/json`

```typescript
{
  error: string
}
```

- 401 Not a runner's token.

`application/json`

```typescript
{
  error: string
}
```

- 403 Another runner's run.

`application/json`

```typescript
{
  error: string
}
```

- 404 No run with that id.

`application/json`

```typescript
{
  error: string
}
```

- 409 It is not running.

`application/json`

```typescript
{
  error: string
}
```

## References

### #/components/securitySchemes/bearerAuth

- Type: http
- Scheme: bearer

### #/components/securitySchemes/runnerAuth

- Type: http
- Scheme: bearer

A runner's own token, `<runner id>.<secret>`, as `registerRunner` answered it.

### #/components/schemas/Skill

```typescript
{
  // The skill's name, which its files are under.
  key: string
  // The deployed tree's commit count, 0 when deployed from outside git.
  version: integer
  // The deployed commit, ending `-dirty` when deployed with uncommitted changes.
  commit: string
  files: {
    // Under the worker's Claude Code folder: `skills/jobs/bin/…` or `skills/jobs/reference/…`.
    path: string
    content: string
    executable: boolean
  }[]
}
```

### #/components/schemas/Error

```typescript
{
  error: string
}
```

### #/components/schemas/Run

```typescript
{
  id: string //format: uuid
  // `owner/name` on GitHub: checked out at `/work`; with a routine, its target.
  repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
  // The commit to run, as a full lowercase sha: the runner checks out exactly this.
  commit: string //pattern: ^[0-9a-f]{40}$
  // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
  job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
  // Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
  routine: {
    // `owner/name` on GitHub: the repo the routine is in.
    repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
    // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
    commit: string //pattern: ^[0-9a-f]{40}$
    // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
    dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
  }
  // The machine it must run on, on the host itself; null: any runner that fits.
  host: string | null
  args: string[]
  limits: {
    // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
    memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
    // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
    timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
  }
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  // What it was for; null when its submitter did not say.
  for: {
    // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
    kind: enum[batch, change, item, worker]
    // Its id there, without spaces.
    id: string //pattern: ^\S{1,200}$
  }
  // `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
  state: enum[pending, running, succeeded, failed, canceled]
  // Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.
  reason: string | null
  // A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.
  cancelRequested: boolean
  // The runner that claimed it; null while pending.
  runner: string | null //format: uuid
  // What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
  runsWith: {
    // MiB the container may use.
    memory: integer //minimum: 1 //maximum: 1048576
    // Seconds before the runner stops it and it fails.
    timeout: integer //minimum: 1 //maximum: 86400
    // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
    stall: integer | null //minimum: 1 //maximum: 86400
  }
  // The run's exit code, once its runner reports one.
  exit: integer | null
  // Seconds it ran, as its runner reported.
  duration: number | null
  // Bytes of log stored so far.
  logSize: integer
  // The `claimed-by` it was submitted with.
  submittedBy: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  endedAt: string | null
  // While running: if no log append renews it by then, the run fails.
  leaseExpiresAt: string | null
}
```

### #/components/schemas/Routine

```typescript
// Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
{
  // `owner/name` on GitHub: the repo the routine is in.
  repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
  // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
  commit: string //pattern: ^[0-9a-f]{40}$
  // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
  dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
}
```

### #/components/schemas/Limits

```typescript
{
  // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
  memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
  // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
  timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
}
```

### #/components/schemas/For

```typescript
// What it was for; null when its submitter did not say.
{
  // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
  kind: enum[batch, change, item, worker]
  // Its id there, without spaces.
  id: string //pattern: ^\S{1,200}$
}
```

### #/components/schemas/RunsWith

```typescript
// What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
{
  // MiB the container may use.
  memory: integer //minimum: 1 //maximum: 1048576
  // Seconds before the runner stops it and it fails.
  timeout: integer //minimum: 1 //maximum: 86400
  // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
  stall: integer | null //minimum: 1 //maximum: 86400
}
```

### #/components/schemas/Submit

```typescript
{
  // `owner/name` on GitHub.
  repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
  // The commit to run, as a full lowercase sha: the runner checks out exactly this.
  commit: string //pattern: ^[0-9a-f]{40}$
  // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
  job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
  args?: string[] //maxLength: 4000 //maxItems: 50
  limits: {
    // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
    memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
    // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
    timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
  }
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  for?: #/components/schemas/For & 
  routine?: #/components/schemas/Routine & 
  // The machine it must run on, as a runner's `hostId`: claimed only by that machine's runner, and only one that says it `can` run `host` runs, which runs it on the host itself, with the host's user services, if that host's config lets it. Null: any runner that fits.
  host?: string | null //minLength: 1 //maxLength: 200 //default: null
}
```

### #/components/schemas/Registered

```typescript
{
  runner: {
    id: string //format: uuid
    // What it calls itself, e.g. its host's name: not unique.
    name: string
    // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
    labels: {
      [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
    }
    // Runs it runs at once.
    slots: integer
    // MiB it has for runs and their image builds.
    memory: integer
    // job-runner's version, as it said.
    version: string | null
    // The machine it runs on, the same as that machine's worker-host's `host_id` (by default its hostname); null until it says.
    hostId: string | null
    createdAt: string
    // Its last claim.
    lastSeenAt: string
  }
  // Its own bearer token, `<runner id>.<secret>`, shown only here: keep it where only the runner's user can read it.
  token: string
}
```

### #/components/schemas/Runner

```typescript
{
  id: string //format: uuid
  // What it calls itself, e.g. its host's name: not unique.
  name: string
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  // Runs it runs at once.
  slots: integer
  // MiB it has for runs and their image builds.
  memory: integer
  // job-runner's version, as it said.
  version: string | null
  // The machine it runs on, the same as that machine's worker-host's `host_id` (by default its hostname); null until it says.
  hostId: string | null
  createdAt: string
  // Its last claim.
  lastSeenAt: string
}
```

### #/components/schemas/Register

```typescript
{
  name: string //minLength: 1 //maxLength: 200
  // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  slots: integer //minimum: 1 //maximum: 64
  // MiB.
  memory: integer //minimum: 16 //maximum: 1048576
  version?: string | null //maxLength: 100 //default: null
  // The machine it runs on: its worker-host's `host_id`, by default the hostname.
  hostId?: string | null //minLength: 1 //maxLength: 200 //default: null
}
```

### #/components/schemas/Claim

```typescript
{
  run: {
    id: string //format: uuid
    // `owner/name` on GitHub: checked out at `/work`; with a routine, its target.
    repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
    // The commit to run, as a full lowercase sha: the runner checks out exactly this.
    commit: string //pattern: ^[0-9a-f]{40}$
    // A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.
    job: string //pattern: ^[a-z0-9][a-z0-9_-]{0,62}$
    // Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are.
    routine: {
      // `owner/name` on GitHub: the repo the routine is in.
      repo: string //maxLength: 200 //pattern: ^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$
      // The routine repo's commit, as a full lowercase sha: the runner checks out exactly this.
      commit: string //pattern: ^[0-9a-f]{40}$
      // The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.
      dir: string //maxLength: 200 //pattern: ^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$
    }
    // The machine it must run on, on the host itself; null: any runner that fits.
    host: string | null
    args: string[]
    limits: {
      // MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with.
      memory?: integer | null //minimum: 16 //maximum: 1048576 //default: null
      // Seconds before the runner stops it and it fails. Null: `jobs.toml`'s.
      timeout?: integer | null //minimum: 1 //maximum: 86400 //default: null
    }
    // Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.
    labels: {
      [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
    }
    // What it was for; null when its submitter did not say.
    for: {
      // What asked for the run: an approval-service batch or change, a work-tracker item, or a worker.
      kind: enum[batch, change, item, worker]
      // Its id there, without spaces.
      id: string //pattern: ^\S{1,200}$
    }
    // `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.
    state: enum[pending, running, succeeded, failed, canceled]
    // Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout.
    reason: string | null
    // A cancel was asked for: the runner of a run in progress is told to stop it on its next log append.
    cancelRequested: boolean
    // The runner that claimed it; null while pending.
    runner: string | null //format: uuid
    // What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.
    runsWith: {
      // MiB the container may use.
      memory: integer //minimum: 1 //maximum: 1048576
      // Seconds before the runner stops it and it fails.
      timeout: integer //minimum: 1 //maximum: 86400
      // Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does.
      stall: integer | null //minimum: 1 //maximum: 86400
    }
    // The run's exit code, once its runner reports one.
    exit: integer | null
    // Seconds it ran, as its runner reported.
    duration: number | null
    // Bytes of log stored so far.
    logSize: integer
    // The `claimed-by` it was submitted with.
    submittedBy: string | null
    createdAt: string
    updatedAt: string
    startedAt: string | null
    endedAt: string | null
    // While running: if no log append renews it by then, the run fails.
    leaseExpiresAt: string | null
  }
  // MiB the run was admitted with: reserve this, and run it with no more.
  memory: integer
  // Seconds the run lives without a log append. Append, or renew with an empty one, well within it.
  lease: integer
}
```

### #/components/schemas/ClaimRequest

```typescript
{
  // What it has now; its registered labels when absent.
  labels: {
    [key: string]: string //pattern: ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$
  }
  can?: enum[routine, host][] //maxItems: 10
  // The machine it runs on now, recorded on the runner, so one registered before it said keeps its id.
  hostId?: string //minLength: 1 //maxLength: 200
  // What it can take on now.
  free: {
    // Slots not taken by a run.
    slots: integer //minimum: 0
    // MiB not reserved by a run in progress or an image build.
    memory: integer //minimum: 0
  }
}
```

### #/components/schemas/Appended

```typescript
{
  // Bytes of log stored: the offset the next append starts at.
  size: integer
  // A cancel was asked for: stop the run and report it `canceled`.
  canceled: boolean
  leaseExpiresAt: string
}
```

### #/components/schemas/Report

```typescript
{
  // `canceled` when stopped for a cancel; `failed` for a non-zero exit, a timeout, or an image that would not build.
  state: enum[succeeded, failed, canceled]
  // The run's exit code; null when it never ran or was killed.
  exit: integer | null
  // Seconds from claim to end.
  duration: number //minimum: 0
  // Why, when the state does not say: `timed out after 600s`, `image build failed`.
  reason?: string | null //minLength: 1 //maxLength: 2000 //default: null
}
```