import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openApiDocument, SPEC_FILE } from "./spec.ts";

describe("openapi.json", () => {
  it("matches what the service serves", async () => {
    expect(JSON.parse(readFileSync(SPEC_FILE, "utf8"))).toEqual(await openApiDocument());
  });

  it("names every operation, since generators derive method names from it", async () => {
    const { paths } = (await openApiDocument()) as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ids = Object.values(paths).flatMap((ops) => Object.values(ops).map((op) => op.operationId));
    expect(ids.filter((id) => !id)).toEqual([]);
  });
});
