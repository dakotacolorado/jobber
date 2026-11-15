import { getOpenApiMetadata } from "@asteasolutions/zod-to-openapi";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "@hono/zod-openapi";
import * as routes from "./schema.ts";

export const INSTRUCTIONS = `jobber runs code on whatever computers you have, its hosts: a job is a named script in a repo's jobs.toml, a run one execution of it at one commit, placed by its scheduler on a host that meets its requirements (os, arch) and has its cpu, memory and GPUs free.

- A run is submitted pending, assigned to a host by the scheduler, running there, and ends succeeded, failed or canceled with its exit code.
- A run's log is read from a byte offset: get_run_log answers the bytes from offset, the log's size, and the run's state, so call it again from offset + the bytes read until the state has ended.
- Label runs to find them again (e.g. {"item": "28af81bc", "by": "agent-7"}); list_runs filters by label as key=value.
- Pending runs are taken highest priority first, then oldest: list_queue lists them in that order, next first. Give priority when submitting, or move a run with update_run_priority.
- Give retry {limit, backoff} to try a failed run again: each attempt keeps its own log and exit, the run's attempts lists the earlier ones, and get_run_log reads any by attempt.
- cancel_run ends a pending or assigned run at once; a running one is stopped by its host shortly after.
- delete_host takes a host that is gone or renamed out of list_hosts, keeping its runs and logs; one that heartbeats or registers again is back.
- Every tool takes the submitters' token this server was connected with. The host protocol (register, connect, heartbeat, append, complete) is jobber-host's, not tools.`;

/** The address the MCP docs give, a placeholder; served, the address they were reached at replaces it. */
export const DOCS_URL = "https://jobber.example.ts.net";

/** Sends one API request as the MCP request's caller, and gives its status, headers and body. */
export type Call = (method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }) => Promise<Response>;

const RunId = z.string().uuid().describe("The run's id.");

const query = (params: Record<string, string | number | string[] | undefined>) => {
  const set = Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [value].flat().map((each): [string, string] => [key, String(each)])));
  return set.length ? `?${new URLSearchParams(set)}` : "";
};

/**
 * `shape` with each field's OpenAPI description as its own: `.openapi()`
 * keeps a description where zod's JSON Schema, which MCP lists, cannot see it.
 */
const described = <Shape extends z.ZodRawShape>(shape: Shape): Shape =>
  Object.fromEntries(
    Object.entries(shape).map(([name, core]) => {
      // A raw shape types its fields as zod's core type; ours are classic zod.
      const field = core as z.ZodType;
      const text = field.description ?? getOpenApiMetadata(field)?.description;
      return [name, text ? field.describe(text) : field];
    }),
  ) as unknown as Shape;

type Answer = { content: { type: "text"; text: string }[]; isError?: true };

/** A JSON answer as the tool's text; an API error is the tool's error, in the API's words. */
async function answer(res: Response): Promise<Answer> {
  const text = res.status === 204 ? `${res.status}` : JSON.stringify(await res.json(), null, 2);
  return { content: [{ type: "text", text }], ...(res.status >= 400 && { isError: true as const }) };
}

/**
 * The MCP server for one request. Each tool is one API operation the
 * submitters' token can call, named as its `operationId` in snake_case, made
 * with the caller's own `authorization`, so it is refused and
 * recorded exactly as that request would be.
 */
export function mcpServer(version: string, call: Call): McpServer {
  const server = new McpServer({ name: "jobber", version }, { instructions: INSTRUCTIONS });

  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    inputSchema: Shape,
    run: (input: z.infer<z.ZodObject<Shape>>) => Promise<Answer>,
    hints: { readOnly?: boolean; destructive?: boolean } = {},
  ) => {
    server.registerTool(
      name,
      { title, description, inputSchema: described(inputSchema), annotations: { readOnlyHint: hints.readOnly ?? false, destructiveHint: hints.destructive ?? false } },
      // The SDK types a tool's input by its own zod; these are the API's schemas, which it validates the same.
      run as never,
    );
  };

  tool(
    "submit_run",
    "Submit a run",
    routes.submitRoute.description!,
    routes.SubmitSchema.shape,
    async (input) => answer(await call("POST", "/runs", { body: input })),
  );

  tool(
    "list_runs",
    "List runs",
    "Returns runs matching every filter given, newest first.",
    routes.ListQuery.shape,
    async (input) => answer(await call("GET", `/runs${query(input)}`)),
    { readOnly: true },
  );

  tool(
    "list_queue",
    "List the queue",
    routes.queueRoute.description!,
    routes.QueueQuery.shape,
    async (input) => answer(await call("GET", `/queue${query(input)}`)),
    { readOnly: true },
  );

  tool("get_run", "Get a run", "Returns one run.", { id: RunId }, async ({ id }) => answer(await call("GET", `/runs/${id}`)), { readOnly: true });

  tool(
    "get_run_log",
    "Read a run's log",
    "Returns the latest attempt's log, or `attempt`'s, from byte `offset`, at most 1 MiB, with the log's size so far and the attempt's state. " +
      "Empty when `offset` is the log's size: call again later from there while the run is `pending` or `running`.",
    {
      id: RunId,
      offset: z.int().min(0).optional().describe("The byte to read from; default 0."),
      attempt: z.int().min(1).optional().describe("Which attempt's log; default the latest. A run's `attempts` lists its earlier ones."),
    },
    async ({ id, offset = 0, attempt }) => {
      const res = await call("GET", `/runs/${id}/log${attempt === undefined ? "" : `?attempt=${attempt}`}`, { headers: { range: `bytes=${offset}-` } });
      if (res.status !== 206) return answer(res);
      const text = await res.text();
      const size = Number(res.headers.get("content-range")?.split("/")[1]);
      const read = { state: res.headers.get("run-state"), attempt: Number(res.headers.get("run-attempt")), offset, size, next: offset + Buffer.byteLength(text), log: text };
      return { content: [{ type: "text", text: JSON.stringify(read, null, 2) }] };
    },
    { readOnly: true },
  );

  tool(
    "cancel_run",
    "Cancel a run",
    routes.cancelRoute.description!,
    { id: RunId },
    async ({ id }) => answer(await call("POST", `/runs/${id}/cancel`)),
    { destructive: true },
  );

  tool(
    "update_run_priority",
    "Update run priority",
    routes.priorityRoute.description!,
    { id: RunId, ...routes.PrioritySchema.shape },
    async ({ id, priority }) => answer(await call("POST", `/runs/${id}/priority`, { body: { priority } })),
  );

  tool(
    "list_hosts",
    "List hosts",
    "Returns every host in the fleet, most recently seen first, with its capacity, free capacity and health.",
    {},
    async () => answer(await call("GET", "/hosts")),
    { readOnly: true },
  );

  tool(
    "delete_host",
    "Delete a host",
    routes.deleteHostRoute.description!,
    { id: z.string().uuid().describe("The host's id, as list_hosts gives it.") },
    async ({ id }) => answer(await call("DELETE", `/hosts/${id}`)),
    { destructive: true },
  );

  return server;
}
