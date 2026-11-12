import { randomUUID } from "node:crypto";

/**
 * A **job** is a `[jobs.<name>]` in a repo's `jobs.toml`; a **run** is one
 * execution of it, at one commit, by a runner that claims it.
 */

/** `owner/name` on GitHub. */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A full commit sha, so a run names exactly one tree. */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** A `[jobs.<name>]` table in the repo's `jobs.toml`. */
export const JOB_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A label key or value, as Kubernetes allows them (without the `/` prefix form). */
export const LABEL_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;

/**
 * `pending` until a runner claims it, `running` on that runner, then how it
 * ended. A run never leaves an ended state; running the job again is a new run.
 */
export const STATES = ["pending", "running", "succeeded", "failed", "canceled"] as const;

export type State = (typeof STATES)[number];

export const ENDED: readonly State[] = ["succeeded", "failed", "canceled"];

/** What a run is admitted with when its submitter set no memory: a runner reserves this much for it. */
export const DEFAULT_MEMORY_MIB = 1024;

export interface Limits {
  /** MiB. Null: `jobs.toml`'s, which may not exceed what the run was admitted with (`DEFAULT_MEMORY_MIB`). */
  memory: number | null;
  /** Seconds. Null: `jobs.toml`'s. */
  timeout: number | null;
}

/** What its runner runs a run with, once it has read `jobs.toml`: the submitter's limits, else the job's, else its defaults. */
export interface RunsWith {
  /** MiB. */
  memory: number;
  /** Seconds before the runner stops it and it fails. */
  timeout: number;
  /** Seconds without progress (output, CPU or network) before the runner ends it as stalled; null when it never does. */
  stall: number | null;
}

/** What a run was for: the batch, change, item or worker that asked for it. */
export const FOR_KINDS = ["batch", "change", "item", "worker"] as const;

export type ForKind = (typeof FOR_KINDS)[number];

export interface For {
  kind: ForKind;
  id: string;
}

/** An id a run may be for: no spaces, so `<kind>:<id>` reads back as one. */
export const FOR_ID_PATTERN = /^\S{1,200}$/;

/** `<kind>:<id>`, as `?for=` takes it and the store keys it. */
export const forKey = (f: For) => `${f.kind}:${f.id}`;

export function parseFor(text: string): For {
  const at = text.indexOf(":");
  const kind = text.slice(0, at) as ForKind;
  const id = text.slice(at + 1);
  if (at < 0 || !FOR_KINDS.includes(kind) || !FOR_ID_PATTERN.test(id)) {
    throw new RequestError(`for must be <kind>:<id>, kind one of ${FOR_KINDS.join(", ")}`, 400);
  }
  return { kind, id };
}

/** A routine's directory in its repo: `/`-separated names, none `.` or `..`, as `dakotacolorado/honed`. */
export const ROUTINE_DIR_PATTERN = /^(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+(\/(?!\.{1,2}(\/|$))[A-Za-z0-9_.-]+)*$/;

/**
 * Where a routine job's steps live: `dir` in `repo` at `commit`, whose `jobs.toml` names the job.
 * The run's own `repo` and `commit` are then its target, the package the steps run against.
 */
export interface Routine {
  repo: string;
  commit: string;
  dir: string;
}

/** What a runner says it can run, beyond a job in a repo's own `jobs.toml`. */
export const CAPABILITIES = ["routine", "host"] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface RunDraft {
  /** The repo checked out at `/work`: with a routine, its target package; without, also where `jobs.toml` is read. */
  repo: string;
  commit: string;
  /** The job this is a run of. */
  job: string;
  /** Null: `job` is in `repo`'s own `jobs.toml`. */
  routine: Routine | null;
  /** The machine it must run on, as a runner's `hostId`, on the host itself rather than in a container; null: any that fits. */
  host: string | null;
  args: string[];
  limits: Limits;
  labels: Record<string, string>;
  /** What it was for; null when its submitter did not say. */
  for: For | null;
}

export interface Run extends RunDraft {
  id: string;
  state: State;
  /** Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout. */
  reason: string | null;
  /** Set by `POST /runs/{id}/cancel` on a running run, for its runner to stop it. */
  cancelRequested: boolean;
  runner: string | null;
  /** What its runner runs it with; null until a runner says, as one that predates it never does. */
  runsWith: RunsWith | null;
  exit: number | null;
  /** Seconds it ran, as its runner reported. */
  duration: number | null;
  /** Bytes of log stored: the offset the next append must start at. */
  logSize: number;
  submittedBy: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** A running run not renewed by then is failed by the sweep. */
  leaseExpiresAt: string | null;
}

export class RequestError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 416;

  constructor(message: string, status: RequestError["status"]) {
    super(message);
    this.status = status;
  }
}

export const now = () => new Date().toISOString();

/**
 * A write's time, always after the run's last: the store refuses a write whose
 * base `updatedAt` has moved, so two writes in one millisecond must not share one.
 */
export const stamp = (run: Pick<Run, "updatedAt">, at = now()) =>
  at > run.updatedAt ? at : new Date(Date.parse(run.updatedAt) + 1).toISOString();

export const newId = () => randomUUID();

/** The memory a runner reserves for the run when it claims it. */
export const admittedMemory = (run: Pick<Run, "limits">) => run.limits.memory ?? DEFAULT_MEMORY_MIB;

export function submitted(draft: RunDraft, by: string | null, at = now()): Run {
  return {
    ...draft,
    id: newId(),
    state: "pending",
    reason: null,
    cancelRequested: false,
    runner: null,
    runsWith: null,
    exit: null,
    duration: null,
    logSize: 0,
    submittedBy: by,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    endedAt: null,
    leaseExpiresAt: null,
  };
}

/** A pending run ends `canceled` at once; a running one is marked for its runner to stop. */
export function canceled(run: Run, when = now()): Run {
  const at = stamp(run, when);
  if (ENDED.includes(run.state)) throw new RequestError(`run ${run.id} already ended ${run.state}`, 409);
  if (run.state === "pending") {
    return { ...run, state: "canceled", reason: "canceled before it started", cancelRequested: true, updatedAt: at, endedAt: at };
  }
  return { ...run, cancelRequested: true, updatedAt: at };
}

/** Seconds a running run lives without a log append: a runner renews it at least every 15s. */
export const LEASE_SECONDS = 60;

export const leaseFrom = (at: string) => new Date(Date.parse(at) + LEASE_SECONDS * 1000).toISOString();

/** Most one log append may carry. */
export const APPEND_MAX = 256 * 1024;

/** Most log a run may keep: past it, appends are refused with 413 and the runner stops sending. */
export const LOG_MAX = 64 * 1024 * 1024;

/** Days a run's log is kept after it is written; the run itself stays. */
export const LOG_DAYS = 90;

export interface Runner {
  id: string;
  name: string;
  labels: Record<string, string>;
  /** Runs it runs at once, and MiB it has for them, as it registered. */
  slots: number;
  memory: number;
  version: string | null;
  /** The machine it runs on, the same as that machine's worker-host's `host_id`; null until it says. */
  hostId: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface Free {
  slots: number;
  memory: number;
}

/** Every label the run asks for, the runner has with that value. */
export const labelsFit = (wanted: Record<string, string>, has: Record<string, string>) =>
  Object.entries(wanted).every(([k, v]) => has[k] === v);

/** What a runner must say it can do to run it: a runner that predates routines would read the target's own `jobs.toml`. */
export const needs = (run: Pick<Run, "routine" | "host">): Capability[] => [
  ...(run.routine ? (["routine"] as const) : []),
  ...(run.host !== null ? (["host"] as const) : []),
];

/** What a claiming runner is and has. */
export interface Claimant {
  labels: Record<string, string>;
  free: Free;
  can: readonly Capability[];
  /** The machine it is on; null when it has never said. */
  hostId: string | null;
}

/** The run may run on this runner: pending, its slot, memory and labels fit, the runner can run it, and it is on the run's host if it names one. */
export const fits = (run: Run, runner: Claimant) =>
  run.state === "pending" &&
  runner.free.slots >= 1 &&
  admittedMemory(run) <= runner.free.memory &&
  labelsFit(run.labels, runner.labels) &&
  needs(run).every((c) => runner.can.includes(c)) &&
  (run.host === null || run.host === runner.hostId);

export function claimed(run: Run, runner: string, when = now()): Run {
  if (run.state !== "pending") throw new RequestError(`run ${run.id} is ${run.state}, not pending`, 409);
  const at = stamp(run, when);
  return { ...run, state: "running", runner, startedAt: at, updatedAt: at, leaseExpiresAt: leaseFrom(at) };
}

/** Only the run's own runner writes to it, and only while it runs. */
export function ownRunning(run: Run, runner: string): void {
  if (run.runner !== runner) throw new RequestError(`run ${run.id} is not this runner's`, 403);
  if (run.state !== "running") throw new RequestError(`run ${run.id} is ${run.state}, not running${run.reason ? `: ${run.reason}` : ""}`, 409);
}

/**
 * Where an append of `length` bytes from `start` lands. Anything but the log's
 * current end is refused with 416, so a runner that lost a reply resends from `logSize`.
 */
export function appendAt(run: Run, start: number, length: number): number {
  if (length > APPEND_MAX) throw new RequestError(`an append carries at most ${APPEND_MAX} bytes`, 413);
  if (start !== run.logSize) throw new RequestError(`the log is ${run.logSize} bytes: append from ${run.logSize}, not ${start}`, 416);
  if (start + length > LOG_MAX) throw new RequestError(`a run's log is at most ${LOG_MAX} bytes`, 413);
  return start + length;
}

export const FINAL_STATES = ["succeeded", "failed", "canceled"] as const;

export interface Final {
  state: (typeof FINAL_STATES)[number];
  exit: number | null;
  duration: number;
  reason: string | null;
}

export function finished(run: Run, final: Final, when = now()): Run {
  const at = stamp(run, when);
  const reason = final.reason ?? (final.state === "canceled" && run.cancelRequested ? "canceled while running" : null);
  return { ...run, state: final.state, exit: final.exit, duration: final.duration, reason, updatedAt: at, endedAt: at, leaseExpiresAt: null };
}

/** A report that repeats how the run already ended, as a runner retrying a lost reply sends. */
export const sameEnd = (run: Run, final: Final) => run.state === final.state && run.exit === final.exit;

/** A running run whose lease has passed ends `failed`: its runner went away. */
export function lapsed(run: Run, when = now()): Run | null {
  if (run.state !== "running" || !run.leaseExpiresAt || run.leaseExpiresAt > when) return null;
  const at = stamp(run, when);
  return {
    ...run,
    state: "failed",
    reason: `lease lapsed: no log append from runner ${run.runner} since ${new Date(Date.parse(run.leaseExpiresAt) - LEASE_SECONDS * 1000).toISOString()}`,
    updatedAt: at,
    endedAt: at,
    leaseExpiresAt: null,
  };
}
