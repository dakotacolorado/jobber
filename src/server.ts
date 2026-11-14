import { JobApi, type Tokens } from "./api.ts";
import { buildOf, PACKAGE_VERSION } from "./build.ts";
import { Connections } from "./connections.ts";
import { startScheduler } from "./scheduler.ts";
import { Secrets } from "./secrets.ts";
import { Store } from "./store.ts";
import { startTimers } from "./sweep.ts";

export interface Config {
  /** The SQLite file; `:memory:` keeps nothing past the process. */
  db: string;
  tokens: Tokens;
  /** `JOBBER_SECRETS_KEY`, parsed. Null: no secret can be set, and a database holding some is refused. */
  secretsKey?: Buffer | null;
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
  let secrets: Secrets;
  try {
    secrets = new Secrets(store.db, config.secretsKey ?? null);
  } catch (err) {
    store.close();
    throw err;
  }
  const connections = new Connections(store, console.log, secrets);
  const api = new JobApi(
    store,
    config.tokens,
    {
      version: PACKAGE_VERSION,
      commit: build.commit,
    },
    connections,
    secrets,
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
