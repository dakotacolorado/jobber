import { JobApi, type Tokens } from "./api.ts";
import { buildOf, PACKAGE_VERSION } from "./build.ts";
import { NO_LINK, startScheduler, type Link } from "./scheduler.ts";
import { Store } from "./store.ts";
import { startTimers } from "./sweep.ts";

export interface Config {
  /** The SQLite file; `:memory:` keeps nothing past the process. */
  db: string;
  tokens: Tokens;
  /** The hosts the scheduler can hand runs to. Default: none. */
  link?: Link;
}

export interface Running {
  api: JobApi;
  store: Store;
  /** Stops the timers and closes the database. */
  close(): void;
}

/** The API on the database at `config.db`, with its scheduler, sweep and log prune running. */
export function start(config: Config): Running {
  const store = Store.open(config.db);
  const build = buildOf();
  const api = new JobApi(store, config.tokens, {
    version: PACKAGE_VERSION,
    commit: build.commit,
  });
  const stop = startTimers(store);
  const unschedule = startScheduler(store, config.link ?? NO_LINK);
  return {
    api,
    store,
    close: () => {
      unschedule();
      stop();
      store.close();
    },
  };
}
