import { JobApi, type Tokens } from "./api.ts";
import { buildOf, PACKAGE_VERSION } from "./build.ts";
import { readSkill, SKILL_DIR } from "./skill.ts";
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
  /** Stops the timers and closes the database. */
  close(): void;
}

/** The API on the database at `config.db`, with its sweep and log prune running. */
export function start(config: Config): Running {
  const store = Store.open(config.db);
  const build = buildOf();
  const api = new JobApi(store, config.tokens, () => readSkill(SKILL_DIR, build.version, build.commit), {
    version: PACKAGE_VERSION,
    commit: build.commit,
  });
  const stop = startTimers(store);
  return {
    api,
    store,
    close: () => {
      stop();
      store.close();
    },
  };
}
