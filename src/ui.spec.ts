import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import { Store } from "./store.ts";

const TOKEN = "submitter-secret";
const file = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the page", () => {
  const api = new JobApi(Store.open(":memory:"), { submitter: TOKEN, registration: null }, {
    version: "0",
    commit: "x",
  });

  it.each([
    ["/", "ui/index.html", "text/html"],
    ["/ui/app.js", "ui/app.js", "text/javascript"],
    ["/ui/style.css", "ui/style.css", "text/css"],
  ])("serves %s without a token, holding none", async (path, source, type) => {
    const res = await api.fetch(new Request(`http://local${path}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
    const body = await res.text();
    expect(body).toBe(file(source));
    expect(body).not.toContain(TOKEN);
  });

  it("makes every element from text, so nothing a run or its log says is run as HTML", () => {
    expect(file("ui/app.js")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|eval\(/);
  });

  it("calls only routes the API has, under the submitters' token", async () => {
    const { paths } = (await (await api.fetch(new Request("http://local/openapi.json"))).json()) as { paths: Record<string, unknown> };
    // Each call's path, as `api("GET", "/runs")` or `request("GET", `/runs/${run.id}/log`)` writes it.
    const all = [...new Set([...file("ui/app.js").matchAll(/(?:api|request)\("(?:GET|POST)", (["`])(.*?)\1/g)].map((m) => m[2]!.split("?")[0]!.replace(/\$\{[^}]+\}/g, "{id}")))];
    expect(all.sort()).toEqual(["/hosts", "/runs", "/runs/{id}", "/runs/{id}/cancel", "/runs/{id}/log", "/runs/{id}/priority"]);
    for (const path of all) expect(Object.keys(paths)).toContain(path);
  });
});
