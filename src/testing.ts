import { accepted, admittedMemory, assigned, due, LEASE_SECONDS, schedule, type Resources, type Run } from "./domain.ts";
import type { Store } from "./store.ts";

/**
 * For tests: starts on host `id` the first queued run that fits `free`, as
 * the scheduler's assignment and the host's accept would, and answers it as
 * a host is handed it; null if none fits.
 */
export function startNext(store: Store, id: string, free: Resources = { cpu: 1, memory: 2048, gpu: 0 }): { run: Run; memory: number; lease: number } | null {
  const host = store.host(id);
  if (!host) throw new Error(`no host ${id}`);
  const [placed] = schedule(
    store.pending().filter((r) => due(r)),
    [{ id, name: host.name, features: host.features, os: host.os, arch: host.arch, free, gpuMemory: host.capacity.gpuMemory }],
  );
  if (!placed) return null;
  const run = accepted(assigned(placed.run, id), id);
  store.update(run, placed.run.updatedAt);
  return { run, memory: admittedMemory(run), lease: LEASE_SECONDS };
}
