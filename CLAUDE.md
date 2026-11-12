# job-service

Runs of jobs: a job is a named script in a repo's `jobs.toml`, a run one
execution of it at one commit by a runner that claims it. One Node 24 process
(`src/cli.ts`) serving HTTP, its data in one SQLite file (`src/store.ts`), its
lease sweep and log prune as in-process timers (`src/sweep.ts`).

Keep it fact-dense: the code carries the facts. Prefer a mechanism to a
comment: a type, a test or a thrown error cannot rot. Comment only for a limit
a reader would otherwise violate, a deliberate choice that reads as a mistake,
or platform behaviour not visible in the source.

## Contract

`src/schema.ts` is the source of `openapi.json`, `docs/` and the skill's
`reference/api.md`. The pre-commit hook regenerates them (`npm run spec`); a
test fails if they drift. job-runner follows these shapes; change them with it.

How a run moves between states is `src/domain.ts`, as pure functions: keep
every transition there, tested, and let the store only refuse a write that lost
a race.

## Tests

Colocated as `*.spec.ts`; test our rules, not the library's. `npm test` needs
no network: the store runs on SQLite in memory or in a temporary file, and
`src/cli.spec.ts` starts the server on ports the OS picks.
`integration.spec.ts` hits a running instance and skips without
`INTEGRATION_JS_URL`/`INTEGRATION_JS_TOKEN`. How to run the checks is the
`test` skill (`.claude/skills/test/SKILL.md`).
