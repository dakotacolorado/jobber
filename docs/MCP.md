# job-service's MCP server

<!-- Generated from src/mcp.ts by `npm run spec`; do not edit. -->

Streamable HTTP at `/mcp`, stateless, answering JSON. Every request takes the submitters' bearer token (`AUTH_TOKEN`), as the API does, and may send `claimed-by`: each tool is one API request made with them, so it is refused, recorded and answered as that request would be. A refusal comes back as the tool's error, in the API's words.

```json
{
  "mcpServers": {
    "job-service": {
      "type": "http",
      "url": "http://127.0.0.1:4500/mcp",
      "headers": {
        "Authorization": "Bearer <AUTH_TOKEN>"
      }
    }
  }
}
```

## Instructions

What the server tells an agent when it connects:

> job-service runs jobs: a job is a named script in a repo's jobs.toml, a run one execution of it at one commit, claimed by a runner whose labels and free memory fit.
>
> - A run is submitted pending, claimed and running, and ends succeeded, failed or canceled with its exit code.
> - A run's log is read from a byte offset: get_run_log answers the bytes from offset, the log's size, and the run's state, so call it again from offset + the bytes read until the state has ended.
> - cancel_run ends a pending run at once; a running one is canceled by its runner shortly after.
> - Every tool takes the submitters' token this server was connected with. Registering runners and their claims and reports are the runner protocol, not tools.

## Tools

| Tool | Does | Reads only |
| --- | --- | --- |
| [`submit_run`](#submit_run) | Submit a run |  |
| [`list_runs`](#list_runs) | List runs | yes |
| [`get_run`](#get_run) | Get a run | yes |
| [`get_run_log`](#get_run_log) | Read a run's log | yes |
| [`cancel_run`](#cancel_run) | Cancel a run |  |
| [`list_runners`](#list_runners) | List runners | yes |

### submit_run

One run, stored `pending` until a runner whose labels and free memory fit claims it, with what it was for when `for` says. Nothing is checked against the repo here: a run of a job missing from `jobs.toml` at that commit fails on its runner, saying so in its log.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `repo` | string | yes | `owner/name` on GitHub. |
| `commit` | string | yes | The commit to run, as a full lowercase sha: the runner checks out exactly this. |
| `job` | string | yes | A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine. |
| `args` | string[] |  | Appended to the job's `run` command from `jobs.toml`. |
| `limits` | object |  |  |
| `limits.memory` | integer or null |  | MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with. |
| `limits.timeout` | integer or null |  | Seconds before the runner stops it and it fails. Null: `jobs.toml`'s. |
| `labels` | object |  | Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has. |
| `for` | object or null |  | What the run was for, as `GET /runs?for=<kind>:<id>` lists it. |
| `routine` | object or null |  | Where the job's steps live, when not in its own repo: `job` is read from `<dir>/jobs.toml` in `repo` at `commit`, and the run's own `repo` and `commit` are its target, the package checked out at `/work` beside the routine. Only a runner that says it `can` run a `routine` claims it. |
| `host` | string or null |  | The machine it must run on, as a runner's `hostId`: claimed only by that machine's runner, and only one that says it `can` run `host` runs, which runs it on the host itself, with the host's user services, if that host's config lets it. Null: any runner that fits. |

### list_runs

Returns runs matching every filter given, newest first.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `state` | `pending`, `running`, `succeeded`, `failed`, `canceled` |  | `pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves. |
| `repo` | string |  | `owner/name` on GitHub. |
| `submittedBy` | string |  | Only the runs submitted with this `claimed-by`, as `submittedBy` records it. |
| `for` | string |  | `<kind>:<id>`, e.g. `item:28af81bc-…`: only the runs submitted with that `for`. |
| `limit` | integer |  | At most this many, newest first. |

### get_run

Returns one run.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The run's id. |

### get_run_log

Returns the log from byte `offset`, at most 1 MiB, with the log's size so far and the run's state. Empty when `offset` is the log's size: call again later from there while the run is `pending` or `running`.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The run's id. |
| `offset` | integer |  | The byte to read from; default 0. |

### cancel_run

A pending run ends `canceled` at once. A running one is marked `cancelRequested`: its runner is told on its next log append, stops it, and reports it `canceled`.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The run's id. |

### list_runners

Returns every registered runner, most recently seen first, with its labels and host.

No input.
