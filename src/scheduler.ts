import { due, expired, fresh, freeOn, healthy, now, RequestError, schedule, assigned, type Run } from "./domain.ts";
import type { Store } from "./store.ts";

/** The hosts jobber can reach now, and how it hands one a run. */
export interface Link {
  /** Ids of the hosts holding a connection open, ready for work. */
  connected(): Iterable<string>;
  /** Hands `run`, just assigned to `host`, to that host. */
  assign(host: string, run: Run): void;
  /** Tells `host` that `run`, running there, is to be stopped. */
  cancel(host: string, run: Run): void;
}

/** No host reachable: the scheduler places nothing. */
export const NO_LINK: Link = { connected: () => [], assign: () => {}, cancel: () => {} };

/**
 * Returns every assignment not taken in time to the queue, then places queued
 * runs on connected hosts that heartbeated lately, are healthy and fit them, recording each
 * assignment before handing it over. Answers what it moved. A run changed
 * meanwhile (canceled, claimed) is left as it now is.
 */
export function tick(store: Store, link: Link, at = now()): { expired: number; placed: number } {
  let back = 0;
  for (const run of store.inState("assigned")) {
    const next = expired(run, at);
    if (next && write(store, next, run)) back++;
  }
  const reachable = new Set(link.connected());
  const active = store.inState("assigned", "running");
  const candidates = store
    .hosts()
    .filter((h) => reachable.has(h.id) && fresh(h, at) && healthy(h))
    .map((h) => ({ id: h.id, name: h.name, features: h.features, os: h.os, arch: h.arch, free: freeOn(h, active), gpuMemory: h.capacity.gpuMemory }));
  let placed = 0;
  if (candidates.length) {
    for (const { run, host } of schedule(
      store.pending().filter((r) => due(r, at)),
      candidates,
    )) {
      const next = assigned(run, host, at);
      if (!write(store, next, run)) continue;
      link.assign(host, next);
      placed++;
    }
  }
  return { expired: back, placed };
}

function write(store: Store, next: Run, base: Run): boolean {
  try {
    store.update(next, base.updatedAt);
    return true;
  } catch (err) {
    if (err instanceof RequestError && err.status === 409) return false;
    throw err;
  }
}

/** Milliseconds between the scheduler's passes over the queue. */
export const SCHEDULE_MS = 1000;

/** Ticks every `SCHEDULE_MS` until the answer is called, logging what moved; a failed tick is logged and the next tried. */
export function startScheduler(store: Store, link: Link, log: (line: string) => void = console.log): () => void {
  const timer = setInterval(() => {
    try {
      const { expired, placed } = tick(store, link);
      if (expired || placed) log(JSON.stringify({ placed, expired }));
    } catch (err) {
      log(JSON.stringify({ scheduled: "failed", error: (err as Error).message }));
    }
  }, SCHEDULE_MS);
  timer.unref();
  return () => clearInterval(timer);
}
