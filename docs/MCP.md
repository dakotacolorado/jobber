# jobber's MCP server

<!-- Generated from src/mcp.ts by `npm run spec`; do not edit. -->

Streamable HTTP at `/mcp`, stateless, answering JSON. Every request takes the submitters' bearer token (`AUTH_TOKEN`), as the API does: each tool is one API request made with it, so it is refused, recorded and answered as that request would be. A refusal comes back as the tool's error, in the API's words.

```json
{
  "mcpServers": {
    "jobber": {
      "type": "http",
      "url": "https://dakotajp-lenovo-laptop.tail90863a.ts.net:8445/mcp",
      "headers": {
        "Authorization": "Bearer <AUTH_TOKEN>"
      }
    }
  }
}
```

## Instructions

What the server tells an agent when it connects:

> jobber runs code on whatever computers you have, its hosts: a job is a named script in a repo's jobs.toml, a run one execution of it at one commit, placed by its scheduler on a host that meets its requirements (os, arch) and has its cpu and memory free.
>
> - A run is submitted pending, assigned to a host by the scheduler, running there, and ends succeeded, failed or canceled with its exit code.
> - A run's log is read from a byte offset: get_run_log answers the bytes from offset, the log's size, and the run's state, so call it again from offset + the bytes read until the state has ended.
> - Label runs to find them again (e.g. {"item": "28af81bc", "by": "agent-7"}); list_runs filters by label as key=value.
> - Pending runs are taken highest priority first, then oldest: list_queue lists them in that order, next first. Give priority when submitting, or move a run with update_run_priority.
> - Give retry {limit, backoff} to try a failed run again: each attempt keeps its own log and exit, the run's attempts lists the earlier ones, and get_run_log reads any by attempt.
> - cancel_run ends a pending or assigned run at once; a running one is stopped by its host shortly after.
> - Every tool takes the submitters' token this server was connected with. The host protocol (register, connect, heartbeat, append, complete) is jobber-host's, not tools.

## Tools

| Tool | Does | Reads only |
| --- | --- | --- |
| [`submit_run`](#submit_run) | Submit a run |  |
| [`list_runs`](#list_runs) | List runs | yes |
| [`list_queue`](#list_queue) | List the queue | yes |
| [`get_run`](#get_run) | Get a run | yes |
| [`get_run_log`](#get_run_log) | Read a run's log | yes |
| [`cancel_run`](#cancel_run) | Cancel a run |  |
| [`update_run_priority`](#update_run_priority) | Update run priority |  |
| [`list_hosts`](#list_hosts) | List hosts | yes |

### submit_run

Queues a run as `pending`, by `priority` then age, until a host that meets its requirements takes it. The repo isn't checked here: a missing job fails on its host.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `repo` | string | yes | GitHub repo, `owner/name`. |
| `commit` | string | yes | Full commit sha to check out. |
| `job` | string | yes | A `[jobs.<name>]` in the repo's `jobs.toml`. |
| `args` | string[] |  | Arguments appended to the job's command. |
| `requirements` | object |  | What the run needs from its host. |
| `requirements.os` | `linux`, `macos`, `windows` or null |  | Operating system it needs. Default: any. |
| `requirements.arch` | `x86_64`, `aarch64` or null |  | CPU architecture it needs. Default: any. |
| `requirements.cpu` | number or null |  | CPUs, a decimal number (e.g. 0.5). Default: 0.5. |
| `requirements.memory` | integer or null |  | Memory in MiB. Default: `jobs.toml`'s, else 1024. |
| `requirements.timeout` | integer or null |  | Timeout in seconds. Default: `jobs.toml`'s. |
| `labels` | object |  | Labels to find it by, e.g. what it is for and who asked. |
| `priority` | integer |  | Higher is placed first; equal ones oldest first. -1000 to 1000. Default: 0. |
| `retry` | object |  | Retries a failed attempt (not a canceled one). |
| `retry.limit` | integer |  | Retries after a failed attempt, 0 to 10. Default: 0. |
| `retry.backoff` | integer |  | Seconds before the first retry, doubling for each after, at most 3600. Default: 10. |

### list_runs

Returns runs matching every filter given, newest first.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `state` | `pending`, `assigned`, `running`, `succeeded`, `failed`, `canceled` |  | `pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`. An assignment not taken goes back to `pending`. |
| `repo` | string |  | GitHub repo, `owner/name`. |
| `label` | string or string[] |  | Only runs with this label, as `key=value`. Repeat to require several. |
| `limit` | integer |  | Max results. Default: 100. |

### list_queue

The `pending` runs in the order the scheduler places them: highest `priority` first, then oldest. The first is next to go to a host that fits it; one no host fits is passed over, not waited for, and one waiting out a retry's backoff is listed with its `retryAt`. Move a run with `UpdateRunPriority`.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `limit` | integer |  | Max results. Default: 100. |

### get_run

Returns one run.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The run's id. |

### get_run_log

Returns the latest attempt's log, or `attempt`'s, from byte `offset`, at most 1 MiB, with the log's size so far and the attempt's state. Empty when `offset` is the log's size: call again later from there while the run is `pending` or `running`.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The run's id. |
| `offset` | integer |  | The byte to read from; default 0. |
| `attempt` | integer |  | Which attempt's log; default the latest. A run's `attempts` lists its earlier ones. |

### cancel_run

Ends a run not yet started (pending or assigned) now. A running one is stopped by its host within seconds.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The run's id. |

### update_run_priority

Moves a run not yet ended up or down the queue. A running one keeps its host.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The run's id. |
| `priority` | integer | yes | Higher is placed first; equal ones oldest first. -1000 to 1000. |

### list_hosts

Returns every host in the fleet, most recently seen first, with its capacity, free capacity and health.

No input.
