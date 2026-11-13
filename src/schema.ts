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

const Repo = z.string().max(200).regex(REPO_PATTERN).describe("GitHub repo, `owner/name`.").openapi({ example: "dakotacolorado/python-template" });
const Commit = z
  .string()
  .regex(COMMIT_PATTERN)
  .describe("Full commit sha to check out.")
  .openapi({ example: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
const JobName = z
  .string()
  .regex(JOB_NAME_PATTERN)
  .describe("A `[jobs.<name>]` in the repo's `jobs.toml`.")
  .openapi({ example: "hello" });
const State = z
  .enum(STATES)
  .describe("`pending` → `running` → `succeeded`, `failed` or `canceled`.")
  .openapi({ example: "pending" });

const HostId = z.string().trim().min(1).max(200).describe("Host name, as worker-host knows it.");

const Label = z.string().regex(LABEL_PATTERN);
export const Labels = z
  .record(Label, Label)
  .refine((labels) => Object.keys(labels).length <= 20, "at most 20 labels")
  .describe("Key-value labels. On a run, what its runner must have.")
  .openapi({ example: { arch: "x86_64" } });

export const LimitsSchema = z
  .object({
    memory: z
      .int()
      .min(16)
      .max(1_048_576)
      .nullable()
      .default(null)
      .describe("Memory in MiB. Default: `jobs.toml`'s, else 1024."),
    timeout: z.int().min(1).max(86_400).nullable().default(null).describe("Timeout in seconds. Default: `jobs.toml`'s."),
  })
  .openapi("Limits");

export const RunsWithSchema = z
  .object({
    memory: z.int().min(1).max(1_048_576).describe("Memory in MiB."),
    timeout: z.int().min(1).max(86_400).describe("Timeout in seconds."),
    stall: z
      .int()
      .min(1)
      .max(86_400)
      .nullable()
      .describe("Seconds without progress before it fails as stalled; null for never."),
  })
  .openapi("RunsWith");

export const ForSchema = z
  .object({
    kind: z.enum(FOR_KINDS).describe("What kind of thing asked for it."),
    id: z.string().regex(FOR_ID_PATTERN).describe("Its id."),
  })
  .describe("What the run is for: filter with `ListRuns?for=<kind>:<id>`.")
  .openapi("For", { example: { kind: "item", id: "28af81bc-6a9a-4189-ad1f-8fd9de51308a" } });

export const RoutineSchema = z
  .object({
    repo: Repo.describe("Repo holding the routine.").openapi({ example: "dakotacolorado/release-routines" }),
    commit: Commit.describe("Full commit sha of that repo."),
    dir: z
      .string()
      .max(200)
      .regex(ROUTINE_DIR_PATTERN)
      .describe("Directory holding the routine's `jobs.toml`.")
      .openapi({ example: "dakotacolorado/honed" }),
  })
  .describe(
    "Run a job from another repo's `jobs.toml` against this repo (used by release routines).",
  )
  .openapi("Routine");

export const SubmitSchema = z
  .object({
    repo: Repo,
    commit: Commit,
    job: JobName,
    args: z.array(z.string().max(4000)).max(50).default([]).describe("Arguments appended to the job's command."),
    limits: LimitsSchema.default({ memory: null, timeout: null }),
    labels: Labels.default({}),
    for: ForSchema.nullable().default(null),
    routine: RoutineSchema.nullable().default(null),
    host: HostId.nullable()
      .default(null)
      .describe(
        "Run on this host itself, outside a container. Default: any runner, in a container.",
      ),
  })
  .openapi("SubmitRunInput");

export const RunSchema = z
  .object({
    id: z.string().uuid().describe("The run's id."),
    repo: Repo.describe("GitHub repo, `owner/name`."),
    commit: Commit,
    job: JobName,
    routine: RoutineSchema.nullable().describe("The routine it runs, if any."),
    host: z.string().nullable().describe("The host it must run on, if any."),
    args: z.array(z.string()).describe("Arguments appended to the job's command."),
    limits: LimitsSchema,
    labels: Labels,
    for: ForSchema.nullable().describe("What it is for, if given."),
    state: State,
    reason: z.string().nullable().describe("Why it ended, when not plain (e.g. timed out)."),
    cancelRequested: z.boolean().describe("Cancel asked for; its runner will stop it."),
    runner: z.string().uuid().nullable().describe("Runner that claimed it."),
    runsWith: RunsWithSchema.nullable().describe(
      "Limits it actually runs with, once its runner says.",
    ),
    exit: z.int().nullable().describe("Exit code."),
    duration: z.number().nullable().describe("Seconds it ran."),
    logSize: z.int().describe("Log size in bytes."),
    submittedBy: z.string().nullable().describe("Who submitted it (`claimed-by`)."),
    createdAt: z.string().describe("Submitted at (ISO 8601)."),
    updatedAt: z.string().describe("Last changed at (ISO 8601)."),
    startedAt: z.string().nullable().describe("Claimed at (ISO 8601)."),
    endedAt: z.string().nullable().describe("Ended at (ISO 8601)."),
    leaseExpiresAt: z.string().nullable().describe("Fails at this time unless its runner checks in."),
  })
  .openapi("Run");

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
    code: z.enum(Object.values(ERROR_CODES) as [string, ...string[]]).describe("Exception name."),
    message: z.string().describe("What went wrong."),
  })
  .describe("Every error's body.")
  .openapi("Error");

const ClaimHeader = z.object({
  "claimed-by": z.string().min(1).max(200).optional().describe("Who is submitting; saved as `submittedBy`."),
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
  tags: ["Platform"],
  summary: "Get health",
  responses: {
    200: json(
      z
        .object({
          ok: z.literal(true).describe("Always true."),
          version: z.string().describe("Package version."),
          commit: z.string().describe("Commit it was built from."),
        })
        .openapi("Health"),
      "Service is up.",
    ),
  },
});

export const submitRoute = createRoute({
  ...secured,
  method: "post",
  path: "/runs",
  operationId: "SubmitRun",
  summary: "Submit a run",
  description: "Queues a run as `pending` until a runner claims it. The repo isn't checked here: a missing job fails on its runner.",
  request: { headers: ClaimHeader, body: json(SubmitSchema, "What to run, and where it may run.") },
  responses: { 201: json(RunSchema, "Stored, `pending`."), ...FAILS },
});

/** `listRuns`'s filters, which `list_runs` takes too. */
export const ListQuery = z.object({
  state: State.optional(),
  repo: Repo.optional(),
  submittedBy: z.string().min(1).max(200).optional().describe("Only runs with this `submittedBy`."),
  for: z
    .string()
    .optional()
    .describe("Only runs for this `<kind>:<id>`.")
    .openapi({ example: "item:28af81bc-6a9a-4189-ad1f-8fd9de51308a" }),
  limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max results. Default: 100."),
});

export const listRoute = createRoute({
  ...secured,
  method: "get",
  path: "/runs",
  operationId: "ListRuns",
  summary: "List runs",
  request: {
    query: ListQuery,
  },
  responses: {
    200: json(z.object({ runs: z.array(RunSchema).describe("Runs, newest first.") }).openapi("ListRunsResponse"), "The runs."),
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
  summary: "Get a run's log",
  description: "Reads up to 1 MiB from byte N (`Range: bytes=N-`). To follow a run, poll from the last `size` until `Run-State` has ended.",
  request: {
    params: IdParam,
    headers: z.object({ range: z.string().regex(/^bytes=\d+-$/).optional().describe("`bytes=N-`") }),
  },
  responses: {
    206: {
      content: { "text/plain": { schema: z.string() } },
      description: "Log bytes from N, up to 1 MiB.",
      headers: z.object({
        "content-range": z.string().describe("`bytes N-M/size`; `size` is the log's length so far."),
        "run-state": State.describe("The run's state: stop polling once it has ended."),
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
  description: "Ends a pending run now. A running one is stopped by its runner within seconds.",
  request: { params: IdParam },
  responses: { 200: json(RunSchema, "The run, canceled or marked."), 409: fails(409, "It has already ended."), ...FAILS, ...MISSING },
});

// --- runners ----------------------------------------------------------------

export const RunnerSchema = z
  .object({
    id: z.string().uuid().describe("The runner's id."),
    name: z.string().describe("Display name; not unique."),
    labels: Labels,
    slots: z.int().describe("Runs at once."),
    memory: z.int().describe("Memory for runs, in MiB."),
    version: z.string().nullable().describe("job-runner version."),
    hostId: z
      .string()
      .nullable()
      .describe("Host it runs on."),
    createdAt: z.string().describe("Registered at (ISO 8601)."),
    lastSeenAt: z.string().describe("Last claim at (ISO 8601)."),
  })
  .openapi("Runner");


export const RegisterSchema = z
  .object({
    name: z.string().trim().min(1).max(200).describe("Display name; not unique."),
    labels: Labels.default({}),
    slots: z.int().min(1).max(64).describe("Runs at once."),
    memory: z.int().min(16).max(1_048_576).describe("Memory for runs, in MiB."),
    version: z.string().max(100).nullable().default(null).describe("job-runner version."),
    hostId: HostId.nullable().default(null),
  })
  .openapi("RegisterRunnerInput");

export const RegisteredSchema = z
  .object({
    runner: RunnerSchema.describe("The new runner."),
    token: z.string().describe("Its own token, `<id>.<secret>`. Shown only once."),
  })
  .openapi("RegisterRunnerResponse");

export const ClaimRequestSchema = z
  .object({
    labels: Labels.optional().describe("Labels now. Default: as registered."),
    can: z
      .array(z.enum(CAPABILITIES))
      .max(10)
      .default([])
      .describe(
        "Extra kinds of run it takes: `routine`, `host`.",
      ),
    hostId: HostId.optional().describe("Host it runs on now."),
    free: z
      .object({
        slots: z.int().min(0).describe("Free slots."),
        memory: z.int().min(0).describe("Free memory in MiB."),
      })
      .describe("Free capacity now."),
  })
  .openapi("ClaimRunInput");

export const ClaimSchema = z
  .object({
    run: RunSchema.describe("The claimed run."),
    memory: z.int().describe("Memory to reserve, in MiB."),
    lease: z.int().describe("Seconds between check-ins before the run fails."),
  })
  .openapi("ClaimRunResponse");

export const AppendedSchema = z
  .object({
    size: z.int().describe("Log size: where the next append starts."),
    canceled: z.boolean().describe("Cancel asked for: stop and complete as `canceled`."),
    leaseExpiresAt: z.string().describe("Lease end (ISO 8601)."),
  })
  .openapi("AppendRunLogResponse");

export const ReportSchema = z
  .object({
    state: z.enum(["succeeded", "failed", "canceled"]).describe("How it ended."),
    exit: z.int().nullable().describe("Exit code, if it ran."),
    duration: z.number().min(0).describe("Seconds from claim to end."),
    reason: z.string().trim().min(1).max(2000).nullable().default(null).describe("Why, if not plain (e.g. `timed out after 600s`)."),
  })
  .openapi("CompleteRunInput");

const RunnerIdParam = z.object({ id: z.string().uuid().describe("The runner's id.").openapi({ param: { name: "id", in: "path" } }) });
const runnerAuth = { security: [{ runnerAuth: [] }], tags: ["Runner protocol"] };
const RUNNER_FAILS = {
  400: fails(400, "The request failed validation."),
  401: fails(401, "The bearer token is not a runner's own."),
  403: fails(403, "The run is another runner's, or the path names another runner."),
};

export const registerRoute = createRoute({
  security: [{ bearerAuth: [] }],
  tags: ["Runner protocol"],
  method: "post",
  path: "/runners",
  operationId: "RegisterRunner",
  summary: "Register a runner",
  description: "Takes the registration token. Returns the runner's own token, once.",
  request: { body: json(RegisterSchema, "What the runner is and has.") },
  responses: { 201: json(RegisteredSchema, "Registered."), ...FAILS },
});

export const runnersRoute = createRoute({
  ...secured,
  tags: ["Runners"],
  method: "get",
  path: "/runners",
  operationId: "ListRunners",
  summary: "List runners",
  responses: {
    200: json(
      z.object({ runners: z.array(RunnerSchema).describe("Runners, most recently seen first.") }).openapi("ListRunnersResponse"),
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
  summary: "Claim a run",
  description: "Takes the oldest pending run that fits this runner and marks it `running`. 204 if none fits.",
  request: { params: RunnerIdParam, body: json(ClaimRequestSchema, "What the runner can take on.") },
  responses: { 200: json(ClaimSchema, "A run, now running here."), 204: { description: "No pending run fits." }, ...RUNNER_FAILS },
});

export const InvalidRangeSchema = ErrorSchema.extend({
  size: z.int().describe("Log size: resend from here."),
}).openapi("InvalidRangeError");

export const appendRoute = createRoute({
  ...runnerAuth,
  method: "patch",
  path: "/runs/{id}/log",
  operationId: "AppendRunLog",
  summary: "Append to a log",
  description: "Appends bytes at the log's end (`Content-Range: bytes S-E/*`) and renews the lease; an empty body only renews. Max 256 KiB per call, 64 MiB per run.",
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
  summary: "Put run limits",
  description: "Records the memory, timeout and stall limit a run actually got, once its runner has read `jobs.toml`.",
  request: { params: IdParam, body: json(RunsWithSchema, "Its memory, timeout and stall limit.") },
  responses: { 200: json(RunSchema, "The run, with `runsWith`."), 409: fails(409, "It is not running."), ...RUNNER_FAILS, ...MISSING },
});

export const reportRoute = createRoute({
  ...runnerAuth,
  method: "put",
  path: "/runs/{id}",
  operationId: "CompleteRun",
  summary: "Complete a run",
  description: "Records how a run ended. Retrying with the same result is safe.",
  request: { params: IdParam, body: json(ReportSchema, "How it ended.") },
  responses: { 200: json(RunSchema, "The run, ended."), 409: fails(409, "It is not running, or ended otherwise."), ...RUNNER_FAILS, ...MISSING },
});
