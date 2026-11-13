---
name: test
description: How to run jobber's checks. Use before submitting a change to jobber, and when reviewing one.
---

# Testing jobber

## The checks

An author runs these at the PR's head before submitting it, and a reviewer at
the commit reviewed. Each must exit 0. In a clean clone, with Node 24 and npm,
and the session's `*_URL`/`*_TOKEN` pairs unset so nothing reaches a deployed
service:

```sh
env -u DS_URL -u DS_TOKEN -u WT_URL -u WT_TOKEN -u WS_URL -u WS_TOKEN -u AS_URL -u AS_TOKEN -u JS_URL -u JS_TOKEN npm ci
env -u DS_URL -u DS_TOKEN -u WT_URL -u WT_TOKEN -u WS_URL -u WS_TOKEN -u AS_URL -u AS_TOKEN -u JS_URL -u JS_TOKEN npm run typecheck
env -u DS_URL -u DS_TOKEN -u WT_URL -u WT_TOKEN -u WS_URL -u WS_TOKEN -u AS_URL -u AS_TOKEN -u JS_URL -u JS_TOKEN npm test
env -u DS_URL -u DS_TOKEN -u WT_URL -u WT_TOKEN -u WS_URL -u WS_TOKEN -u AS_URL -u AS_TOKEN -u JS_URL -u JS_TOKEN npm run build
```

Run each on its own and read its exit status (`echo $?`). Never pipe one into
`tail` or `head`: the pipe reports their status, so a failure reads as a pass.

`npm test` needs no network and no service: the store runs on SQLite in
memory or in a temporary file, and `src/cli.spec.ts` starts the server on
ports the OS picks. It skips `src/integration.spec.ts` (4 tests), which needs
a running instance: point `INTEGRATION_JS_URL`, `INTEGRATION_JS_TOKEN` and
`INTEGRATION_JS_RUNNER_TOKEN` at one you started yourself (`npm run dev`, on a
port no one holds), never at prod, to run it.

Installing points git at `.githooks/`, whose pre-commit runs `npm run spec`.
