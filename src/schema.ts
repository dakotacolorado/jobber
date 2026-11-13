import { createRoute, z } from "@hono/zod-openapi";
import { ARCHES, BACKOFF_MAX_SECONDS, DEFAULT_CPU, DEFAULT_MEMORY_MIB, COMMIT_PATTERN, NO_RETRY, RETRY_LIMIT_MAX, JOB_NAME_PATTERN, LABEL_PATTERN, OSES, PRIORITY_MAX, PRIORITY_MIN, REPO_PATTERN, STATES } from "./domain.ts";

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
  .describe("`pending` → `assigned` → `running` → `succeeded`, `failed` or `canceled`. An assignment not taken goes back to `pending`.")
  .openapi({ example: "pending" });
const Os = z.enum(OSES).describe("Operating system.");
const Arch = z.enum(ARCHES).describe("CPU architecture.");

export const Priority = z
  .int()
  .min(PRIORITY_MIN)
  .max(PRIORITY_MAX)
  .describe(`Higher is placed first; equal ones oldest first. ${PRIORITY_MIN} to ${PRIORITY_MAX}.`)
  .openapi({ example: 10 });

const Label = z.string().regex(LABEL_PATTERN);
export const Labels = z
  .record(Label, Label)
  .refine((labels) => Object.keys(labels).length <= 20, "at most 20 labels")
  .describe("Free-form key-value labels.")
  .openapi({ example: { item: "28af81bc", by: "agent-7" } });

/** CPUs, to the thousandth. No host has more than this. */
const Cpu = z.number().max(65_536);

export const RequirementsSchema = z
  .object({
    os: Os.nullable().default(null).describe("Operating system it needs. Default: any."),
    arch: Arch.nullable().default(null).describe("CPU architecture it needs. Default: any."),
    cpu: Cpu.min(0.001).nullable().default(null).describe(`CPUs, a decimal number (e.g. 0.5). Default: ${DEFAULT_CPU}.`),
    memory: z.int().min(16).max(1_048_576).nullable().default(null).describe(`Memory in MiB. Default: \`jobs.toml\`'s, else ${DEFAULT_MEMORY_MIB}.`),
    timeout: z.int().min(1).max(86_400).nullable().default(null).describe("Timeout in seconds. Default: `jobs.toml`'s."),
  })
  .describe("What the run needs from its host.")
  .openapi("Requirements");

export const RetrySchema = z
  .object({
    limit: z.int().min(0).max(RETRY_LIMIT_MAX).default(NO_RETRY.limit).describe(`Retries after a failed attempt, 0 to ${RETRY_LIMIT_MAX}. Default: 0.`),
    backoff: z
      .int()
      .min(1)
      .max(BACKOFF_MAX_SECONDS)
      .default(NO_RETRY.backoff)
      .describe(`Seconds before the first retry, doubling for each after, at most ${BACKOFF_MAX_SECONDS}. Default: ${NO_RETRY.backoff}.`),
  })
  .describe("Retries a failed attempt (not a canceled one).")
  .openapi("Retry");

const FinalState = z.enum(["succeeded", "failed", "canceled"]);

export const AttemptSchema = z
  .object({
    attempt: z.int().min(1).describe("Which try, from 1."),
    host: z.string().uuid().nullable().describe("Host it ran on."),
    state: FinalState.describe("How it ended."),
    exit: z.int().nullable().describe("Exit code."),
    reason: z.string().nullable().describe("Why it ended, when not plain."),
    duration: z.number().nullable().describe("Seconds it ran."),
    logSize: z.int().describe("Its log's size in bytes: read it with `GetRunLog?attempt=`."),
    startedAt: z.string().nullable().describe("Started at (ISO 8601)."),
    endedAt: z.string().describe("Ended at (ISO 8601)."),
  })
  .describe("An earlier attempt of a run.")
  .openapi("Attempt");

export const SubmitSchema = z
  .object({
    repo: Repo,
    commit: Commit,
    job: JobName,
    args: z.array(z.string().max(4000)).max(50).default([]).describe("Arguments appended to the job's command."),
    requirements: RequirementsSchema.default({ os: null, arch: null, cpu: null, memory: null, timeout: null }),
    labels: Labels.default({}).describe("Labels to find it by, e.g. what it is for and who asked."),
    priority: Priority.default(0).describe(`Higher is placed first; equal ones oldest first. ${PRIORITY_MIN} to ${PRIORITY_MAX}. Default: 0.`),
    retry: RetrySchema.default(NO_RETRY),
  })
  .openapi("SubmitRunInput");

export const RunSchema = z
  .object({
    id: z.string().uuid().describe("The run's id."),
    repo: Repo,
    commit: Commit,
    job: JobName,
    args: z.array(z.string()).describe("Arguments appended to the job's command."),
    requirements: RequirementsSchema,
    labels: Labels,
    priority: Priority,
    retry: RetrySchema,
    state: State,
    reason: z.string().nullable().describe("Why it ended, when not plain (e.g. timed out)."),
    cancelRequested: z.boolean().describe("Cancel asked for; its host will stop it."),
    attempt: z.int().min(1).describe("Which try this is, from 1: the run's other fields are this attempt's."),
    attempts: z.array(AttemptSchema).describe("Earlier attempts, oldest first."),
    retryAt: z.string().nullable().describe("A retry waits in the queue until then (ISO 8601)."),
    host: z.string().uuid().nullable().describe("Host it is assigned to or ran on."),
    assignedAt: z.string().nullable().describe("Placed on `host` at (ISO 8601), while `assigned`."),
    exit: z.int().nullable().describe("Exit code."),
    duration: z.number().nullable().describe("Seconds it ran."),
    logSize: z.int().describe("Log size in bytes."),
    createdAt: z.string().describe("Submitted at (ISO 8601)."),
    updatedAt: z.string().describe("Last changed at (ISO 8601)."),
    startedAt: z.string().nullable().describe("Started on its host at (ISO 8601)."),
    endedAt: z.string().nullable().describe("Ended at (ISO 8601)."),
    leaseExpiresAt: z.string().nullable().describe("Fails at this time unless its host's heartbeat renews it."),
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
  426: "UpgradeRequiredException",
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
  description: "Queues a run as `pending`, by `priority` then age, until a host that meets its requirements takes it. The repo isn't checked here: a missing job fails on its host.",
  request: { body: json(SubmitSchema, "What to run, what it needs, and its labels.") },
  responses: { 201: json(RunSchema, "Stored, `pending`."), ...FAILS },
});

/** `ListRuns`'s filters, which `list_runs` takes too. */
export const ListQuery = z.object({
  state: State.optional(),
  repo: Repo.optional(),
  label: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Only runs with this label, as `key=value`. Repeat to require several.")
    .openapi({ example: "item=28af81bc" }),
  limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max results. Default: 100."),
});

export const listRoute = createRoute({
  ...secured,
  method: "get",
  path: "/runs",
  operationId: "ListRuns",
  summary: "List runs",
  request: { query: ListQuery },
  responses: {
    200: json(z.object({ runs: z.array(RunSchema).describe("Runs, newest first.") }).openapi("ListRunsResponse"), "The runs."),
    ...FAILS,
  },
});

/** `ListQueue`'s query, which `list_queue` takes too. */
export const QueueQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100).describe("Max results. Default: 100."),
});

export const queueRoute = createRoute({
  ...secured,
  method: "get",
  path: "/queue",
  operationId: "ListQueue",
  summary: "List the queue",
  description:
    "The `pending` runs in the order the scheduler places them: highest `priority` first, then oldest. The first is next to go to a host that fits it; one no host fits is passed over, not waited for, and one waiting out a retry's backoff is listed with its `retryAt`. Move a run with `UpdateRunPriority`.",
  request: { query: QueueQuery },
  responses: {
    200: json(z.object({ runs: z.array(RunSchema).describe("Pending runs, next first.") }).openapi("ListQueueResponse"), "The queue."),
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
  description:
    "Reads up to 1 MiB from byte N (`Range: bytes=N-`) of the latest attempt's log, or `attempt`'s. To follow a run, poll from the last `size` until `Run-State` has ended.",
  request: {
    params: IdParam,
    query: z.object({ attempt: z.coerce.number().int().min(1).optional().describe("Which attempt's log. Default: the latest.") }),
    headers: z.object({ range: z.string().regex(/^bytes=\d+-$/).optional().describe("`bytes=N-`") }),
  },
  responses: {
    206: {
      content: { "text/plain": { schema: z.string() } },
      description: "Log bytes from N, up to 1 MiB.",
      headers: z.object({
        "content-range": z.string().describe("`bytes N-M/size`; `size` is the log's length so far."),
        "run-state": State.describe("The attempt's state: stop polling once it has ended."),
        "run-attempt": z.string().describe("Which attempt's log this is."),
      }),
    },
    416: fails(416, "N is past the end of the log."),
    ...FAILS,
    404: fails(404, "No run has that id, or it has no such attempt."),
  },
});

export const cancelRoute = createRoute({
  ...secured,
  method: "post",
  path: "/runs/{id}/cancel",
  operationId: "CancelRun",
  summary: "Cancel a run",
  description: "Ends a run not yet started (pending or assigned) now. A running one is stopped by its host within seconds.",
  request: { params: IdParam },
  responses: { 200: json(RunSchema, "The run, canceled or marked."), 409: fails(409, "It has already ended."), ...FAILS, ...MISSING },
});

export const PrioritySchema = z.object({ priority: Priority }).openapi("UpdateRunPriorityInput");

export const priorityRoute = createRoute({
  ...secured,
  method: "post",
  path: "/runs/{id}/priority",
  operationId: "UpdateRunPriority",
  summary: "Update run priority",
  description: "Moves a run not yet ended up or down the queue. A running one keeps its host.",
  request: { params: IdParam, body: json(PrioritySchema, "Its new priority.") },
  responses: { 200: json(RunSchema, "The run, at its new priority."), 409: fails(409, "It has already ended."), ...FAILS, ...MISSING },
});

// --- hosts ------------------------------------------------------------------

const CapacitySchema = z
  .object({
    cpu: Cpu.min(0.001).describe("CPUs for runs, a decimal number."),
    memory: z.int().min(16).max(1_048_576 * 64).describe("Memory for runs, in MiB."),
  })
  .describe("What the host offers runs: what it measured, less what it keeps back for the rest of the machine.")
  .openapi("Capacity");

const FreeSchema = z
  .object({
    cpu: Cpu.min(0).describe("CPUs free for runs."),
    memory: z.int().min(0).max(1_048_576 * 64).describe("Memory free for runs, in MiB."),
  })
  .describe("What the host has free for runs now: its capacity less what its runs and image builds hold.")
  .openapi("Free");

export const MetricsSchema = z
  .object({
    cpuLoad: z.number().min(0).describe("1-minute load average."),
    memoryUsed: z.int().min(0).describe("Memory in use, in MiB."),
    memoryTotal: z.int().min(0).describe("Total memory, in MiB."),
    diskFree: z.int().min(0).describe("Free disk where runs work, in MiB."),
    cpus: z.int().min(0).max(65_536).describe("CPUs the machine has, all of them; 0 if unknown."),
  })
  .describe("The host's health.")
  .openapi("Metrics");

export const HostSchema = z
  .object({
    id: z.string().uuid().describe("The host's id."),
    name: z.string().describe("Unique host name."),
    os: Os,
    arch: Arch,
    capacity: CapacitySchema,
    labels: Labels,
    version: z.string().nullable().describe("jobber-host version, as it last registered."),
    free: FreeSchema.nullable().describe("Free capacity, as last reported."),
    metrics: MetricsSchema.nullable().describe("Health, as last reported."),
    createdAt: z.string().describe("First registered at (ISO 8601)."),
    lastSeenAt: z.string().describe("Last heartbeat at (ISO 8601)."),
    connected: z.boolean().describe("Holds a connection open now: the scheduler can push runs to it."),
  })
  .openapi("Host");

export const RegisterSchema = z
  .object({
    name: z.string().trim().min(1).max(200).describe("Unique host name. Registering it again keeps its id."),
    os: Os,
    arch: Arch,
    capacity: CapacitySchema,
    labels: Labels.default({}),
    version: z.string().max(100).nullable().default(null).describe("jobber-host version."),
  })
  .openapi("RegisterHostInput");

export const RegisteredSchema = z
  .object({
    host: HostSchema.describe("The host."),
    token: z.string().describe("Its own token, `<id>.<secret>`. Shown only once."),
  })
  .openapi("RegisterHostResponse");

/** Which attempt a host's write is for: one naming another than the run's current attempt is refused with 409. */
export const AttemptQuery = z.object({
  attempt: z.coerce.number().int().min(1).optional().describe("The attempt it was started on. Refused with 409 if the run has moved on."),
});

/** Most runs one heartbeat lists: a bound on its size, which no host's capacity comes near. */
const RUNNING_MAX = 10_000;

export const HeartbeatSchema = z
  .object({
    free: FreeSchema,
    metrics: MetricsSchema,
    running: z.array(z.string().uuid()).max(RUNNING_MAX).describe("Runs it is running: their leases are renewed."),
  })
  .openapi("SendHeartbeatInput");

export const HeartbeatAnswerSchema = z
  .object({
    cancel: z.array(z.string().uuid()).describe("Of those runs, the ones to stop and complete as `canceled`."),
    ended: z.array(z.string().uuid()).describe("Of those runs, the ones no longer running on this host (e.g. failed by a lapsed lease): stop them, without completing them."),
    lease: z.int().describe("Seconds before a run fails without another heartbeat."),
  })
  .openapi("SendHeartbeatResponse");

export const AppendedSchema = z
  .object({ size: z.int().describe("Log size: where the next append starts.") })
  .openapi("AppendRunLogResponse");

export const ReportSchema = z
  .object({
    state: z.enum(["succeeded", "failed", "canceled"]).describe("How it ended."),
    exit: z.int().nullable().describe("Exit code, if it ran."),
    duration: z.number().min(0).describe("Seconds from start to end."),
    reason: z.string().trim().min(1).max(2000).nullable().default(null).describe("Why, if not plain (e.g. `timed out after 600s`)."),
  })
  .openapi("CompleteRunInput");

const HostIdParam = z.object({ id: z.string().uuid().describe("The host's id.").openapi({ param: { name: "id", in: "path" } }) });
const hostAuth = { security: [{ hostAuth: [] }], tags: ["Host protocol"] };
const HOST_FAILS = {
  400: fails(400, "The request failed validation."),
  401: fails(401, "The bearer token is not a host's own."),
  403: fails(403, "The run is another host's, or the path names another host."),
};

export const registerRoute = createRoute({
  security: [{ bearerAuth: [] }],
  tags: ["Host protocol"],
  method: "post",
  path: "/hosts",
  operationId: "RegisterHost",
  summary: "Register a host",
  description:
    "Takes the registration token. Returns the host's own token, once. Registering the same name again keeps its id, replaces its token, and updates what it is and offers: a host registers each time it starts.",
  request: { body: json(RegisterSchema, "What the host is and has.") },
  responses: { 201: json(RegisteredSchema, "Registered."), ...FAILS },
});

export const hostsRoute = createRoute({
  ...secured,
  tags: ["Hosts"],
  method: "get",
  path: "/hosts",
  operationId: "ListHosts",
  summary: "List hosts",
  responses: {
    200: json(z.object({ hosts: z.array(HostSchema).describe("Hosts, most recently seen first.") }).openapi("ListHostsResponse"), "The hosts."),
    ...FAILS,
  },
});

export const heartbeatRoute = createRoute({
  ...hostAuth,
  method: "post",
  path: "/hosts/{id}/heartbeat",
  operationId: "SendHeartbeat",
  summary: "Send a heartbeat",
  description: "Reports free capacity and health, and renews the leases of the runs it lists. Send one at least every 15 seconds.",
  request: { params: HostIdParam, body: json(HeartbeatSchema, "Free capacity, health and running runs.") },
  responses: { 200: json(HeartbeatAnswerSchema, "Leases renewed."), ...HOST_FAILS },
});

export const InvalidRangeSchema = ErrorSchema.extend({
  size: z.int().describe("Log size: resend from here."),
}).openapi("InvalidRangeError");

export const appendRoute = createRoute({
  ...hostAuth,
  method: "patch",
  path: "/runs/{id}/log",
  operationId: "AppendRunLog",
  summary: "Append to a log",
  description: "Appends bytes at the log's end (`Content-Range: bytes S-E/*`). Max 256 KiB per call, 64 MiB per run.",
  request: {
    params: IdParam,
    query: AttemptQuery,
    headers: z.object({ "content-range": z.string().regex(/^bytes \d+-\d+\/(\*|\d+)$/).describe("`bytes S-E/*`") }),
    body: { content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } }, description: "The log's next bytes." },
  },
  responses: {
    200: json(AppendedSchema, "Stored."),
    409: fails(409, "The run is not running, or not on that attempt: it ended, perhaps by its lease lapsing."),
    413: fails(413, "Over 256 KiB, or the log would pass 64 MiB."),
    416: json(InvalidRangeSchema, `${ERROR_CODES[416]}: The append does not start at the log's end: resend from \`size\`.`),
    ...HOST_FAILS,
    ...MISSING,
  },
});

export const reportRoute = createRoute({
  ...hostAuth,
  method: "put",
  path: "/runs/{id}",
  operationId: "CompleteRun",
  summary: "Complete a run",
  description: "Records how a run ended. Retrying with the same result is safe.",
  request: { params: IdParam, query: AttemptQuery, body: json(ReportSchema, "How it ended.") },
  responses: { 200: json(RunSchema, "The run, ended."), 409: fails(409, "It is not running, not on that attempt, or ended otherwise."), ...HOST_FAILS, ...MISSING },
});

// --- the host connection: what a host sends over it, as PROTOCOL.md describes ---

const RunningAttempt = z.object({ id: z.string().uuid(), attempt: z.int().min(1) });

export const HostMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heartbeat"), free: FreeSchema, metrics: MetricsSchema, running: z.array(RunningAttempt).max(RUNNING_MAX) }),
  z.object({ type: z.literal("accept"), run: z.string().uuid(), attempt: z.int().min(1) }),
  z.object({ type: z.literal("decline"), run: z.string().uuid(), attempt: z.int().min(1), reason: z.string().max(2000).default("") }),
]);

export type HostMessage = z.infer<typeof HostMessage>;

export const connectRoute = createRoute({
  ...hostAuth,
  method: "get",
  path: "/hosts/{id}/connect",
  operationId: "ConnectHost",
  summary: "Connect a host",
  description:
    "Opens the WebSocket over which jobber pushes runs to the host and the host sends heartbeats and takes them. Its messages are in `docs/PROTOCOL.md`. A request that is not an upgrade gets 426.",
  request: { params: HostIdParam },
  responses: {
    101: { description: "Switched to the WebSocket." },
    426: fails(426, "Not a WebSocket upgrade."),
    ...HOST_FAILS,
  },
});
