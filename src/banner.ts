/** jobber's mark: its name in block letters beside the mark, stacked shipping containers: runs, each in its own image. */

const LETTERS = [
  "     ██╗ ██████╗ ██████╗ ██████╗ ███████╗██████╗",
  "     ██║██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗",
  "     ██║██║   ██║██████╔╝██████╔╝█████╗  ██████╔╝",
  "██   ██║██║   ██║██╔══██╗██╔══██╗██╔══╝  ██╔══██╗",
  "╚█████╔╝╚██████╔╝██████╔╝██████╔╝███████╗██║  ██║",
  " ╚════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

/**
 * The mark on an 18 by 12 grid: three shipping containers, ribbed, one
 * stacked on two, the runs each going out in its own image. The first and last
 * rows are blank so a terminal, drawing two rows a character, gives it as many
 * rows as the letters, the containers centred on them.
 */
export const MARK_PIXELS = [
  "..................",
  "....##########....",
  "....#.#.##.#.#....",
  "....#.#.##.#.#....",
  "....##########....",
  "..................",
  "########..########",
  "#.#..#.#..#.#..#.#",
  "#.#..#.#..#.#..#.#",
  "#.#..#.#..#.#..#.#",
  "########..########",
  "..................",
];

/** The mark as text, two pixels a character, for terminals; the page draws MARK_PIXELS as an image instead. */
const MARK = Array.from({ length: MARK_PIXELS.length / 2 }, (_, row) =>
  [...MARK_PIXELS[row * 2]!]
    .map((top, col) => {
      const t = top === "#", b = MARK_PIXELS[row * 2 + 1]![col] === "#";
      return t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    })
    .join("")
    .trimEnd(),
);

/** The letters alone, for the page, which sets the mark beside them as an image. */
export const LETTERS_ONLY = LETTERS.join("\n");

const WIDTH = Math.max(...LETTERS.map((line) => line.length));
export const WORDMARK = LETTERS.map((line, i) => `${line.padEnd(WIDTH)}  ${MARK[i]}`.trimEnd()).join("\n");

/** The person's line for jobber, verbatim. */
export const TAGLINE = "Submit code to run on whatever computers you have.";
/** What jobber is, in one line. Every place that describes jobber in a line uses this or TAGLINE, verbatim. */
export const SUMMARY = "A queue of runs, each placed on a host that fits it and pushed there, with its log streamed back.";

/** The pixel mark as an SVG drawn from its grid, in the current color: beside the block letters. */
export const MARK_PIXEL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="0 0 ${MARK_PIXELS[0]!.length} ${MARK_PIXELS.length}" shape-rendering="crispEdges" fill="currentColor">${MARK_PIXELS.flatMap((row, y) =>
  [...row].flatMap((pixel, x) => (pixel === "#" ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])),
).join("")}</svg>`;

/** The mark drawn smooth, for small sizes: `ink` strokes each container and its ribs, `ground` fills them. */
const smoothMark = (ink: string, ground: string, style = "") => {
  const box = (x: number, y: number, w: number, h: number, ribs: number[]) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="${ground}"/>` + ribs.map((r) => `<path d="M${x + r} ${y + 2.5}V${y + h - 2.5}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="0 0 40 24">${style}<g fill="none" stroke="${ink}" stroke-width="2" stroke-linejoin="round">${box(10, 1, 20, 9, [5, 10, 15])}${box(1, 14, 17, 9, [4.5, 8.5, 12.5])}${box(22, 14, 17, 9, [4.5, 8.5, 12.5])}</g></svg>`;
};

/** The smooth mark in the page's colors, for its header. */
export const MARK_SVG = smoothMark("currentColor", "var(--panel)");

/** The smooth mark on its own, as the page's favicon: violet, its containers filled the tab's light or dark. */
export const MARK_ICON = smoothMark(
  "var(--ink)",
  "var(--ground)",
  "<style>svg{--ink:#6a4fc4;--ground:#fff}@media (prefers-color-scheme:dark){svg{--ink:#a994f2;--ground:#161615}}</style>",
);

/** Colors only for a terminal that wants them (https://no-color.org). jobber's is violet, beside honed's teal and waypoint's terracotta. */
export function palette(enabled: boolean) {
  const paint = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { mark: paint("38;5;98"), bold: paint("1"), dim: paint("2") };
}

export interface BannerInfo {
  version: string;
  /** Where it listens. */
  url: string;
  /** Where people, agents and hosts reach it: its public HTTPS address behind a proxy, else `url`. */
  publicUrl: string;
  db: string;
  /** The tokens not set, of AUTH_TOKEN and RUNNER_TOKEN: what answers 503 until they are. */
  missing: string[];
  color: boolean;
}

/** What jobber says when it starts: what it is, where each part is, and which token is not set. */
export function banner(b: BannerInfo): string {
  const c = palette(b.color);
  return [
    "",
    c.mark(WORDMARK),
    c.dim(`v${b.version}`),
    "",
    c.bold(TAGLINE),
    SUMMARY,
    "",
    `  ${c.mark("▸")} Page      ${b.publicUrl}/`,
    `  ${c.mark("▸")} API       ${b.publicUrl}/runs   docs ${b.publicUrl}/docs/api`,
    `  ${c.mark("▸")} MCP       ${b.publicUrl}/mcp    docs ${b.publicUrl}/docs/mcp`,
    "",
    ...(b.missing.length ? [c.bold(`${b.missing.join(" and ")} not set: what needs ${b.missing.length > 1 ? "them" : "it"} answers 503`), ""] : []),
    `  ${c.dim(`listening on ${b.url}, data in ${b.db}`)}`,
    `  ${c.dim("Ctrl+C to stop.")}`,
    "",
  ].join("\n");
}
