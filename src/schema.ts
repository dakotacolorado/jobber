import { createRoute, z } from "@hono/zod-openapi";
import {
  CAPABILITIES,
  COMMIT_PATTERN,
  FOR_ID_PATTERN,
  FOR_KINDS,
  JOB_NAME_PATTERN,
  LABEL_PATTERN,
  REPO_PATTERN,
  ROUTINE_DIR_PATTERN,
  STATES,
} from "./domain.ts";

/** Validates every request and generates `openapi.json`, so neither can drift. */

const Repo = z.string().max(200).regex(REPO_PATTERN).describe("`owner/name` on GitHub.").openapi({ example: "dakotacolorado/python-template" });
const Commit = z
  .string()
  .regex(COMMIT_PATTERN)
  .describe("The commit to run, as a full lowercase sha: the runner checks out exactly this.")
  .openapi({ example: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
const JobName = z
  .string()
  .regex(JOB_NAME_PATTERN)
  .describe("A `[jobs.<name>]` in the repo's `jobs.toml` at that commit, or in the routine directory's when it has a routine.")
  .openapi({ example: "hello" });
const State = z
  .enum(STATES)
  .describe("`pending` until a runner claims it, `running` on that runner, then `succeeded`, `failed` or `canceled`, which it never leaves.")
  .openapi({ example: "pending" });

const HostId = z.string().trim().min(1).max(200).describe("The machine it runs on: its worker-host's `host_id`, by default the hostname.");

const Label = z.string().regex(LABEL_PATTERN);
export const Labels = z
  .record(Label, Label)
  .refine((labels) => Object.keys(labels).length <= 20, "at most 20 labels")
  .describe("Labels as Kubernetes writes them. On a run, what a runner must have, every key with that value; on a runner, what it has.")
  .openapi({ example: { arch: "x86_64" } });

export const LimitsSchema = z
  .object({
    memory: z
      .int()
      .min(16)
      .max(1_048_576)
      .nullable()
      .default(null)
      .describe("MiB the container may use, and the runner reserves for it. Null: `jobs.toml`'s, within the 1024 MiB a run without one is admitted with."),
    timeout: z.int().min(1).max(86_400).nullable().default(null).describe("Seconds before the runner stops it and it fails. Null: `jobs.toml`'s."),
  })
  .openapi("Limits");

export const RunsWithSchema = z
  .object({
    memory: z.int().min(1).max(1_048_576).describe("MiB the container may use."),
    timeout: z.int().min(1).max(86_400).describe("Seconds before the runner stops it and it fails."),
    stall: z
      .int()
      .min(1)
      .max(86_400)
      .nullable()
      .describe("Seconds without progress (output, CPU or network) before the runner ends it, failed as stalled; null when it never does."),
  })
  .openapi("RunsWith");

export const ForSchema = z
  .object({
    kind: z.enum(FOR_KINDS).describe("What asked for the run: an approval-service batch or change, a work-tracker item, or a worker."),
    id: z.string().regex(FOR_ID_PATTERN).describe("Its id there, without spaces."),
  })
  .describe("What the run was for, as `GET /runs?for=<kind>:<id>` lists it.")
  .openapi("For", { example: { kind: "item", id: "28af81bc-6a9a-4189-ad1f-8fd9de51308a" } });

export const RoutineSchema = z
  .object({
    repo: Repo.describe("`owner/name` on GitHub: the repo the routine is in.").openapi({ example: "dakotacolorado/release-routines" }),
    commit: Commit.describe("The routine repo's commit, as a full lowercase sha: the runner checks out exactly this."),
    dir: z
      .string()
      .max(200)
      .regex(ROUTINE_DIR_PATTERN)
      .describe("The routine's directory in that repo, holding the `jobs.toml` that names `job`: `/`-separated, no `.` or `..`.")
      .openapi({ example: "dakotacolorado/honed" }),
  })
  .describe(
    "Where the job's steps live, when not in its own repo: `job` is read from `<dir>/jobs.toml` in `repo` at `commit`, and the run's " +
      "own `repo` and `commit` are its target, the package checked out at `/work` beside the routine. Only a runner that says it " +
      "`can` run a `routine` claims it.",
  )
  .openapi("Routine");

export const SubmitSchema = z
  .object({
    repo: Repo,
    commit: Commit,
    job: JobName,
    args: z.array(z.string().max(4000)).max(50).default([]).describe("Appended to the job's `run` command from `jobs.toml`."),
    limits: LimitsSchema.default({ memory: null, timeout: null }),
    labels: Labels.default({}),
    for: ForSchema.nullable().default(null),
    routine: RoutineSchema.nullable().default(null),
    host: HostId.nullable()
      .default(null)
      .describe(
        "The machine it must run on, as a runner's `hostId`: claimed only by that machine's runner, and only one that says it `can` " +
          "run `host` runs, which runs it on the host itself, with the host's user services, if that host's config lets it. Null: any runner that fits.",
      ),
  })
  .openapi("SubmitRunInput");

export const RunSchema = z
  .object({
    id: z.string().uuid().describe("The run's id."),
    repo: Repo.describe("`owner/name` on GitHub: checked out at `/work`; with a routine, its target."),
    commit: Commit,
    job: JobName,
    routine: RoutineSchema.nullable().describe("Where its steps live, when not in `repo`'s own `jobs.toml`; null when they are."),
    host: z.string().nullable().describe("The machine it must run on, on the host itself; null: any runner that fits."),
    args: z.array(z.string()).describe("Appended to the job's `run` command from `jobs.toml`."),
    limits: LimitsSchema,
    labels: Labels,
    for: ForSchema.nullable().describe("What it was for; null when its submitter did not say."),
    state: State,
    reason: z.string().nullable().describe("Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout."),
    cancelRequested: z.boolean().describe("A cancel was asked for: the runner of a run in progress is told to stop it on its next log append."),
    runner: z.string().uuid().nullable().describe("The runner that claimed it; null while pending."),
    runsWith: RunsWithSchema.nullable().describe(
      "What its runner runs it with: `limits`, else `jobs.toml`'s for the job, else its `[defaults]`. Null until its runner has read `jobs.toml`, and on a runner that does not say.",
    ),
    exit: z.int().nullable().describe("The run's exit code, once its runner reports one."),
    duration: z.number().nullable().describe("Seconds it ran, as its runner reported."),
    logSize: z.int().describe("Bytes of log stored so far."),
    submittedBy: z.string().nullable().describe("The `claimed-by` it was submitted with."),
    createdAt: z.string().describe("When it was submitted, as an ISO 8601 timestamp."),
    updatedAt: z.string().describe("When it last changed, as an ISO 8601 timestamp."),
    startedAt: z.string().nullable().describe("When a runner claimed it; null while pending."),
    endedAt: z.string().nullable().describe("When it ended; null until it does."),
    leaseExpiresAt: z.string().nullable().describe("While running: if no log append renews it by then, the run fails."),
  })
  .openapi("Run");

const SkillFileSchema = z.object({
  path: z.string().describe("Under the worker's Claude Code folder: `skills/jobs/bin/…` or `skills/jobs/reference/…`."),
  content: z.string().describe("The file's text."),
  executable: z.boolean().describe("Whether to install it executable: true for everything under `bin/`."),
}).openapi("SkillFile");

export const SkillSchema = z
  .object({
    key: z.string().describe("The skill's name, which its files are under."),
    version: z.int().describe("The deployed tree's commit count, 0 when deployed from outside git."),
    commit: z.string().describe("The deployed commit, ending `-dirty` when deployed with uncommitted changes."),
    files: z.array(SkillFileSchema).describe("Every file of the skill, as a worker installs it."),
  })
  .openapi("Skill");

/** Each status's exception, as an AWS API names it. */
export const ERROR_CODES = {
  400: "ValidationException",
  401: "UnauthorizedException",
  403: "AccessDeniedException",
  404: "ResourceNotFoundException",
  409: "ConflictException",
  413: "PayloadTooLargeException",
  416: "InvalidRangeException",
  500: "InternalServerException",
  503: "ServiceUnavailableException",
} as const;

export type ErrorStatus = keyof typeof ERROR_CODES;

export const ErrorSchema = z
  .object({
    code: z.enum(Object.values(ERROR_CODES) as [string, ...string[]]).describe("What went wrong, as an exception name: one per HTTP status."),
    message: z.string().describe("What went wrong, in words."),
  })
  .describe("Every error's body.")
  .openapi("Error");

const ClaimHeader = z.object({
  "claimed-by": z.string().min(1).max(200).optional().describe("Who is submitting: recorded on the run as `submittedBy`."),
});

const IdParam = z.object({ id: z.string().uuid().describe("The run's id.").openapi({ param: { name: "id", in: "path" } }) });

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

/** An error answer, described as `<code>: <cause>`, which the reference lists as AWS's do. */
const fails = (status: ErrorStatus, cause: string) => json(ErrorSchema, `${ERROR_CODES[status]}: ${cause}`);

const FAILS = {
  400: fails(400, "The request failed validation."),
  401: fails(401, "The bearer token is missing or is not the submitters'."),
  503: fails(503, "The service has no submitters' token configured."),
};
const MISSING = { 404: fails(404, "No run has that id.") };
const secured = { security: [{ bearerAuth: [] }], tags: ["Runs"] };

// --- routes -----------------------------------------------------------------

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "GetHealth",
  tags: ["Service"],
  summary: "Get the service's health and version",
  responses: {
    200: json(
      z
        .object({
          ok: z.literal(true).describe("Always true: an answer at all means it is up."),
          version: z.string().describe("The package's version."),
          commit: z.string().describe("The commit it was built from, ending `-dirty` when built with uncommitted changes."),
        })
        .openapi("Health"),
      "Service is up.",
    ),
  },
});

export const skillRoute = createRoute({
  security: [{ bearerAuth: [] }],
  tags: ["Service"],
  method: "get",
  path: "/skill",
  operationId: "GetSkill",
  summary: "Get the client workers call this deployment with",
  description: "The jobs skill's `bin/` and `reference/`, as this deployment was built with them, so a worker calls the API that is deployed.",
  responses: { 200: json(SkillSchema, "The skill's files."), 401: FAILS[401], 503: FAILS[503] },
});

export const submitRoute = createRoute({
  ...secured,
  method: "post",
  path: "/runs",
  operationId: "SubmitRun",
  summary: "Submit a run of a job: a named script in a repo at a commit",
  description:
    "One run, stored `pending` until a runner whose labels and free memory fit claims it, with what it was for when " +
    "`for` says. Nothing is checked against the repo " +
    "here: a run of a job missing from `jobs.toml` at that commit fails on its runner, saying so in its log.",
  request: { headers: ClaimHeader, body: json(SubmitSchema, "What to run, and where it may run.") },
  responses: { 201: json(RunSchema, "Stored, `pending`."), ...FAILS },
});

/** `listRuns`'s filters, which `list_runs` takes too. */
export const ListQuery = z.object({
  state: State.optional(),
  repo: Repo.optional(),
  submittedBy: z.string().min(1).max(200).optional().describe("Only the runs submitted with this `claimed-by`, as `submittedBy` records it."),
  for: z
    .string()
    .optional()
    .describe("`<kind>:<id>`, e.g. `item:28af81bc-…`: only the runs submitted with that `for`.")
    .openapi({ example: "item:28af81bc-6a9a-4189-ad1f-8fd9de51308a" }),
  limit: z.coerce.number().int().min(1).max(500).default(100).describe("At most this many, newest first."),
});

export const listRoute = createRoute({
  ...secured,
  method: "get",
  path: "/runs",
  operationId: "ListRuns",
  summary: "List runs, newest first",
  request: {
    query: ListQuery,
  },
  responses: {
    200: json(z.object({ runs: z.array(RunSchema).describe("The runs, newest first.") }).openapi("ListRunsResponse"), "The runs."),
    ...FAILS,
  },
});

export const getRoute = createRoute({
  ...secured,
  method: "get",
  path: "/runs/{id}",
  operationId: "GetRun",
  summary: "Get a run",
  request: { params: IdParam },
  responses: { 200: json(RunSchema, "The run."), ...FAILS, ...MISSING },
});

/** Most one read returns: a longer log is read in parts. */
export const LOG_READ_MAX = 1 << 20;

export const logRoute = createRoute({
  ...secured,
  method: "get",
  path: "/runs/{id}/log",
  operationId: "GetRunLog",
  summary: "Get a run's log from a byte offset",
  description:
    "Send `Range: bytes=N-` to read from offset N; without it, from 0. Answers 206 with `Content-Range: bytes N-M/size` " +
    "and at most 1 MiB, or an empty body when N is the log's size, so a follower polls from where it got to. " +
    "`Run-State` says the run's state, so it knows when to stop.",
  request: {
    params: IdParam,
    headers: z.object({ range: z.string().regex(/^bytes=\d+-$/).optional().describe("`bytes=N-`") }),
  },
  responses: {
    206: {
      content: { "text/plain": { schema: z.string() } },
      description: "The log from N, up to 1 MiB.",
      headers: z.object({
        "content-range": z.string().describe("`bytes N-M/size` for the bytes sent, or `bytes */size` when there are none: `size` is the log's length so far."),
        "run-state": State.describe("The run's state: once it has ended and the log is read to `size`, there is no more."),
      }),
    },
    416: fails(416, "N is past the end of the log."),
    ...FAILS,
    ...MISSING,
  },
});

export const cancelRoute = createRoute({
  ...secured,
  method: "post",
  path: "/runs/{id}/cancel",
  operationId: "CancelRun",
  summary: "Cancel a run",
  description:
    "A pending run ends `canceled` at once. A running one is marked `cancelRequested`: its runner is told on its next " +
    "log append, stops it, and reports it `canceled`.",
  request: { params: IdParam },
  responses: { 200: json(RunSchema, "The run, canceled or marked."), 409: fails(409, "It has already ended."), ...FAILS, ...MISSING },
});

// --- runners ----------------------------------------------------------------

export const RunnerSchema = z
  .object({
    id: z.string().uuid().describe("The runner's id."),
    name: z.string().describe("What it calls itself, e.g. its host's name: not unique."),
    labels: Labels,
    slots: z.int().describe("Runs it runs at once."),
    memory: z.int().describe("MiB it has for runs and their image builds."),
    version: z.string().nullable().describe("job-runner's version, as it said."),
    hostId: z
      .string()
      .nullable()
      .describe("The machine it runs on, the same as that machine's worker-host's `host_id` (by default its hostname); null until it says."),
    createdAt: z.string().describe("When it registered, as an ISO 8601 timestamp."),
    lastSeenAt: z.string().describe("When it last asked for a run, as an ISO 8601 timestamp."),
  })
  .openapi("Runner");


export const RegisterSchema = z
  .object({
    name: z.string().trim().min(1).max(200).describe("What it calls itself, e.g. its host's name: not unique."),
    labels: Labels.default({}),
    slots: z.int().min(1).max(64).describe("Runs it runs at once."),
    memory: z.int().min(16).max(1_048_576).describe("MiB it has for runs and their image builds."),
    version: z.string().max(100).nullable().default(null).describe("job-runner's version."),
    hostId: HostId.nullable().default(null),
  })
  .openapi("RegisterRunnerInput");

export const RegisteredSchema = z
  .object({
    runner: RunnerSchema.describe("The runner, registered."),
    token: z.string().describe("Its own bearer token, `<runner id>.<secret>`, shown only here: keep it where only the runner's user can read it."),
  })
  .openapi("RegisterRunnerResponse");

export const ClaimRequestSchema = z
  .object({
    labels: Labels.optional().describe("What it has now; its registered labels when absent."),
    can: z
      .array(z.enum(CAPABILITIES))
      .max(10)
      .default([])
      .describe(
        "What it can run beyond a job in its repo's own `jobs.toml`: `routine`, a run with a routine; `host`, a run naming its host, run on the host itself. " +
          "A run needing one it does not say is left for another.",
      ),
    hostId: HostId.optional().describe("The machine it runs on now, recorded on the runner, so one registered before it said keeps its id."),
    free: z
      .object({
        slots: z.int().min(0).describe("Slots not taken by a run."),
        memory: z.int().min(0).describe("MiB not reserved by a run in progress or an image build."),
      })
      .describe("What it can take on now."),
  })
  .openapi("ClaimRunInput");

export const ClaimSchema = z
  .object({
    run: RunSchema.describe("The run, now running on this runner."),
    memory: z.int().describe("MiB the run was admitted with: reserve this, and run it with no more."),
    lease: z.int().describe("Seconds the run lives without a log append. Append, or renew with an empty one, well within it."),
  })
  .openapi("ClaimRunResponse");

export const AppendedSchema = z
  .object({
    size: z.int().describe("Bytes of log stored: the offset the next append starts at."),
    canceled: z.boolean().describe("A cancel was asked for: stop the run and report it `canceled`."),
    leaseExpiresAt: z.string().describe("When the run fails unless another append renews it, as an ISO 8601 timestamp."),
  })
  .openapi("AppendRunLogResponse");

export const ReportSchema = z
  .object({
    state: z.enum(["succeeded", "failed", "canceled"]).describe("`canceled` when stopped for a cancel; `failed` for a non-zero exit, a timeout, or an image that would not build."),
    exit: z.int().nullable().describe("The run's exit code; null when it never ran or was killed."),
    duration: z.number().min(0).describe("Seconds from claim to end."),
    reason: z.string().trim().min(1).max(2000).nullable().default(null).describe("Why, when the state does not say: `timed out after 600s`, `image build failed`."),
  })
  .openapi("CompleteRunInput");

const RunnerIdParam = z.object({ id: z.string().uuid().describe("The runner's id.").openapi({ param: { name: "id", in: "path" } }) });
const runnerAuth = { security: [{ runnerAuth: [] }], tags: ["Runners"] };
const RUNNER_FAILS = {
  400: fails(400, "The request failed validation."),
  401: fails(401, "The bearer token is not a runner's own."),
  403: fails(403, "The run is another runner's, or the path names another runner."),
};

export const registerRoute = createRoute({
  security: [{ bearerAuth: [] }],
  tags: ["Runners"],
  method: "post",
  path: "/runners",
  operationId: "RegisterRunner",
  summary: "Register a runner",
  description: "With the registration token, not the submitters'. Answers the runner's own token once.",
  request: { body: json(RegisterSchema, "What the runner is and has.") },
  responses: { 201: json(RegisteredSchema, "Registered."), ...FAILS },
});

export const runnersRoute = createRoute({
  ...secured,
  tags: ["Runners"],
  method: "get",
  path: "/runners",
  operationId: "ListRunners",
  summary: "List runners, most recently seen first",
  responses: {
    200: json(
      z.object({ runners: z.array(RunnerSchema).describe("Every registered runner, most recently seen first.") }).openapi("ListRunnersResponse"),
      "The runners.",
    ),
    ...FAILS,
  },
});

export const claimRoute = createRoute({
  ...runnerAuth,
  method: "post",
  path: "/runners/{id}/claim",
  operationId: "ClaimRun",
  summary: "Claim the oldest pending run that fits",
  description:
    "The oldest pending run whose labels the runner has, whose memory fits `free`, whose routine or host, if any, it `can` run, " +
      "and whose `host`, if any, is the runner's own `hostId`, moved to `running` on this runner. " +
    "Two claims never get the same run. 204 when none fits.",
  request: { params: RunnerIdParam, body: json(ClaimRequestSchema, "What the runner can take on.") },
  responses: { 200: json(ClaimSchema, "A run, now running here."), 204: { description: "No pending run fits." }, ...RUNNER_FAILS },
});

export const InvalidRangeSchema = ErrorSchema.extend({
  size: z.int().describe("Bytes of log stored: the offset to resend from."),
}).openapi("InvalidRangeError");

export const appendRoute = createRoute({
  ...runnerAuth,
  method: "patch",
  path: "/runs/{id}/log",
  operationId: "AppendRunLog",
  summary: "Append to the log of a run in progress, and renew its lease",
  description:
    "The body is the bytes, `Content-Range: bytes S-E/*` where S is the log's current size and E = S + length - 1. " +
    "An empty body without `Content-Range` only renews the lease. 416 for any other S, with the size to resend from. " +
    "At most 256 KiB per append and 64 MiB per run (413). The reply says whether a cancel was asked for.",
  request: {
    params: IdParam,
    headers: z.object({ "content-range": z.string().regex(/^bytes \d+-\d+\/(\*|\d+)$/).optional().describe("`bytes S-E/*`") }),
    body: { content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } }, description: "The log's next bytes." },
  },
  responses: {
    200: json(AppendedSchema, "Stored, and the lease renewed."),
    409: fails(409, "The run is not running: it ended, perhaps by its lease lapsing."),
    413: fails(413, "Over 256 KiB, or the log would pass 64 MiB."),
    416: json(InvalidRangeSchema, `${ERROR_CODES[416]}: The append does not start at the log's end: resend from \`size\`.`),
    ...RUNNER_FAILS,
    ...MISSING,
  },
});

export const runsWithRoute = createRoute({
  ...runnerAuth,
  method: "put",
  path: "/runs/{id}/runs-with",
  operationId: "PutRunsWith",
  summary: "Put what a run in progress runs with",
  description: "From the run's own runner, once it has read `jobs.toml` and before it starts the run's container. Sending it again replaces it.",
  request: { params: IdParam, body: json(RunsWithSchema, "Its memory, timeout and stall limit.") },
  responses: { 200: json(RunSchema, "The run, with `runsWith`."), 409: fails(409, "It is not running."), ...RUNNER_FAILS, ...MISSING },
});

export const reportRoute = createRoute({
  ...runnerAuth,
  method: "put",
  path: "/runs/{id}",
  operationId: "CompleteRun",
  summary: "Complete a run in progress, saying how it ended",
  description: "From the run's own runner. Sending the same end again answers it unchanged, so a lost reply can be retried.",
  request: { params: IdParam, body: json(ReportSchema, "How it ended.") },
  responses: { 200: json(RunSchema, "The run, ended."), 409: fails(409, "It is not running, or ended otherwise."), ...RUNNER_FAILS, ...MISSING },
});
