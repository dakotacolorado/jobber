import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JobApi } from "./api.ts";
import { LETTERS_ONLY, MARK_ICON, MARK_PIXELS, MARK_SVG, SUMMARY, TAGLINE } from "./banner.ts";
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

  it("serves jobber's mark as the favicon, an SVG for light and dark", async () => {
    const res = await api.fetch(new Request("http://local/ui/mark.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(await res.text()).toBe(MARK_ICON);
    expect(MARK_ICON).toContain("prefers-color-scheme:dark");
    expect(file("ui/index.html")).toContain('<link rel="icon" type="image/svg+xml" href="./ui/mark.svg?v=containers">');
  });

  it("wears jobber's mark and name in its header and tab, and nowhere says its old name", () => {
    const page = file("ui/index.html");
    expect(page).toContain("<title>jobber</title>");
    expect(page).toContain(`<a class="brand" href="#/">${MARK_SVG}jobber</a>`);
    for (const path of ["ui/index.html", "ui/app.js", "ui/style.css"]) expect(file(path)).not.toMatch(/job[-]service/i);
  });

  it("gives the page banner.ts's tagline and summary, so the terminal and the page say the same", async () => {
    const res = await api.fetch(new Request("http://local/ui/banner.js"));
    expect(res.headers.get("content-type")).toContain("text/javascript");
    const body = await res.text();
    expect(body).toContain(`export const TAGLINE = ${JSON.stringify(TAGLINE)};`);
    expect(body).toContain(`export const SUMMARY = ${JSON.stringify(SUMMARY)};`);
    expect(body).toContain(`export const LETTERS = ${JSON.stringify(LETTERS_ONLY)};`);
    expect(body).toContain(`export const MARK_PIXELS = ${JSON.stringify(MARK_PIXELS)};`);
    expect(file("ui/app.js")).toContain('import { LETTERS, MARK_PIXELS, SUMMARY, TAGLINE } from "./banner.js";');
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
