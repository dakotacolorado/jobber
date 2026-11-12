import { lapsed, now, RequestError } from "./domain.ts";
import type { Store } from "./store.ts";

/** Fails every running run whose lease has passed; answers how many. A run renewed meanwhile is left running. */
export function sweep(store: Store, at = now()): number {
  let failed = 0;
  for (const run of store.running()) {
    const next = lapsed(run, at);
    if (!next) continue;
    try {
      store.update(next, run.updatedAt);
      failed++;
    } catch (err) {
      if (!(err instanceof RequestError && err.status === 409)) throw err;
    }
  }
  return failed;
}

/** Seconds between sweeps: a lapsed lease is failed within a minute of lapsing. */
export const SWEEP_SECONDS = 60;

/** Seconds between prunes of logs past `LOG_DAYS`. */
export const PRUNE_SECONDS = 3600;

/**
 * Sweeps every `SWEEP_SECONDS` and prunes old logs every `PRUNE_SECONDS`, from
 * now until the answer is called; a failed tick is logged and the next tried.
 */
export function startTimers(store: Store, log: (line: string) => void = console.log): () => void {
  const guard = (what: string, tick: () => number) => () => {
    try {
      const n = tick();
      if (n) log(JSON.stringify({ [what]: n }));
    } catch (err) {
      log(JSON.stringify({ [what]: "failed", error: (err as Error).message }));
    }
  };
  const sweeping = setInterval(guard("lapsed", () => sweep(store)), SWEEP_SECONDS * 1000);
  const pruning = setInterval(guard("pruned", () => store.pruneLogs(now())), PRUNE_SECONDS * 1000);
  sweeping.unref();
  pruning.unref();
  return () => {
    clearInterval(sweeping);
    clearInterval(pruning);
  };
}
