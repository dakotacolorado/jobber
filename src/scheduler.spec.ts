import { describe, expect, it } from "vitest";
import { NO_RETRY, accepted, ASSIGN_SECONDS, assigned, canceled, DEFAULT_CPU, expired, FRESH_SECONDS, freeOn, healthy, MAX_LOAD_PER_CPU, MIN_DISK_FREE_MIB, schedule, submitted, unassigned, type Candidate, type Metrics, type Run } from "./domain.ts";
import { tick, type Link } from "./scheduler.ts";
import { Store, type StoredHost } from "./store.ts";

const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const T0 = "2026-11-13T00:00:00.000Z";
const later = (seconds: number, from = T0) => new Date(Date.parse(from) + seconds * 1000).toISOString();

const run = (over: { priority?: number; cpu?: number; memory?: number; os?: "linux" | "macos"; at?: string } = {}): Run =>
  submitted(
    {
      repo: "o/r",
      commit: COMMIT,
      job: "hello",
      args: [],
      requirements: { os: over.os ?? null, arch: null, cpu: over.cpu ?? null, memory: over.memory ?? null, timeout: null, host: null },
      labels: {},
      priority: over.priority ?? 0,
      retry: NO_RETRY,
      secrets: [],
      onHost: false,
    },
    over.at ?? T0,
  );

const candidate = (id: string, cpu: number, memory: number, os: "linux" | "macos" = "linux"): Candidate => ({ id, name: id, features: [], os, arch: "x86_64", free: { cpu, memory } });

describe("schedule", () => {
  it("places the highest priority first, then the oldest, while capacity lasts", () => {
    const old = run({ at: T0 });
    const young = run({ at: later(1) });
    const urgent = run({ priority: 5, at: later(2) });
    const placed = schedule([young, old, urgent], [candidate("a", 2 * DEFAULT_CPU, 8192)]);
    expect(placed.map((p) => p.run.id)).toEqual([urgent.id, old.id]);
  });

  it("puts each run on the fitting host with the most room, and passes over a run none fits", () => {
    const mac = run({ os: "macos" });
    const big = run({ memory: 6000, priority: 9 });
    const a = run({ at: later(1) });
    const b = run({ at: later(2) });
    const placed = schedule([mac, big, a, b], [candidate("small", 0.5, 2048), candidate("wide", 4, 4096)]);
    // `big` fits nowhere and does not hold up `a` and `b`; `mac` has no macOS host.
    expect(placed.map((p) => [p.run.id, p.host])).toEqual([
      [a.id, "wide"],
      [b.id, "wide"],
    ]);
    // Equal room: the lower id.
    expect(schedule([a, b, run({ at: later(3) })], [candidate("x", 0.5, 1024), candidate("y", 0.5, 1024)]).map((p) => p.host)).toEqual(["x", "y"]);
  });

  it("places as many runs on one host as their cpu and memory requests fit, with no count of them", () => {
    const runs = Array.from({ length: 8 }, (_, i) => run({ cpu: 0.1, memory: 256, at: later(i) }));
    expect(schedule(runs, [candidate("a", 0.7, 8192)])).toHaveLength(7);
    expect(schedule(runs, [candidate("a", 16, 1024)])).toHaveLength(4);
  });

  it("passes over a run whose cpu does not fit, though its memory would", () => {
    const heavy = run({ cpu: 3, priority: 1 });
    const light = run({ cpu: 0.25, at: later(1) });
    expect(schedule([heavy, light], [candidate("a", 2, 8192)]).map((p) => p.run.id)).toEqual([light.id]);
    expect(schedule([run()], [candidate("a", DEFAULT_CPU - 0.001, 8192)])).toEqual([]);
  });
});

describe("freeOn", () => {
  const host = { id: "h", capacity: { cpu: 3, memory: 4096 }, free: { cpu: 3, memory: 4096 } };

  it("takes off the requests of the runs assigned or running there that its last report predates", () => {
    const mine = assigned(run({ cpu: 0.1, memory: 1000 }), "h", T0);
    const running = accepted(assigned(run({ cpu: 0.2 }), "h", T0), "h", T0);
    const theirs = assigned(run(), "other", T0);
    expect(freeOn(host, [mine, running, theirs])).toEqual({ cpu: 2.7, memory: 2072 });
    expect(freeOn({ ...host, free: null }, [assigned(run(), "h", T0)])).toEqual({ cpu: 3 - DEFAULT_CPU, memory: 3072 });
  });

  it("is never more than the host last reported, nor less than nothing", () => {
    expect(freeOn({ ...host, free: { cpu: 1, memory: 500 } }, [])).toEqual({ cpu: 1, memory: 500 });
    expect(freeOn({ ...host, capacity: { cpu: 0.5, memory: 512 } }, [assigned(run({ cpu: 1 }), "h", T0)])).toEqual({ cpu: 0, memory: 0 });
  });
});

describe("healthy", () => {
  const metrics = (over: Partial<Metrics> = {}): { metrics: Metrics } => ({ metrics: { cpuLoad: 1, memoryUsed: 1000, memoryTotal: 8000, diskFree: 50_000, cpus: 4, ...over } });

  it("is a host not nearly out of disk nor overloaded, or one that has not said", () => {
    expect(healthy({ metrics: null })).toBe(true);
    expect(healthy(metrics())).toBe(true);
    expect(healthy(metrics({ diskFree: MIN_DISK_FREE_MIB }))).toBe(true);
    expect(healthy(metrics({ diskFree: MIN_DISK_FREE_MIB - 1 }))).toBe(false);
    expect(healthy(metrics({ cpuLoad: 4 * MAX_LOAD_PER_CPU }))).toBe(true);
    expect(healthy(metrics({ cpuLoad: 4 * MAX_LOAD_PER_CPU + 0.1 }))).toBe(false);
    expect(healthy(metrics({ cpuLoad: 99, cpus: 0 })), "CPUs unknown: load says nothing").toBe(true);
  });
});

describe("an assignment", () => {
  it("is taken by its host, again harmlessly, and by no other", () => {
    const given = assigned(run(), "h", later(1));
    expect(given).toMatchObject({ state: "assigned", host: "h", assignedAt: later(1) });
    const taken = accepted(given, "h", later(2));
    expect(taken).toMatchObject({ state: "running", host: "h", startedAt: later(2), leaseExpiresAt: later(62) });
    expect(accepted(taken, "h", later(3))).toBe(taken);
    expect(() => accepted(given, "other")).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => accepted(run(), "h")).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => accepted(canceled(given, later(2)), "h")).toThrow(expect.objectContaining({ status: 409 }));
  });

  it(`goes back to the queue unless taken within ${ASSIGN_SECONDS}s`, () => {
    const given = assigned(run(), "h", later(1));
    expect(expired(given, later(ASSIGN_SECONDS))).toBeNull();
    expect(expired(given, later(ASSIGN_SECONDS + 1))).toMatchObject({ state: "pending", host: null, assignedAt: null });
    expect(expired(accepted(given, "h", later(1)), later(ASSIGN_SECONDS * 2))).toBeNull();
    expect(unassigned(given, later(1))).toMatchObject({ state: "pending", host: null });
  });

  it("is canceled at once, as a pending run is", () => {
    expect(canceled(assigned(run(), "h", T0), later(1))).toMatchObject({ state: "canceled", endedAt: later(1) });
  });
});

function fleet() {
  const store = Store.open(":memory:");
  const host = (name: string, over: Partial<StoredHost> = {}): StoredHost => {
    const h: StoredHost = {
      id: name,
      name,
      os: "linux",
      arch: "x86_64",
      capacity: { cpu: 2 * DEFAULT_CPU, memory: 4096 },
      labels: {},
      version: null,
      features: [],
      free: { cpu: 2 * DEFAULT_CPU, memory: 4096 },
      metrics: null,
      createdAt: T0,
      lastSeenAt: T0,
      tokenHash: "x",
      ...over,
    };
    store.putHost(h);
    return h;
  };
  const sent: [string, Run][] = [];
  const reachable = new Set<string>();
  const link: Link = { connected: () => reachable, assign: (h, r) => void sent.push([h, r]), cancel: () => {} };
  return { store, host, sent, reachable, link };
}

describe("tick", () => {
  it("assigns each queued run to a fitting connected host, highest priority first, and hands it over", () => {
    const { store, host, sent, reachable, link } = fleet();
    host("a");
    host("b", { os: "macos", capacity: { cpu: DEFAULT_CPU, memory: 4096 }, free: { cpu: DEFAULT_CPU, memory: 4096 } });
    reachable.add("a").add("b");
    const mac = run({ os: "macos", at: T0 });
    const low = run({ at: later(1) });
    const high = run({ priority: 3, at: later(2) });
    const third = run({ at: later(3) });
    for (const r of [low, high, mac, third]) store.create(r);

    expect(tick(store, link, later(5))).toEqual({ expired: 0, placed: 3 });
    // `high` first, on the host with more room; `mac` on the only macOS host; `low` where room is left.
    expect(sent.map(([h, r]) => [h, r.id])).toEqual([
      ["a", high.id],
      ["b", mac.id],
      ["a", low.id],
    ]);
    expect(store.run(high.id)).toMatchObject({ state: "assigned", host: "a", assignedAt: later(5) });
    expect(store.run(third.id)!.state).toBe("pending");
    // Nothing new to place: host "a" is full with what it was given.
    expect(tick(store, link, later(6)).placed).toBe(0);
  });

  it("places nothing on a host its metrics say is nearly out of disk or overloaded", () => {
    const { store, host, sent, reachable, link } = fleet();
    const well = { cpuLoad: 0.5, memoryUsed: 1000, memoryTotal: 8000, diskFree: 50_000, cpus: 4 };
    host("full", { metrics: { ...well, diskFree: 100 }, capacity: { cpu: 8, memory: 65536 }, free: null });
    host("busy", { metrics: { ...well, cpuLoad: 40 }, capacity: { cpu: 8, memory: 65536 }, free: null });
    host("well", { metrics: well });
    reachable.add("full").add("busy").add("well");
    store.create(run());
    store.create(run({ at: later(1) }));
    store.create(run({ at: later(2) }));
    expect(tick(store, link, later(5)).placed).toBe(2);
    expect(sent.map(([h]) => h)).toEqual(["well", "well"]);
  });

  it("places nothing on a host not connected, or silent too long", () => {
    const { store, host, sent, reachable, link } = fleet();
    host("gone");
    host("silent", { lastSeenAt: T0 });
    reachable.add("silent");
    store.create(run());
    expect(tick(store, link, later(FRESH_SECONDS + 1)).placed).toBe(0);
    expect(tick(store, link, later(FRESH_SECONDS)).placed).toBe(1);
    expect(sent.map(([h]) => h)).toEqual(["silent"]);
  });

  it("returns an assignment its host does not take in time to the queue, and places it again", () => {
    const { store, host, sent, reachable, link } = fleet();
    host("a", { lastSeenAt: later(100) });
    reachable.add("a");
    const r = run();
    store.create(r);
    expect(tick(store, link, later(1)).placed).toBe(1);
    reachable.delete("a");
    expect(tick(store, link, later(1 + ASSIGN_SECONDS))).toEqual({ expired: 1, placed: 0 });
    expect(store.run(r.id)).toMatchObject({ state: "pending", host: null });
    reachable.add("a");
    expect(tick(store, link, later(2 + ASSIGN_SECONDS)).placed).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("leaves a run taken meanwhile as it is", () => {
    const { store, host, reachable, link } = fleet();
    host("a");
    reachable.add("a");
    const r = run();
    store.create(r);
    tick(store, link, later(1));
    const taken = accepted(store.run(r.id)!, "a", later(2));
    store.update(taken, store.run(r.id)!.updatedAt);
    expect(tick(store, link, later(1 + ASSIGN_SECONDS)).expired).toBe(0);
    expect(store.run(r.id)!.state).toBe("running");
  });
});
