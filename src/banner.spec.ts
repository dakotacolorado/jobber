import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "./build.ts";
import { banner, MARK_PIXELS, TAGLINE, WORDMARK } from "./banner.ts";

const info = { version: "1.2.3", url: "http://127.0.0.1:4500", publicUrl: "https://beta:8445", db: "/data/jobber.db", missing: [], color: false };

describe("banner", () => {
  it("carries the person's tagline verbatim", () => {
    expect(TAGLINE).toBe("Submit code to run on whatever computers you have.");
  });

  it("sets the mark beside the letters, a row of text for each two of pixels", () => {
    expect(MARK_PIXELS).toHaveLength(12);
    expect(new Set(MARK_PIXELS.map((row) => row.length))).toEqual(new Set([18]));
    expect(WORDMARK.split("\n")).toHaveLength(6);
    expect(WORDMARK.split("\n")[0]).toMatch(/^ {5}██╗ ██████╗.*  +▄{10}$/);
  });

  it("says what jobber is and where its page, API and MCP are, at the public address", () => {
    expect(banner(info).split("\n")).toEqual([
      "",
      ...WORDMARK.split("\n"),
      "v1.2.3",
      "",
      TAGLINE,
      "A queue of runs, each placed on a host that fits it and pushed there, with its log streamed back.",
      "",
      "  ▸ Page      https://beta:8445/",
      "  ▸ API       https://beta:8445/runs   docs https://beta:8445/docs/api",
      "  ▸ MCP       https://beta:8445/mcp    docs https://beta:8445/docs/mcp",
      "",
      "  listening on http://127.0.0.1:4500, data in /data/jobber.db",
      "  Ctrl+C to stop.",
      "",
    ]);
  });

  it("says which tokens are not set", () => {
    expect(banner({ ...info, missing: ["RUNNER_TOKEN"] })).toContain("\nRUNNER_TOKEN not set: what needs it answers 503\n");
    expect(banner({ ...info, missing: ["AUTH_TOKEN", "RUNNER_TOKEN"] })).toContain("\nAUTH_TOKEN and RUNNER_TOKEN not set: what needs them answers 503\n");
  });

  it("is painted in jobber's violet only when color is on", () => {
    expect(banner(info)).not.toContain("\x1b");
    expect(banner({ ...info, color: true })).toContain("\x1b[38;5;98m");
  });

  it("is in the README as jobber prints it, starting locally", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const local = "http://127.0.0.1:4500";
    const printed = banner({ ...info, url: local, publicUrl: local, db: "~/.local/share/jobber/jobber.db", version: PACKAGE_VERSION });
    expect(readme).toContain(`\`\`\`\n${printed.replace(/^\n+|\n+$/g, "")}\n\`\`\``);
  });
});
