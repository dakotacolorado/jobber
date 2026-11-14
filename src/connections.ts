import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { accepted, admittedCpu, admittedMemory, LEASE_SECONDS, leaseFrom, now, RequestError, unassigned, unstartable, type Run } from "./domain.ts";
import type { Link } from "./scheduler.ts";
import { ERROR_CODES, HostMessage, type ErrorStatus } from "./schema.ts";
import { Secrets } from "./secrets.ts";
import type { Store, StoredHost } from "./store.ts";

/** What jobber sends a host over its connection, as `docs/PROTOCOL.md` describes. */
export type ServiceMessage =
  | { type: "assign"; run: Run; attempt: number; cpu: number; memory: number; lease: number }
  | { type: "start"; run: string; attempt: number; lease: number; secrets?: Record<string, string> }
  | { type: "drop"; run: string; attempt: number; reason: string }
  | { type: "cancel"; run: string; attempt: number }
  | { type: "heartbeat"; cancel: string[]; ended: string[]; lease: number }
  | { type: "error"; message: string };

/** Closes a connection another from the same host has replaced. */
export const REPLACED = 4000;

/** The host connection's path; its id is the host's. */
const CONNECT = /^\/hosts\/([0-9a-f-]{36})\/connect(?:\?.*)?$/;

/** Answers who a host's `authorization` names, refusing with 401 or 403 as the API does. */
export type Authenticate = (authorization: string | undefined, id: string) => StoredHost;

interface Connection {
  socket: WebSocket;
  /** Has sent a heartbeat on this connection: until it has, the scheduler gives it nothing. */
  ready: boolean;
}

/**
 * The hosts holding a WebSocket open to jobber, one each: the
 * scheduler's `Link`. A host takes an assignment by accepting it, and it is
 * `running` there only once the answer is `start`, so an assignment resent
 * after a reconnect is never run twice.
 */
export class Connections implements Link {
  private readonly open = new Map<string, Connection>();
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  private readonly store: Store;
  private readonly log: (line: string) => void;
  private readonly secrets: Secrets;

  constructor(store: Store, log: (line: string) => void = console.log, secrets = new Secrets(store.db, null)) {
    this.store = store;
    this.log = log;
    this.secrets = secrets;
  }

  connected(): string[] {
    return [...this.open].filter(([, c]) => c.ready).map(([id]) => id);
  }

  /** Holds a connection open now, ready or not. */
  has(host: string): boolean {
    return this.open.has(host);
  }

  assign(host: string, run: Run): void {
    this.send(host, { type: "assign", run, attempt: run.attempt, cpu: admittedCpu(run), memory: admittedMemory(run), lease: LEASE_SECONDS });
  }

  cancel(host: string, run: Run): void {
    this.send(host, { type: "cancel", run: run.id, attempt: run.attempt });
  }

  /** Takes `server`'s upgrades to `/hosts/{id}/connect`, each under that host's own token; refuses any other. */
  attach(server: Server, authenticate: Authenticate): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const id = CONNECT.exec(req.url ?? "")?.[1];
      if (!id) return refuse(socket, 404, "Only /hosts/{id}/connect takes a WebSocket.");
      let host: StoredHost;
      try {
        host = authenticate(req.headers.authorization, id);
      } catch (err) {
        if (err instanceof RequestError) return refuse(socket, err.status, err.message);
        return refuse(socket, 500, "Something went wrong on our side.");
      }
      this.server.handleUpgrade(req, socket, head, (ws) => this.connect(host.id, ws));
    });
  }

  /** Closes every connection. */
  close(): void {
    for (const { socket } of this.open.values()) socket.close(1001, "jobber is stopping");
    this.open.clear();
    this.server.close();
  }

  private connect(host: string, socket: WebSocket): void {
    this.open.get(host)?.socket.close(REPLACED, "replaced");
    const connection: Connection = { socket, ready: false };
    this.open.set(host, connection);
    this.log(JSON.stringify({ connected: host }));
    socket.on("close", () => {
      if (this.open.get(host) !== connection) return;
      this.open.delete(host);
      this.log(JSON.stringify({ disconnected: host }));
    });
    socket.on("error", (err) => this.log(JSON.stringify({ host, error: err.message })));
    socket.on("message", (data, binary) => {
      if (this.open.get(host) !== connection) return;
      try {
        this.receive(host, connection, data, binary);
      } catch (err) {
        if (!(err instanceof RequestError)) this.log(JSON.stringify({ host, failed: (err as Error).message }));
        this.send(host, { type: "error", message: (err as Error).message });
      }
    });
    // Assignments waiting for this host, which a dropped connection may have lost.
    for (const run of this.store.inState("assigned")) if (run.host === host) this.assign(host, run);
  }

  private receive(host: string, connection: Connection, data: RawData, binary: boolean): void {
    if (binary) throw new RequestError("messages are JSON text", 400);
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      throw new RequestError("a message is one JSON object", 400);
    }
    const parsed = HostMessage.safeParse(json);
    if (!parsed.success) throw new RequestError(parsed.error.issues.map((i) => `${i.path.join(".") || "message"}: ${i.message}`).join("; "), 400);
    const message = parsed.data;
    const at = now();
    switch (message.type) {
      case "heartbeat": {
        this.store.seen(host, at, { free: message.free, metrics: message.metrics });
        const { cancel, ended } = this.store.renew(host, message.running, leaseFrom(at), at);
        this.send(host, { type: "heartbeat", cancel, ended, lease: LEASE_SECONDS });
        if (!connection.ready) {
          connection.ready = true;
          // A run started here whose `start` the last connection lost: the host does not run it, so it is offered again.
          const listed = new Set(message.running.map((r) => `${r.id}/${r.attempt}`));
          for (const run of this.store.inState("running")) if (run.host === host && !listed.has(`${run.id}/${run.attempt}`)) this.assign(host, run);
        }
        return;
      }
      case "accept": {
        const run = this.store.run(message.run);
        const drop = (reason: string) => this.send(host, { type: "drop", run: message.run, attempt: message.attempt, reason });
        if (!run) return drop("no such run");
        if (run.attempt !== message.attempt) return drop(`the run is on attempt ${run.attempt}`);
        // Its secrets travel only here, in the start, and only to the host it starts on.
        let secrets: Record<string, string> | undefined;
        try {
          if (run.secrets.length && run.host === host) secrets = this.secrets.values(run.secrets);
        } catch (err) {
          if (!(err instanceof RequestError) || run.state !== "assigned") throw err;
          this.store.update(unstartable(run, `not started: ${err.message}`, at), run.updatedAt);
          return drop(err.message);
        }
        try {
          const next = accepted(run, host, at);
          if (next !== run) this.store.update(next, run.updatedAt);
        } catch (err) {
          if (err instanceof RequestError && err.status === 409) return drop(err.message);
          throw err;
        }
        return this.send(host, { type: "start", run: run.id, attempt: run.attempt, lease: LEASE_SECONDS, ...(secrets && { secrets }) });
      }
      case "decline": {
        const run = this.store.run(message.run);
        if (run?.state !== "assigned" || run.host !== host || run.attempt !== message.attempt) return;
        this.store.update(unassigned(run, at), run.updatedAt);
        this.log(JSON.stringify({ declined: run.id, host, reason: message.reason }));
      }
    }
  }

  private send(host: string, message: ServiceMessage): void {
    const connection = this.open.get(host);
    if (connection?.socket.readyState === connection?.socket.OPEN) connection!.socket.send(JSON.stringify(message));
  }
}

/** An HTTP answer on a socket not upgraded, as `{code, message}`. */
function refuse(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ code: ERROR_CODES[status as ErrorStatus] ?? ERROR_CODES[500], message });
  const reason = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" }[status] ?? "Error";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}
