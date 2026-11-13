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

Queues a run as `pending` until a runner claims it. The repo isn't checked here: a missing job fails on its runner.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `repo` | string | yes | GitHub repo, `owner/name`. |
| `commit` | string | yes | Full commit sha to check out. |
| `job` | string | yes | A `[jobs.<name>]` in the repo's `jobs.toml`. |
| `args` | string[] |  | Arguments appended to the job's command. |
| `limits` | object |  |  |
| `limits.memory` | integer or null |  | Memory in MiB. Default: `jobs.toml`'s, else 1024. |
| `limits.timeout` | integer or null |  | Timeout in seconds. Default: `jobs.toml`'s. |
| `labels` | object |  | Key-value labels. On a run, what its runner must have. |
| `for` | object or null |  | What the run is for: filter with `ListRuns?for=<kind>:<id>`. |
| `routine` | object or null |  | Run a job from another repo's `jobs.toml` against this repo (used by release routines). |
| `host` | string or null |  | Run on this host itself, outside a container. Default: any runner, in a container. |

### list_runs

Returns runs matching every filter given, newest first.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `state` | `pending`, `running`, `succeeded`, `failed`, `canceled` |  | `pending` → `running` → `succeeded`, `failed` or `canceled`. |
| `repo` | string |  | GitHub repo, `owner/name`. |
| `submittedBy` | string |  | Only runs with this `submittedBy`. |
| `for` | string |  | Only runs for this `<kind>:<id>`. |
| `limit` | integer |  | Max results. Default: 100. |

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

Ends a pending run now. A running one is stopped by its runner within seconds.

| Input | Type | Required | |
| --- | --- | --- | --- |
| `id` | string | yes | The run's id. |

### list_runners

Returns every registered runner, most recently seen first, with its labels and host.

No input.
