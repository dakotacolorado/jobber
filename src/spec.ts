import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JobApi, SPEC_PATH } from "./api.ts";
import { REFERENCE_FILE, renderReference } from "./skill.ts";
import { Store } from "./store.ts";

/**
 * Writes `openapi.json`. Committed so clients generate without a deploy and
 * contract changes surface in review.
 */
export const SPEC_FILE = fileURLToPath(new URL("../openapi.json", import.meta.url));

/** Fetched through the app, so the file cannot differ from what is served. */
export async function openApiDocument(): Promise<unknown> {
  const store = Store.open(":memory:");
  const api = new JobApi(store, { submitter: null, registration: null }, () => ({ key: "jobs", version: 0, commit: "x", files: [] }), {
    version: "0",
    commit: "x",
  });
  const doc = await (await api.fetch(new Request(`http://local${SPEC_PATH}`))).json();
  store.close();
  return doc;
}

if (import.meta.main) {
  const doc = await openApiDocument();
  writeFileSync(SPEC_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(REFERENCE_FILE, renderReference(doc as Parameters<typeof renderReference>[0]));
  console.log(`wrote ${SPEC_FILE} and ${REFERENCE_FILE}`);
}
