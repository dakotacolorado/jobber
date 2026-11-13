import { describe, expect, it } from "vitest";
import { accepted, ASSIGN_SECONDS, assigned, canceled, expired, FRESH_SECONDS, freeOn, schedule, submitted, unassigned, type Candidate, type Run } from "./domain.ts";
import { tick, type Link } from "./scheduler.ts";
import { Store, type StoredHost } from "./store.ts";

const COMMIT = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const T0 = "2026-11-13T00:00:00.000Z";
const later = (seconds: number, from = T0) => new Date(Date.parse(from) + seconds * 1000).toISOString();

const run = (over: { priority?: number; memory?: number; os?: "linux" | "macos"; at?: string } = {}): Run =>
  submitted(
    {
      repo: "o/r",
      commit: COMMIT,
      job: "hello",
      args: [],
      requirements: { os: over.os ?? null, arch: null, memory: over.memory ?? null, timeout: null },
      labels: {},
      priority: over.priority ?? 0,
    },
    over.at ?? T0,
  );

const candidate = (id: string, slots: number, memory: number, os: "linux" | "macos" = "linux"): Candidate => ({ id, os, arch: "x86_64", free: { slots, memory } });

describe("schedule", () => {
  it("places the highest priority first, then the oldest, while capacity lasts", () => {
    const old = run({ at: T0 });
    const young = run({ at: later(1) });
    const urgent = run({ priority: 5, at: later(2) });
    const placed = schedule([young, old, urgent], [candidate("a", 2, 8192)]);
    expect(placed.map((p) => p.run.id)).toEqual([urgent.id, old.id]);
  });

  it("puts each run on the fitting host with the most room, and passes over a run none fits", () => {
    const mac = run({ os: "macos" });
    const big = run({ memory: 6000, priority: 9 });
    const a = run({ at: later(1) });
    const b = run({ at: later(2) });
    const placed = schedule([mac, big, a, b], [candidate("small", 1, 2048), candidate("wide", 3, 4096)]);
    // `big` fits nowhere and does not hold up `a` and `b`; `mac` has no macOS host.
    expect(placed.map((p) => [p.run.id, p.host])).toEqual([
      [a.id, "wide"],
      [b.id, "wide"],
    ]);
    // Equal room: the lower id.
    expect(schedule([a, b, run({ at: later(3) })], [candidate("x", 1, 1024), candidate("y", 1, 1024)]).map((p) => p.host)).toEqual(["x", "y"]);
  });
});

describe("freeOn", () => {
  const host = { id: "h", slots: 3, memory: 4096, free: { slots: 3, memory: 4096 } };

  it("takes off the runs assigned or running there that its last report predates", () => {
    const mine = { ...assigned(run({ memory: 1000 }), "h", T0) };
    const theirs = assigned(run(), "other", T0);
    expect(freeOn(host, [mine, theirs])).toEqual({ slots: 2, memory: 3096 });
  });

  it("is never more than the host last reported", () => {
    expect(freeOn({ ...host, free: { slots: 1, memory: 500 } }, [])).toEqual({ slots: 1, memory: 500 });
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
      slots: 2,
      memory: 4096,
      labels: {},
      version: null,
      free: { slots: 2, memory: 4096 },
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
  const link: Link = { connected: () => reachable, assign: (h, r) => sent.push([h, r]) };
  return { store, host, sent, reachable, link };
}

describe("tick", () => {
  it("assigns each queued run to a fitting connected host, highest priority first, and hands it over", () => {
    const { store, host, sent, reachable, link } = fleet();
    host("a");
    host("b", { os: "macos", slots: 1, free: { slots: 1, memory: 4096 } });
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
