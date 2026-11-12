import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import { API_DOC, API_PAGE, openApiDocument, SPEC_FILE } from "./spec.ts";
import { Store } from "./store.ts";

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

describe("docs/API.md and docs/index.html", () => {
  it("render the served openapi.json", async () => {
    const served = await openApiDocument();
    // Redoc's page carries the document it renders.
    const embedded = /const __redoc_definition = (.*);\n/.exec(readFileSync(API_PAGE, "utf8"))?.[1];
    expect(JSON.parse(embedded ?? "null")).toEqual(served);
    const dir = mkdtempSync(join(tmpdir(), "job-service-docs-"));
    try {
      execFileSync("npx", ["--no-install", "openapi-to-md", SPEC_FILE, join(dir, "API.md")], { stdio: "ignore" });
      expect(readFileSync(API_DOC, "utf8")).toBe(readFileSync(join(dir, "API.md"), "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves the API reference at /docs/api without a token", async () => {
    const api = new JobApi(Store.open(":memory:"), { submitter: "t", registration: null }, () => ({ key: "jobs", version: 0, commit: "x", files: [] }), {
      version: "0",
      commit: "x",
    });
    const res = await api.fetch(new Request("http://local/docs/api"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(readFileSync(API_PAGE, "utf8"));
  });
});
