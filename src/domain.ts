import { randomUUID } from "node:crypto";

/**
 * A **job** is a `[jobs.<name>]` in a repo's `jobs.toml`; a **run** is one
 * execution of it, at one commit, on a **host** of the fleet the scheduler places it on.
 */

/** `owner/name` on GitHub. */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A full commit sha, so a run names exactly one tree. */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** A `[jobs.<name>]` table in the repo's `jobs.toml`. */
export const JOB_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** A label key or value: letters, digits, `_`, `.` and `-`, starting and ending with a letter or digit. */
export const LABEL_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;

/**
 * `pending` in the queue, `assigned` once the scheduler places it on a host,
 * `running` once that host takes it, then how it ended. An
 * assignment the host does not take in time goes back to `pending`. A run
 * never leaves an ended state; running the job again is a new run.
 */
export const STATES = ["pending", "assigned", "running", "succeeded", "failed", "canceled"] as const;

export type State = (typeof STATES)[number];

export const ENDED: readonly State[] = ["succeeded", "failed", "canceled"];

/** Memory a run is admitted with when its requirements set none: its host reserves this much for it. */
export const DEFAULT_MEMORY_MIB = 1024;

/** Operating systems and architectures, as a host reports them (Rust's `std::env::consts`). */
export const OSES = ["linux", "macos", "windows"] as const;
export const ARCHES = ["x86_64", "aarch64"] as const;

export type Os = (typeof OSES)[number];
export type Arch = (typeof ARCHES)[number];

/** What a run needs, all in one place. Null: anything, or for `memory` and `timeout`, the job's own in `jobs.toml`. */
export interface Requirements {
  os: Os | null;
  arch: Arch | null;
  /** MiB. Null: `jobs.toml`'s, admitted at `DEFAULT_MEMORY_MIB`. */
  memory: number | null;
  /** Seconds. Null: `jobs.toml`'s. */
  timeout: number | null;
}

export const NO_REQUIREMENTS: Requirements = { os: null, arch: null, memory: null, timeout: null };

export type Labels = Record<string, string>;

/** `key=value`, as `ListRuns?label=` takes it. */
export function parseLabel(text: string): [string, string] {
  const at = text.indexOf("=");
  const key = text.slice(0, at);
  const value = text.slice(at + 1);
  if (at < 1 || !LABEL_PATTERN.test(key) || !LABEL_PATTERN.test(value)) throw new RequestError(`label must be key=value, not ${text}`, 400);
  return [key, value];
}

export interface RunDraft {
  repo: string;
  commit: string;
  /** The `[jobs.<name>]` this is a run of. */
  job: string;
  args: string[];
  requirements: Requirements;
  /** What the run is, for finding it again: who asked, what for. */
  labels: Labels;
  /** Higher is placed first; runs of one priority go oldest first. */
  priority: number;
  /** How often a failed attempt is tried again, and after how long. */
  retry: Retry;
}

/**
 * A failed attempt (not a canceled one) is tried again up to `limit` times,
 * the nth retry `backoff` × 2^(n-1) seconds after the failure, at most
 * `BACKOFF_MAX_SECONDS`.
 */
export interface Retry {
  limit: number;
  /** Seconds. */
  backoff: number;
}

export const NO_RETRY: Retry = { limit: 0, backoff: 10 };
export const RETRY_LIMIT_MAX = 10;
export const BACKOFF_MAX_SECONDS = 3600;

/** One try of a run that has ended and been tried again: where it ran, how it ended, and its log's size. */
export interface Attempt {
  attempt: number;
  host: string | null;
  state: (typeof FINAL_STATES)[number];
  exit: number | null;
  reason: string | null;
  duration: number | null;
  logSize: number;
  startedAt: string | null;
  endedAt: string;
}

export interface Run extends RunDraft {
  id: string;
  state: State;
  /** Why it is in its state, when that is not plain: a cancel, a lapsed lease, a timeout. */
  reason: string | null;
  /** Set by `CancelRun` on a running run, for its host to stop it. */
  cancelRequested: boolean;
  /** Which try this is, from 1: a host's writes name the attempt it was started on, and one naming another is refused. */
  attempt: number;
  /** Its earlier attempts, oldest first; the run's own fields are its latest. */
  attempts: Attempt[];
  /** A retry waits in the queue until then; null for a first attempt. */
  retryAt: string | null;
  /** The host it is assigned to or ran on. */
  host: string | null;
  /** When the scheduler placed it on `host`: it goes back to the queue unless taken within `ASSIGN_SECONDS`. */
  assignedAt: string | null;
  exit: number | null;
  /** Seconds it ran, as its host reported. */
  duration: number | null;
  /** Bytes of log stored: the offset the next append must start at. */
  logSize: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** A running run not renewed by its host's heartbeat by then is failed by the sweep. */
  leaseExpiresAt: string | null;
}

export class RequestError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 416 | 426;

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

/** A run's priority is a whole number from `PRIORITY_MIN` to `PRIORITY_MAX`, 0 unless given. */
export const PRIORITY_MIN = -1000;
export const PRIORITY_MAX = 1000;

/** The order runs leave the queue: higher priority first, then older, then by id so the order is total. */
export const queueOrder = (a: Run, b: Run) =>
  b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** A run not yet ended takes a new priority; an ended one has left the queue for good. */
export function reprioritized(run: Run, priority: number, when = now()): Run {
  if (ENDED.includes(run.state)) throw new RequestError(`run ${run.id} already ended ${run.state}`, 409);
  return { ...run, priority, updatedAt: stamp(run, when) };
}

/** The memory a host reserves for the run when it takes it. */
export const admittedMemory = (run: Pick<Run, "requirements">) => run.requirements.memory ?? DEFAULT_MEMORY_MIB;

export function submitted(draft: RunDraft, at = now()): Run {
  return {
    ...draft,
    id: newId(),
    state: "pending",
    reason: null,
    cancelRequested: false,
    attempt: 1,
    attempts: [],
    retryAt: null,
    host: null,
    assignedAt: null,
    exit: null,
    duration: null,
    logSize: 0,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    endedAt: null,
    leaseExpiresAt: null,
  };
}

/** A run not yet started (pending or assigned) ends `canceled` at once; a running one is marked for its host to stop. */
export function canceled(run: Run, when = now()): Run {
  const at = stamp(run, when);
  if (ENDED.includes(run.state)) throw new RequestError(`run ${run.id} already ended ${run.state}`, 409);
  if (run.state === "pending" || run.state === "assigned") {
    return { ...run, state: "canceled", reason: "canceled before it started", cancelRequested: true, updatedAt: at, endedAt: at };
  }
  return { ...run, cancelRequested: true, updatedAt: at };
}

/** Seconds a running run lives without its host's heartbeat: a host sends one at least every 15s. */
export const LEASE_SECONDS = 60;

export const leaseFrom = (at: string) => new Date(Date.parse(at) + LEASE_SECONDS * 1000).toISOString();

/** Most one log append may carry. */
export const APPEND_MAX = 256 * 1024;

/** Most log a run may keep: past it, appends are refused with 413 and the host stops sending. */
export const LOG_MAX = 64 * 1024 * 1024;

/** Days a run's log is kept after it is written; the run itself stays. */
export const LOG_DAYS = 90;

export interface Free {
  slots: number;
  /** MiB. */
  memory: number;
}

/** A host's health, as its last heartbeat said. */
export interface Metrics {
  /** 1-minute load average. */
  cpuLoad: number;
  /** MiB. */
  memoryUsed: number;
  memoryTotal: number;
  /** MiB free on the disk runs use. */
  diskFree: number;
}

export interface Host {
  id: string;
  /** Unique: registering it again keeps its id. */
  name: string;
  os: Os;
  arch: Arch;
  /** Runs it runs at once, and MiB it has for them. */
  slots: number;
  memory: number;
  labels: Labels;
  version: string | null;
  /** As its last heartbeat said; null until one does. */
  free: Free | null;
  metrics: Metrics | null;
  createdAt: string;
  lastSeenAt: string;
}

/** The run may run on this host: pending, a slot and its memory free, and its os and arch, if it names them, the host's. */
export const fits = (run: Run, host: Pick<Candidate, "os" | "arch" | "free">) =>
  run.state === "pending" &&
  host.free.slots >= 1 &&
  admittedMemory(run) <= host.free.memory &&
  (run.requirements.os === null || run.requirements.os === host.os) &&
  (run.requirements.arch === null || run.requirements.arch === host.arch);

/** Seconds an assigned run waits for its host to take it before it goes back to the queue. */
export const ASSIGN_SECONDS = 30;

/** Seconds since a host's last heartbeat past which the scheduler places nothing on it. */
export const FRESH_SECONDS = 30;

/** The scheduler places a pending run on `host`. */
export function assigned(run: Run, host: string, when = now()): Run {
  if (run.state !== "pending") throw new RequestError(`run ${run.id} is ${run.state}, not pending`, 409);
  const at = stamp(run, when);
  return { ...run, state: "assigned", host, assignedAt: at, updatedAt: at };
}

/**
 * The host takes the run assigned to it: `running` there from now. Taking a
 * run already running there is answered as it is, so a host repeating itself
 * after a lost answer starts nothing twice; anything else is refused with 409.
 */
export function accepted(run: Run, host: string, when = now()): Run {
  if (run.state === "running" && run.host === host) return run;
  if (run.state !== "assigned" || run.host !== host) throw new RequestError(`run ${run.id} is ${run.state}${run.host === host ? "" : " and not this host's"}, not assigned here`, 409);
  const at = stamp(run, when);
  return { ...run, state: "running", startedAt: at, updatedAt: at, leaseExpiresAt: leaseFrom(at) };
}

/** An assigned run back in the queue, as it was before it was placed: its host declined it, or did not take it in time. */
export function unassigned(run: Run, when = now()): Run {
  if (run.state !== "assigned") throw new RequestError(`run ${run.id} is ${run.state}, not assigned`, 409);
  return { ...run, state: "pending", host: null, assignedAt: null, updatedAt: stamp(run, when) };
}

/** An assignment not taken within `ASSIGN_SECONDS`, back in the queue; null for any other run. */
export function expired(run: Run, when = now()): Run | null {
  if (run.state !== "assigned" || !run.assignedAt || Date.parse(run.assignedAt) + ASSIGN_SECONDS * 1000 > Date.parse(when)) return null;
  return unassigned(run, when);
}

/** A host the scheduler may place runs on: what it is, and what it has free for them now. */
export interface Candidate {
  id: string;
  os: Os;
  arch: Arch;
  free: Free;
}

/**
 * What `host` has free for new runs: the least of what it last reported and
 * its capacity less the runs assigned or running there, since a report can
 * predate the scheduler's last assignment and the scheduler cannot see what
 * else the host holds.
 */
export function freeOn(host: Pick<Host, "id" | "slots" | "memory" | "free">, runs: Run[]): Free {
  const mine = runs.filter((r) => r.host === host.id && (r.state === "assigned" || r.state === "running"));
  const slots = host.slots - mine.length;
  const memory = host.memory - mine.reduce((sum, r) => sum + admittedMemory(r), 0);
  const reported = host.free ?? { slots, memory };
  return { slots: Math.max(0, Math.min(slots, reported.slots)), memory: Math.max(0, Math.min(memory, reported.memory)) };
}

/** A host fit to be given work: it heartbeated within `FRESH_SECONDS`. */
export const fresh = (host: Pick<Host, "lastSeenAt">, when = now()) => Date.parse(when) - Date.parse(host.lastSeenAt) <= FRESH_SECONDS * 1000;

/**
 * Places queued runs on hosts: each run, highest priority first and then
 * oldest, on the fitting host with the most slots free (then memory, then
 * id), whose free capacity it then takes. A run no host fits is passed over,
 * not waited for, so one large run does not hold up the small ones behind it.
 */
export function schedule(queue: Run[], hosts: Candidate[]): { run: Run; host: string }[] {
  const left = hosts.map((h) => ({ ...h, free: { ...h.free } }));
  const placed: { run: Run; host: string }[] = [];
  for (const run of [...queue].sort(queueOrder)) {
    const fitting = left.filter((h) => fits(run, h));
    if (!fitting.length) continue;
    const best = fitting.reduce((a, b) => (b.free.slots > a.free.slots || (b.free.slots === a.free.slots && (b.free.memory > a.free.memory || (b.free.memory === a.free.memory && b.id < a.id))) ? b : a));
    best.free.slots -= 1;
    best.free.memory -= admittedMemory(run);
    placed.push({ run, host: best.id });
  }
  return placed;
}

/** Only the run's own host writes to it, only while it runs, and, when it names one, only to the attempt it runs. */
export function ownRunning(run: Run, host: string, attempt?: number): void {
  const movedOn = (attempt !== undefined && attempt !== run.attempt) || (run.host !== host && run.attempts.some((a) => a.host === host));
  if (movedOn) throw new RequestError(`run ${run.id} is on attempt ${run.attempt}, not ${attempt ?? "this host's"}`, 409);
  if (run.host !== host) throw new RequestError(`run ${run.id} is not this host's`, 403);
  if (run.state !== "running") throw new RequestError(`run ${run.id} is ${run.state}, not running${run.reason ? `: ${run.reason}` : ""}`, 409);
}

/**
 * Where an append of `length` bytes from `start` lands. Anything but the log's
 * current end is refused with 416, so a host that lost a reply resends from `logSize`.
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
  return retried({ ...run, state: final.state, exit: final.exit, duration: final.duration, reason, updatedAt: at, endedAt: at, leaseExpiresAt: null });
}

/** A completion that repeats how the run, or one attempt of it, already ended, as a host retrying a lost reply sends. */
export const sameEnd = (ended: Pick<Run, "state" | "exit">, final: Final) => ended.state === final.state && ended.exit === final.exit;

/** Seconds before the retry after attempt `attempt` failed. */
export const backoffAfter = (retry: Retry, attempt: number) => Math.min(BACKOFF_MAX_SECONDS, retry.backoff * 2 ** (attempt - 1));

/**
 * A run that has just ended `failed`, not by a cancel, with retries left, as
 * its next attempt: back in the queue from `backoffAfter` its failure, the
 * failed attempt kept in `attempts`. Any other run as it is.
 */
export function retried(run: Run): Run {
  if (run.state !== "failed" || run.cancelRequested || run.attempt > run.retry.limit) return run;
  const failedAt = run.endedAt ?? run.updatedAt;
  const retryAt = new Date(Date.parse(failedAt) + backoffAfter(run.retry, run.attempt) * 1000).toISOString();
  const past: Attempt = {
    attempt: run.attempt,
    host: run.host,
    state: run.state,
    exit: run.exit,
    reason: run.reason,
    duration: run.duration,
    logSize: run.logSize,
    startedAt: run.startedAt,
    endedAt: failedAt,
  };
  return {
    ...run,
    state: "pending",
    reason: `attempt ${run.attempt} failed${run.exit !== null ? ` with exit ${run.exit}` : ""}${run.reason ? `: ${run.reason}` : ""}; retry ${run.attempt} of ${run.retry.limit} from ${retryAt}`,
    attempt: run.attempt + 1,
    attempts: [...run.attempts, past],
    retryAt,
    host: null,
    assignedAt: null,
    exit: null,
    duration: null,
    logSize: 0,
    startedAt: null,
    endedAt: null,
    leaseExpiresAt: null,
  };
}

/** A pending run may be placed now: it is no retry waiting out its backoff. */
export const due = (run: Pick<Run, "retryAt">, when = now()) => run.retryAt === null || run.retryAt <= when;

/** Attempt `n` of `run`, earlier or its latest, as an attempt: null if it has none such. */
export function attemptOf(run: Run, n: number): Pick<Attempt, "attempt" | "state" | "logSize"> | null {
  if (n === run.attempt) return { attempt: n, state: run.state as Attempt["state"], logSize: run.logSize };
  return run.attempts.find((a) => a.attempt === n) ?? null;
}

/** A running run whose lease has passed ends `failed`: its host went away. */
export function lapsed(run: Run, when = now()): Run | null {
  if (run.state !== "running" || !run.leaseExpiresAt || run.leaseExpiresAt > when) return null;
  const at = stamp(run, when);
  return retried({
    ...run,
    state: "failed",
    reason: `lease lapsed: no heartbeat from host ${run.host} since ${new Date(Date.parse(run.leaseExpiresAt) - LEASE_SECONDS * 1000).toISOString()}`,
    updatedAt: at,
    endedAt: at,
    leaseExpiresAt: null,
  });
}
