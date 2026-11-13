import { JobApi, type Tokens } from "./api.ts";
import { buildOf, PACKAGE_VERSION } from "./build.ts";
import { Connections } from "./connections.ts";
import { startScheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { startTimers } from "./sweep.ts";

export interface Config {
  /** The SQLite file; `:memory:` keeps nothing past the process. */
  db: string;
  tokens: Tokens;
}

export interface Running {
  api: JobApi;
  store: Store;
  /** The hosts' connections, for the HTTP server to hand its upgrades to (`attach`). */
  connections: Connections;
  /** Stops the timers and closes the database. */
  close(): void;
}

/** The API on the database at `config.db`, with its scheduler, sweep and log prune running. */
export function start(config: Config): Running {
  const store = Store.open(config.db);
  const build = buildOf();
  const connections = new Connections(store);
  const api = new JobApi(
    store,
    config.tokens,
    {
      version: PACKAGE_VERSION,
      commit: build.commit,
    },
    connections,
  );
  const stop = startTimers(store);
  const unschedule = startScheduler(store, connections);
  return {
    api,
    store,
    connections,
    close: () => {
      unschedule();
      connections.close();
      stop();
      store.close();
    },
  };
}
