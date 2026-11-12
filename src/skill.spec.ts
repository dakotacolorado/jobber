import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import { REFERENCE_FILE, readSkill, renderReference, SKILL_DIR } from "./skill.ts";
import { openApiDocument } from "./spec.ts";
import { Store } from "./store.ts";

const doc = async () => (await openApiDocument()) as Parameters<typeof renderReference>[0];

describe("the skill's reference", () => {
  it("is what openapi.json renders to, so it cannot drift from the API", async () => {
    expect(readFileSync(REFERENCE_FILE, "utf8")).toBe(renderReference(await doc()));
  });

  it("covers the calls a worker makes, and not the platform's", async () => {
    const reference = renderReference(await doc());
    expect(reference).toContain("## SubmitRun: POST /runs");
    expect(reference).not.toContain("/skill");
    expect(reference).not.toContain("/health");
  });
});

describe("GET /skill", () => {
  const api = new JobApi(Store.open(":memory:"), { submitter: "t", registration: null }, () => readSkill(SKILL_DIR, 7, "abc"), { version: "0.1.0", commit: "abc" });
  const get = (auth?: string) => api.fetch(new Request("http://local/skill", { headers: auth ? { authorization: auth } : {} }));

  it("needs the token", async () => {
    expect((await get()).status).toBe(401);
  });

  it("answers bin/ and reference/ under the skill's folder", async () => {
    const skill = (await (await get("Bearer t")).json()) as ReturnType<typeof readSkill>;
    expect(skill).toMatchObject({ key: "jobs", version: 7, commit: "abc" });
    expect(skill.files.map((f) => [f.path, f.executable])).toEqual([
      ["skills/jobs/bin/jobs", true],
      ["skills/jobs/reference/api.md", false],
    ]);
  });
});
