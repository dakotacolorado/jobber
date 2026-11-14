// jobber's page: runs by state, a run and its log, a form to submit one, and the hosts, over the API.
// Every element is made with `h`, which sets text, never HTML, so nothing a run or its log says is run.

import { LETTERS, MARK_PIXELS, SUMMARY, TAGLINE } from "./banner.js";

const TOKEN_KEY = "jobber.token";

// Signed in from the workplace UI: a link whose address ends #signin=<token> (after any route,
// as #/x&signin=<token>) stores the token, as signing in here would, and drops it from the address.
{
  const given = /(?:^#|&)signin=([^&]+)/.exec(location.hash);
  if (given) {
    localStorage.setItem(TOKEN_KEY, decodeURIComponent(given[1]));
    const rest = location.hash.replace(/(?:^#|&)signin=[^&]+/, "").replace(/^#?&/, "#");
    history.replaceState(null, "", location.pathname + location.search + (rest.length > 1 ? rest : ""));
  }
}
const STATES = ["pending", "assigned", "running", "succeeded", "failed", "canceled"];
const ENDED = ["succeeded", "failed", "canceled"];
/** How often a run's page asks for more of its log, and the runs list for changes. */
const FOLLOW_MS = 1000;
const REFRESH_MS = 5000;

const main = document.getElementById("main");
const signout = document.getElementById("signout");

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}

const token = () => localStorage.getItem(TOKEN_KEY);

/** Where this page is served, as `https://host:8445/`: the base of the API and the MCP server too. */
const base = () => `${location.origin}${location.pathname}`;

/** The mark drawn from banner.ts's pixel grid, a square a pixel, so it is the terminal's mark. */
function pixelMark() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${MARK_PIXELS[0].length} ${MARK_PIXELS.length}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  MARK_PIXELS.forEach((row, y) =>
    [...row].forEach((pixel, x) => {
      if (pixel !== "#") return;
      const rect = document.createElementNS(NS, "rect");
      for (const [key, value] of Object.entries({ x, y, width: 1, height: 1 })) rect.setAttribute(key, String(value));
      svg.append(rect);
    }),
  );
  return svg;
}

/** The block-letter name with the mark beside it, as honed's and waypoint's pages open. */
function wordmark(small = false) {
  return h("a", { class: `wordmark${small ? " small" : ""}`, href: "#/", "aria-label": "jobber" }, h("pre", { "aria-hidden": "true" }, LETTERS), pixelMark());
}

function landing(small) {
  return h(
    "div",
    { class: "landing" },
    wordmark(small),
    h("p", { class: "tagline" }, TAGLINE),
    h("p", { class: "muted" }, SUMMARY),
    h(
      "p",
      { class: "endpoints muted" },
      "API ",
      h("code", {}, `${base()}runs`),
      " · MCP ",
      h("code", {}, `${base()}mcp`),
      " · docs: ",
      h("a", { href: "./docs/api", target: "_blank" }, "API"),
      ", ",
      h("a", { href: "./docs/mcp", target: "_blank" }, "MCP"),
    ),
  );
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
  }
}

/** One API call, relative to this page. A 401 forgets the token and asks for another. */
async function request(method, path, { body, headers = {} } = {}) {
  const res = await fetch(path.replace(/^\//, ""), {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    route();
    throw new ApiError(401, { message: "That is not this jobber's submitters' token." });
  }
  return res;
}

async function api(method, path, body) {
  const res = await request(method, path, { body });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const short = (id) => id.slice(0, 8);
const errorBox = () => h("div", { class: "error", hidden: true });
const show = (box, err) => {
  box.hidden = false;
  box.textContent = err.message;
};
const state = (run) => h("span", { class: `state ${run.state}` }, run.state, run.cancelRequested && !ENDED.includes(run.state) ? " · cancel asked" : "");
const repoAt = (run) => [run.repo, h("span", { class: "muted mono" }, ` @${run.commit.slice(0, 7)}`)];
const pairs = (labels) => Object.entries(labels).map(([k, v]) => `${k}=${v}`);
/** A run's labels, each a link to the runs that share it. */
const labelLinks = (labels) =>
  pairs(labels).flatMap((pair, i) => [i ? " " : "", h("a", { class: "mono label", href: `#/?label=${encodeURIComponent(pair)}` }, pair)]);
/** What a run asked for, in a few words: `linux x86_64, 0.5 CPU, 256 MiB, 1 GPU, 60 s`. */
const needs = (r) =>
  [r.os, r.arch, r.cpu != null && `${r.cpu} CPU`, r.memory !== null && `${r.memory} MiB`, (r.gpu || r.gpuMemory) && `${r.gpu ?? 1} GPU${r.gpuMemory ? ` of ${r.gpuMemory} MiB` : ""}`, r.timeout !== null && `${r.timeout} s`].filter(Boolean).join(", ") || "any host";
function took(run) {
  if (run.duration !== null) return `${run.duration.toFixed(1)} s`;
  if (run.startedAt && !run.endedAt) return `${Math.round((Date.now() - Date.parse(run.startedAt)) / 1000)} s so far`;
  return "";
}

/**
 * What the page is showing, so a timer a page left behind stops: each draw
 * takes a new generation, and a timer whose generation is not the current
 * one does nothing more.
 */
let generation = 0;
const current = () => {
  const mine = ++generation;
  return () => mine === generation;
};
const every = (ms, live, fn) => {
  const tick = async () => {
    if (!live()) return;
    try {
      await fn();
    } catch {
      // Shown on the next draw; a dropped poll is retried.
    }
    if (live()) setTimeout(tick, ms);
  };
  setTimeout(tick, ms);
};

function signIn() {
  signout.hidden = true;
  const input = h("input", { type: "password", placeholder: "AUTH_TOKEN", style: "width:100%", autocomplete: "off" });
  const box = errorBox();
  const form = h(
    "form",
    {
      class: "panel",
      onsubmit: async (event) => {
        event.preventDefault();
        localStorage.setItem(TOKEN_KEY, input.value.trim());
        try {
          await api("GET", "/runs?limit=1");
          route();
        } catch (err) {
          show(box, err);
        }
      },
    },
    h("h2", {}, "Sign in"),
    h("p", { class: "muted" }, "Paste this host's submitters' token: AUTH_TOKEN in ~/.config/jobber/env. It stays in this browser."),
    input,
    box,
    h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Sign in")),
  );
  main.replaceChildren(
    h(
      "div",
      { class: "signin" },
      landing(false),
      form,
    ),
  );
  input.focus();
}

async function runs(params) {
  const live = current();
  const filters = { state: params.get("state") ?? "", repo: params.get("repo") ?? "", label: params.get("label") ?? "" };
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  query.set("limit", params.get("limit") ?? "100");
  const load = () => api("GET", `/runs?${query}`);
  const { runs: list } = await load();
  if (!live()) return;

  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    location.hash = `#/?${next}`;
  };
  const text = (key, placeholder) => h("input", { value: filters[key], placeholder, onchange: (e) => set(key, e.target.value.trim()) });
  const bar = h(
    "div",
    { class: "filters" },
    h("select", { onchange: (e) => set("state", e.target.value) }, h("option", { value: "" }, "Every state"), STATES.map((each) => h("option", { value: each, selected: each === filters.state }, each))),
    text("repo", "owner/name"),
    text("label", "label key=value"),
    h("button", { onclick: () => (location.hash = "#/") }, "Clear"),
  );
  const count = h("span", { class: "muted" });
  const body = h("tbody");
  const draw = (rows) => {
    count.textContent = `${rows.length} run${rows.length === 1 ? "" : "s"}, newest first${rows.length >= Number(query.get("limit")) ? ` (the latest ${query.get("limit")})` : ""}`;
    body.replaceChildren(
      ...(rows.length
        ? rows.map((run) =>
            h(
              "tr",
              {},
              h("td", {}, h("a", { class: "mono", href: `#/run/${run.id}` }, short(run.id))),
              h("td", {}, state(run), run.exit !== null ? h("span", { class: "muted" }, ` exit ${run.exit}`) : "", run.attempt > 1 ? h("span", { class: "muted" }, ` · attempt ${run.attempt}`) : ""),
              h("td", {}, repoAt(run)),
              h("td", { class: "mono" }, run.job, run.args.length ? h("span", { class: "muted" }, ` ${run.args.join(" ")}`) : ""),
              h("td", {}, String(run.priority)),
              h("td", {}, labelLinks(run.labels)),
              h("td", {}, when(run.createdAt)),
              h("td", {}, took(run)),
            ),
          )
        : [h("tr", {}, h("td", { colspan: 8, class: "muted" }, "No runs."))]),
    );
  };
  draw(list);
  bar.append(count);
  main.replaceChildren(
    landing(true),
    bar,
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, ["Run", "State", "Repo", "Job", "Priority", "Labels", "Submitted", "Took"].map((name) => h("th", {}, name)))),
      body,
    ),
  );
  every(REFRESH_MS, live, async () => {
    const { runs: rows } = await load();
    if (live()) draw(rows);
  });
}

async function runPage(id, params = new URLSearchParams()) {
  const live = current();
  let run = await api("GET", `/runs/${id}`);
  if (!live()) return;
  /** The attempt whose log is shown: the latest unless the address names an earlier one. */
  const chosen = Number(params.get("attempt")) || null;
  const earlier = chosen !== null && chosen !== run.attempt ? run.attempts.find((a) => a.attempt === chosen) : null;
  const logQuery = earlier ? `?attempt=${earlier.attempt}` : "";
  const box = errorBox();
  const head = h("div", { class: "panel" });
  /** A run not yet ended can move up or down the queue; an ended one shows where it stood. */
  const priorityField = () => {
    if (ENDED.includes(run.state)) return String(run.priority);
    const input = h("input", { type: "number", min: -1000, max: 1000, step: 1, value: run.priority, style: "width:6em" });
    const set = h(
      "button",
      {
        onclick: async () => {
          try {
            run = await api("POST", `/runs/${run.id}/priority`, { priority: Number(input.value) });
            drawHead();
          } catch (err) {
            show(box, err);
          }
        },
      },
      "Set",
    );
    return h("span", { class: "row", style: "margin:0" }, input, set);
  };
  /** Every attempt, oldest first, the latest the run's own fields; each links to its log. */
  const attemptsTable = () => {
    const latest = { attempt: run.attempt, host: run.host, state: run.state, exit: run.exit, reason: run.reason, duration: run.duration, startedAt: run.startedAt };
    const shown = earlier ? earlier.attempt : run.attempt;
    return h(
      "table",
      { class: "attempts" },
      h("thead", {}, h("tr", {}, ["Attempt", "Host", "State", "Exit", "Started", "Took", "Reason"].map((name) => h("th", {}, name)))),
      h(
        "tbody",
        {},
        [...run.attempts, latest].map((a) =>
          h(
            "tr",
            {},
            h("td", {}, a.attempt === shown ? `#${a.attempt} (log below)` : h("a", { href: `#/run/${run.id}?attempt=${a.attempt}` }, `#${a.attempt}`)),
            h("td", { class: "mono" }, a.host ? short(a.host) : ""),
            h("td", {}, h("span", { class: `state ${a.state}` }, a.state)),
            h("td", {}, a.exit ?? ""),
            h("td", {}, when(a.startedAt)),
            h("td", {}, a.duration !== null ? `${a.duration.toFixed(1)} s` : ""),
            h("td", {}, a.reason ?? ""),
          ),
        ),
      ),
    );
  };
  const drawHead = () => {
    const fields = [
      ["Repo", repoAt(run)],
      ["Commit", h("span", { class: "mono" }, run.commit)],
      ["Job", h("span", { class: "mono" }, [run.job, ...run.args].join(" "))],
      ["Needs", needs(run.requirements)],
      ["Priority", priorityField()],
      ["Retry", run.retry.limit ? `up to ${run.retry.limit} time${run.retry.limit === 1 ? "" : "s"}, ${run.retry.backoff} s apart, doubling` : "none"],
      run.retryAt && run.state === "pending" && ["Retry at", when(run.retryAt)],
      ["Labels", run.labels && Object.keys(run.labels).length ? labelLinks(run.labels) : "none"],
      ["Host", run.host ? [h("a", { href: "#/hosts", class: "mono" }, short(run.host)), run.state === "assigned" ? h("span", { class: "muted" }, ` assigned ${when(run.assignedAt)}, not yet taken`) : ""] : "not yet placed"],
      ["Submitted", when(run.createdAt)],
      run.startedAt && ["Started", when(run.startedAt)],
      run.endedAt && ["Ended", `${when(run.endedAt)}${run.duration !== null ? `, after ${run.duration.toFixed(1)} s` : ""}`],
      run.exit !== null && ["Exit", String(run.exit)],
      run.reason && ["Reason", run.reason],
    ].filter(Boolean);
    const cancel = !ENDED.includes(run.state) && h(
      "button",
      {
        class: "danger",
        disabled: run.cancelRequested,
        onclick: async () => {
          try {
            run = await api("POST", `/runs/${run.id}/cancel`);
            drawHead();
          } catch (err) {
            show(box, err);
          }
        },
      },
      run.cancelRequested ? "Cancel asked" : "Cancel",
    );
    head.replaceChildren(
      h("h1", { class: "mono" }, run.id),
      h("div", { class: "row" }, state(run), cancel),
      box,
      h("dl", { class: "fields" }, fields.flatMap(([name, value]) => [h("dt", {}, name), h("dd", {}, value)])),
      run.attempts.length ? attemptsTable() : "",
    );
  };
  drawHead();

  const pre = h("pre", { class: "log" });
  const status = h("span", { class: "muted" });
  const follow = h("input", { type: "checkbox", checked: true });
  const decoder = new TextDecoder();
  let offset = 0;
  /** Reads the log on from `offset`, and says whether there may be more. */
  const more = async () => {
    const res = await request("GET", `/runs/${run.id}/log` + logQuery, { headers: { range: `bytes=${offset}-` } });
    if (res.status !== 206) throw new ApiError(res.status, await res.json().catch(() => null));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const size = Number(res.headers.get("content-range")?.split("/")[1] ?? offset);
    offset += bytes.length;
    const ended = ENDED.includes(res.headers.get("run-state"));
    if (bytes.length) {
      const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
      // `stream` holds a character split across two reads until the rest arrives.
      pre.append(decoder.decode(bytes, { stream: offset < size || !ended }));
      if (follow.checked && atBottom) pre.scrollTop = pre.scrollHeight;
    }
    status.textContent = `${offset} of ${size} bytes${ended && offset >= size ? ", the whole log" : ", following"}`;
    return offset < size || !ended;
  };

  main.replaceChildren(
    head,
    h("div", { class: "panel" }, h("h2", {}, run.attempts.length ? `Log of attempt ${earlier ? earlier.attempt : run.attempt}` : "Log"), h("div", { class: "row", style: "margin:0 0 8px" }, status, h("label", { class: "muted", style: "margin:0;text-transform:none;letter-spacing:0;font-size:13px" }, follow, " keep at the end")), pre),
  );
  let going = await more();
  while (going && live() && offset < (earlier ? earlier.logSize : run.logSize)) going = await more();
  if (going) {
    every(FOLLOW_MS, live, async () => {
      if (!going) return;
      going = await more();
      // The head follows the run too: it says when it is claimed, asked to cancel and ended.
      const next = await api("GET", `/runs/${run.id}`);
      if (live() && next.updatedAt !== run.updatedAt) {
        // A retry starts a new log: show it from its start.
        if (!earlier && next.attempt !== run.attempt) return route();
        run = next;
        drawHead();
      }
      if (!going) generation++;
    });
  }
}

const lines = (area) => area.value.split("\n").map((line) => line.trim()).filter(Boolean);

function newRun(params) {
  current();
  const input = (name, attrs = {}) => h("input", { name, style: "width:100%", value: params.get(name) ?? "", ...attrs });
  const repo = input("repo", { placeholder: "owner/name", required: true });
  const commit = input("commit", { placeholder: "the full 40-character sha", required: true, pattern: "[0-9a-f]{40}", class: "mono" });
  const job = input("job", { placeholder: "a [jobs.<name>] in its jobs.toml", required: true });
  const args = h("textarea", { placeholder: "one argument a line" });
  const labels = h("textarea", { placeholder: "key=value, one a line: what it is for, who asked" });
  const choose = (options) => h("select", {}, h("option", { value: "" }, "any"), options.map((each) => h("option", { value: each }, each)));
  const os = choose(["linux", "macos", "windows"]);
  const arch = choose(["x86_64", "aarch64"]);
  const cpu = input("cpu", { type: "number", min: 0.001, step: "any", placeholder: "0.5" });
  const memory = input("memory", { type: "number", min: 16, placeholder: "jobs.toml's" });
  const gpu = input("gpu", { type: "number", min: 0, max: 64, step: 1, placeholder: "0" });
  const gpuMemory = input("gpuMemory", { type: "number", min: 1, step: 1, placeholder: "any" });
  const timeout = input("timeout", { type: "number", min: 1, placeholder: "jobs.toml's" });
  const priority = input("priority", { type: "number", min: -1000, max: 1000, step: 1, placeholder: "0" });
  const retries = input("retries", { type: "number", min: 0, max: 10, step: 1, placeholder: "0" });
  const backoff = input("backoff", { type: "number", min: 1, max: 3600, step: 1, placeholder: "10" });
  const box = errorBox();
  main.replaceChildren(
    h(
      "form",
      {
        class: "panel",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const given = lines(labels).map((line) => {
              const at = line.indexOf("=");
              if (at < 1) throw new Error(`"${line}" is not key=value`);
              return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
            });
            const run = await api("POST", "/runs", {
              repo: repo.value.trim(),
              commit: commit.value.trim(),
              job: job.value.trim(),
              args: lines(args),
              labels: Object.fromEntries(given),
              priority: priority.value ? Number(priority.value) : 0,
              retry: { limit: retries.value ? Number(retries.value) : 0, backoff: backoff.value ? Number(backoff.value) : 10 },
              requirements: {
                os: os.value || null,
                arch: arch.value || null,
                cpu: cpu.value ? Number(cpu.value) : null,
                memory: memory.value ? Number(memory.value) : null,
                gpu: gpu.value ? Number(gpu.value) : null,
                gpuMemory: gpuMemory.value ? Number(gpuMemory.value) : null,
                timeout: timeout.value ? Number(timeout.value) : null,
              },
            });
            location.hash = `#/run/${run.id}`;
          } catch (err) {
            show(box, err);
          }
        },
      },
      h("h1", {}, "Submit a run"),
      h("p", { class: "muted" }, "Queued pending, by priority then age, until a host that meets its requirements takes it. Nothing is checked against the repo here: a job missing from jobs.toml fails on its host, saying so in its log."),
      h("label", {}, "Repo"), repo,
      h("label", {}, "Commit"), commit,
      h("label", {}, "Job"), job,
      h("label", {}, "Arguments"), args,
      h("h2", { class: "section" }, "Requirements"),
      h("div", { class: "grid5" },
        h("div", {}, h("label", {}, "OS"), os),
        h("div", {}, h("label", {}, "Arch"), arch),
        h("div", {}, h("label", {}, "CPUs"), cpu),
        h("div", {}, h("label", {}, "Memory, MiB"), memory),
        h("div", {}, h("label", {}, "GPUs"), gpu),
        h("div", {}, h("label", {}, "GPU memory, MiB"), gpuMemory),
        h("div", {}, h("label", {}, "Timeout, s"), timeout)),
      h("label", {}, "Labels"), labels,
      h("div", { class: "grid4" },
        h("div", {}, h("label", {}, "Priority, higher first"), priority),
        h("div", {}, h("label", {}, "Retries if it fails"), retries),
        h("div", {}, h("label", {}, "First retry after, s"), backoff)),
      box,
      h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Submit")),
    ),
  );
}

const mib = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GiB` : `${n} MiB`);
/** CPUs, memory and any GPUs: `13.5 CPU, 9.0 GiB, 1 GPU of 24.0 GiB`. */
const resources = (r) => [`${+r.cpu.toFixed(3)} CPU`, mib(r.memory), r.gpu && `${r.gpu} GPU${r.gpuMemory ? ` of ${mib(r.gpuMemory)}` : ""}`].filter(Boolean).join(", ");

async function hosts() {
  current();
  const { hosts: list } = await api("GET", "/hosts");
  main.replaceChildren(
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, ["Host", "Connected", "OS", "Capacity", "Free", "CPU load", "Memory", "Disk free", "Labels", "Version", "Last seen"].map((name) => h("th", {}, name)))),
      h(
        "tbody",
        {},
        list.length
          ? list.map((host) =>
              h(
                "tr",
                {},
                h("td", {}, host.name, h("div", { class: "muted mono" }, short(host.id))),
                h("td", {}, host.connected ? "yes" : h("span", { class: "muted" }, "no")),
                h("td", {}, `${host.os} ${host.arch}`),
                h("td", {}, resources(host.capacity)),
                h("td", {}, host.free ? resources(host.free) : ""),
                h("td", {}, host.metrics ? `${host.metrics.cpuLoad.toFixed(2)}${host.metrics.cpus ? ` of ${host.metrics.cpus} CPUs` : ""}` : ""),
                h("td", {}, host.metrics ? `${mib(host.metrics.memoryUsed)} of ${mib(host.metrics.memoryTotal)}` : ""),
                h("td", {}, host.metrics ? mib(host.metrics.diskFree) : ""),
                h("td", { class: "mono" }, pairs(host.labels).join(", ")),
                h("td", {}, host.version ?? ""),
                h("td", {}, when(host.lastSeenAt)),
              ),
            )
          : h("tr", {}, h("td", { colspan: 11, class: "muted" }, "No host has registered.")),
      ),
    ),
  );
}

async function route() {
  if (!token()) return signIn();
  signout.hidden = false;
  const [path, search = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(search);
  try {
    const run = /^\/run\/([0-9a-f-]{36})$/.exec(path ?? "");
    if (run) await runPage(run[1], params);
    else if (path === "/new") newRun(params);
    else if (path === "/hosts") await hosts();
    else await runs(params);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    main.replaceChildren(h("div", { class: "panel error" }, err.message));
  }
}

signout.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  route();
});
window.addEventListener("hashchange", route);
fetch("health")
  .then((res) => res.json())
  .then((about) => (document.getElementById("about").textContent = `v${about.version} · ${about.commit.slice(0, 7)}`))
  .catch(() => {});
route();
