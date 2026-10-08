import assert from "node:assert/strict";
import { test } from "node:test";
import { FabricApiError, LivyError } from "../src/core/errors";
import { ExecutionDiagnostics } from "../src/core/executionDiagnostics";
import {
  LivySessionManager,
  listLivySessions,
  livyId,
  type LivyTarget,
  type SessionStore,
} from "../src/core/livySessionManager";
import {
  NEVER_CANCELLED,
  type CancelToken,
  type FabricRequestOptions,
  type FabricResponse,
  type IFabricApiClient,
} from "../src/core/types";

const TARGET: LivyTarget = {
  tenantId: "87654321-4321-4321-4321-cba987654321",
  workspaceId: "12345678-1234-1234-1234-123456789abc",
  lakehouseId: "11111111-2222-3333-4444-555555555555",
};

function memoryStore(initial: Record<string, string> = {}): SessionStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key),
    set: (key, value) => {
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, value);
      }
    },
  };
}

type Handler = (options: FabricRequestOptions) => unknown;

/** Scripted API: routes `METHOD suffix` to a handler; records every call. */
function scriptedApi(routes: Array<[RegExp, Handler]>): IFabricApiClient & {
  calls: FabricRequestOptions[];
} {
  const calls: FabricRequestOptions[] = [];
  return {
    calls,
    async request<T>(
      options: FabricRequestOptions,
    ): Promise<FabricResponse<T>> {
      calls.push(options);
      const key = `${options.method} ${options.path}`;
      for (const [pattern, handler] of routes) {
        if (pattern.test(key)) {
          const body = handler(options);
          if (body instanceof Error) {
            throw body;
          }
          return { status: 200, body: body as T };
        }
      }
      throw new Error(`no scripted route for ${key}`);
    },
  };
}

function manager(
  api: IFabricApiClient,
  store: SessionStore,
): LivySessionManager {
  return new LivySessionManager(api, store, {
    pollIntervalMs: 0,
    sleep: async () => undefined,
  });
}

test("starts a session, runs a statement, returns its data", async () => {
  let statementPolls = 0;
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "not_started" })],
    [/GET .*\/sessions\/7$/, () => ({ id: 7, state: "idle" })],
    [/POST .*\/sessions\/7\/statements$/, () => ({ id: 0, state: "waiting" })],
    [
      /GET .*\/sessions\/7\/statements\/0$/,
      () =>
        ++statementPolls < 2
          ? { id: 0, state: "running" }
          : {
              id: 0,
              state: "available",
              output: { status: "ok", data: { "text/plain": "42" } },
            },
    ],
  ]);
  const store = memoryStore();
  const result = await manager(api, store).execute(
    TARGET,
    "print(42)",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.data, { "text/plain": "42" });
  // Session ID persisted for reattachment after a reload.
  assert.equal([...store.data.values()][0], "7");
});

test("Fabric's GUID session IDs work end to end", async () => {
  const SESSION = "6a9d3b2e-1f4c-4e8a-9b7d-2c5e8f1a3d40";
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: SESSION, state: "starting" })],
    [new RegExp(`GET .*/sessions/${SESSION}$`), () => ({ state: "idle" })],
    [
      new RegExp(`POST .*/sessions/${SESSION}/statements$`),
      () => ({ id: 0, state: "waiting" }),
    ],
    [
      new RegExp(`GET .*/sessions/${SESSION}/statements/0$`),
      () => ({
        id: 0,
        state: "available",
        output: { status: "ok", data: { "text/plain": "1" } },
      }),
    ],
  ]);
  const store = memoryStore();
  const result = await manager(api, store).execute(
    TARGET,
    "spark.sql('SELECT 1')",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual([...store.data.values()], [SESSION]);
});

test("a persisted GUID session is reattached", async () => {
  const SESSION = "6a9d3b2e-1f4c-4e8a-9b7d-2c5e8f1a3d40";
  const key = `livy-session/${TARGET.tenantId}/${TARGET.workspaceId}/${TARGET.lakehouseId}`;
  const api = scriptedApi([
    [new RegExp(`GET .*/sessions/${SESSION}$`), () => ({ state: "idle" })],
    [
      new RegExp(`POST .*/sessions/${SESSION}/statements$`),
      () => ({ id: "3", state: "waiting" }),
    ],
    [
      new RegExp(`GET .*/sessions/${SESSION}/statements/3$`),
      () => ({ id: 3, state: "available", output: { status: "ok", data: {} } }),
    ],
  ]);
  const result = await manager(api, memoryStore({ [key]: SESSION })).execute(
    TARGET,
    "x",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.equal(result.status, "ok");
  assert.ok(
    !api.calls.some((c) => /POST .*\/sessions$/.test(`${c.method} ${c.path}`)),
  );
});

test("a session response without a usable ID names its fields, not values", async () => {
  const api = scriptedApi([
    [
      /POST .*\/sessions$/,
      () => ({ sessionId: "secret-value-xyz", state: "starting" }),
    ],
  ]);
  await assert.rejects(
    manager(api, memoryStore()).execute(
      TARGET,
      "x",
      "pyspark",
      NEVER_CANCELLED,
    ),
    (error: unknown) =>
      error instanceof LivyError &&
      error.kind === "protocol" &&
      /Response fields: sessionId, state\./.test(error.message) &&
      !/secret-value-xyz/.test(error.message),
  );
});

test("Livy IDs are path-safe: integers and GUID-like tokens only", () => {
  assert.equal(livyId(7), "7");
  assert.equal(livyId(" 6a9d3b2e-1f4c "), "6a9d3b2e-1f4c");
  for (const bad of [undefined, null, "", "../x", "a/b", -1, 1.5, NaN, {}]) {
    assert.equal(livyId(bad), undefined, String(bad));
  }
});

test("reattaches to a persisted live session instead of starting fresh", async () => {
  const api = scriptedApi([
    [/GET .*\/sessions\/42$/, () => ({ id: 42, state: "idle" })],
    [/POST .*\/sessions\/42\/statements$/, () => ({ id: 1, state: "waiting" })],
    [
      /GET .*\/sessions\/42\/statements\/1$/,
      () => ({ id: 1, state: "available", output: { status: "ok", data: {} } }),
    ],
  ]);
  const store = memoryStore({
    [`livy-session/${TARGET.tenantId}/${TARGET.workspaceId}/${TARGET.lakehouseId}`]:
      "42",
  });
  const result = await manager(api, store).execute(
    TARGET,
    "x",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.equal(result.status, "ok");
  assert.ok(
    !api.calls.some((c) => /POST .*\/sessions$/.test(`${c.method} ${c.path}`)),
  );
});

test("a cell's own exception is a result, not an extension error", async () => {
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
    [/GET .*\/sessions\/7$/, () => ({ id: 7, state: "idle" })],
    [/POST .*\/statements$/, () => ({ id: 0, state: "waiting" })],
    [
      /GET .*\/statements\/0$/,
      () => ({
        id: 0,
        state: "available",
        output: {
          status: "error",
          ename: "NameError",
          evalue: "name 'x' is not defined",
          traceback: ["Traceback...", "NameError: name 'x' is not defined"],
        },
      }),
    ],
  ]);
  const result = await manager(api, memoryStore()).execute(
    TARGET,
    "x",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.equal(result.status, "error");
  assert.equal(result.errorName, "NameError");
  assert.equal(result.traceback?.length, 2);
});

test("session start failure is an actionable infra error, distinct from cell errors", async () => {
  const api = scriptedApi([
    [
      /POST .*\/sessions$/,
      () =>
        new FabricApiError("boom", {
          operation: "call Fabric API",
          status: 500,
        }),
    ],
  ]);
  await assert.rejects(
    manager(api, memoryStore()).execute(
      TARGET,
      "x",
      "pyspark",
      NEVER_CANCELLED,
    ),
    (error: unknown) => {
      assert.ok(error instanceof LivyError);
      assert.equal(error.kind, "session-start");
      assert.match(error.message, /capacity may be paused/);
      assert.match(error.message, /Resume the capacity/);
      return true;
    },
  );
});

test("an unmapped session-start failure keeps the service's message and names the host", async () => {
  const api = scriptedApi([
    [
      /POST .*\/sessions$/,
      () =>
        new FabricApiError(
          "The Fabric API request 'POST /x' failed with HTTP 400 because the request was rejected. Service message: LakehouseNotFound",
          { operation: "call Fabric API", status: 400, correlationId: "c-1" },
        ),
    ],
  ]);
  await assert.rejects(
    manager(api, memoryStore()).execute(
      TARGET,
      "x",
      "pyspark",
      NEVER_CANCELLED,
    ),
    (error: unknown) => {
      assert.ok(error instanceof LivyError);
      assert.match(error.message, /Fabric rejected the session request/);
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /LakehouseNotFound/);
      assert.match(error.message, /c-1/);
      assert.match(
        error.message,
        new RegExp(
          `Lakehouse ${TARGET.lakehouseId} in workspace ${TARGET.workspaceId}`,
        ),
      );
      assert.doesNotMatch(error.message, /could not be started/);
      return true;
    },
  );
});

test("a session that dies while starting reports Livy's own reason", async () => {
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "starting" })],
    [
      /GET .*\/sessions\/7$/,
      () => ({
        id: 7,
        state: "dead",
        errorInfo: [{ message: "Workspace capacity is paused" }],
      }),
    ],
  ]);
  await assert.rejects(
    manager(api, memoryStore()).execute(
      TARGET,
      "x",
      "pyspark",
      NEVER_CANCELLED,
    ),
    (error: unknown) =>
      error instanceof LivyError &&
      /state 'dead'/.test(error.message) &&
      /Workspace capacity is paused/.test(error.message),
  );
});

test("mid-execution 404 is classified as session expiry and clears the store", async () => {
  const store = memoryStore();
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
    [/GET .*\/sessions\/7$/, () => ({ id: 7, state: "idle" })],
    [
      /POST .*\/statements$/,
      () =>
        new FabricApiError("gone", {
          operation: "call Fabric API",
          status: 404,
        }),
    ],
  ]);
  await assert.rejects(
    manager(api, store).execute(TARGET, "x", "pyspark", NEVER_CANCELLED),
    (error: unknown) => {
      assert.ok(error instanceof LivyError);
      assert.equal(error.kind, "session-expired");
      return true;
    },
  );
  assert.equal(store.data.size, 0);
});

test("executions on the same session are queued, not raced", async () => {
  const events: string[] = [];
  let statementCounter = 0;
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
    [/GET .*\/sessions\/7$/, () => ({ id: 7, state: "idle" })],
    [
      /POST .*\/statements$/,
      (options) => {
        const body = options.body as { code: string };
        events.push(`start:${body.code}`);
        return { id: statementCounter++, state: "waiting" };
      },
    ],
    [
      /GET .*\/statements\/\d+$/,
      (options) => {
        const id = options.path.split("/").pop();
        events.push(`finish:${id}`);
        return {
          id: Number(id),
          state: "available",
          output: { status: "ok", data: {} },
        };
      },
    ],
  ]);
  const livy = manager(api, memoryStore());
  await Promise.all([
    livy.execute(TARGET, "first", "pyspark", NEVER_CANCELLED),
    livy.execute(TARGET, "second", "pyspark", NEVER_CANCELLED),
  ]);
  assert.deepEqual(events, [
    "start:first",
    "finish:0",
    "start:second",
    "finish:1",
  ]);
});

test("cancellation cancels the running statement and reports cancelled", async () => {
  let cancelled = false;
  const token: CancelToken = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
    [/GET .*\/sessions\/7$/, () => ({ id: 7, state: "idle" })],
    [/POST .*\/statements$/, () => ({ id: 0, state: "waiting" })],
    [
      /GET .*\/statements\/0$/,
      () => {
        cancelled = true; // cancel while the statement is running
        return { id: 0, state: "running" };
      },
    ],
    [/POST .*\/statements\/0\/cancel$/, () => ({})],
  ]);
  const result = await manager(api, memoryStore()).execute(
    TARGET,
    "x",
    "pyspark",
    token,
  );
  assert.equal(result.status, "cancelled");
  assert.ok(
    api.calls.some((c) => c.path.endsWith("/statements/0/cancel")),
    "expected a cancel call to Livy",
  );
});

test("stopSession deletes the session and clears persisted state", async () => {
  const store = memoryStore({
    [`livy-session/${TARGET.tenantId}/${TARGET.workspaceId}/${TARGET.lakehouseId}`]:
      "9",
  });
  const api = scriptedApi([[/DELETE .*\/sessions\/9$/, () => ({})]]);
  await manager(api, store).stopSession(TARGET);
  assert.equal(store.data.size, 0);
  assert.equal(api.calls.length, 1);
});

test("a statement response without an ID is a protocol error, not a poll of /undefined", async () => {
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
    [/GET .*\/sessions\/7$/, () => ({ id: 7, state: "idle" })],
    [/POST .*\/sessions\/7\/statements$/, () => ({ state: "waiting" })],
  ]);
  await assert.rejects(
    manager(api, memoryStore()).execute(
      TARGET,
      "print(42)",
      "pyspark",
      NEVER_CANCELLED,
    ),
    (error: unknown) => {
      assert.ok(error instanceof LivyError);
      assert.equal(error.kind, "protocol");
      assert.match(error.message, /statement ID/);
      return true;
    },
  );
  assert.ok(
    !api.calls.some((c) => c.path.includes("undefined")),
    "must not poll a statement path containing 'undefined'",
  );
});

test("an Environment is attached at session start and keys its own session", async () => {
  const ENV = "33333333-3333-3333-3333-333333333333";
  let startBody: unknown;
  const api = scriptedApi([
    [
      /POST .*\/sessions$/,
      (options) => {
        startBody = options.body;
        return { id: 9, state: "starting" };
      },
    ],
    [/GET .*\/sessions\/9$/, () => ({ id: 9, state: "idle" })],
    [/POST .*\/sessions\/9\/statements$/, () => ({ id: 0, state: "waiting" })],
    [
      /GET .*\/sessions\/9\/statements\/0$/,
      () => ({ id: 0, state: "available", output: { status: "ok", data: {} } }),
    ],
  ]);
  const store = memoryStore();
  await manager(api, store).execute(
    { ...TARGET, environmentId: ENV },
    "1",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.deepEqual(startBody, {
    conf: { "spark.fabric.environmentDetails": JSON.stringify({ id: ENV }) },
  });
  assert.deepEqual(
    [...store.data.keys()],
    [
      `livy-session/${TARGET.tenantId}/${TARGET.workspaceId}/${TARGET.lakehouseId}/${ENV}`,
    ],
  );
});

test("the bootstrap runs once per session, before the first statement", async () => {
  const submitted: string[] = [];
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 5, state: "idle" })],
    [/GET .*\/sessions\/5$/, () => ({ id: 5, state: "idle" })],
    [
      /POST .*\/sessions\/5\/statements$/,
      (options) => {
        const code = (options.body as { code: string }).code;
        submitted.push(code);
        return { id: submitted.length, state: "waiting" };
      },
    ],
    [
      /GET .*\/sessions\/5\/statements\/\d+$/,
      () => ({ id: 1, state: "available", output: { status: "ok", data: {} } }),
    ],
  ]);
  const livy = new LivySessionManager(api, memoryStore(), {
    pollIntervalMs: 0,
    sleep: async () => undefined,
    bootstrap: { code: "def display(x): pass", kind: "pyspark" },
  });
  await livy.execute(TARGET, "a = 1", "pyspark", NEVER_CANCELLED);
  await livy.execute(TARGET, "b = 2", "pyspark", NEVER_CANCELLED);
  assert.deepEqual(submitted, ["def display(x): pass", "a = 1", "b = 2"]);
});

test("a failing bootstrap does not fail the user's statement", async () => {
  let first = true;
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 5, state: "idle" })],
    [/GET .*\/sessions\/5$/, () => ({ id: 5, state: "idle" })],
    [
      /POST .*\/sessions\/5\/statements$/,
      () => {
        if (first) {
          first = false;
          return new Error("bootstrap rejected");
        }
        return { id: 2, state: "waiting" };
      },
    ],
    [
      /GET .*\/sessions\/5\/statements\/2$/,
      () => ({
        id: 2,
        state: "available",
        output: { status: "ok", data: { "text/plain": "ok" } },
      }),
    ],
  ]);
  const livy = new LivySessionManager(api, memoryStore(), {
    pollIntervalMs: 0,
    sleep: async () => undefined,
    bootstrap: { code: "boom", kind: "pyspark" },
  });
  const result = await livy.execute(TARGET, "x", "pyspark", NEVER_CANCELLED);
  assert.deepEqual(result.data, { "text/plain": "ok" });
});

test("startSession starts eagerly; stopSessionById stops orphans and our own", async () => {
  const deleted: string[] = [];
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 8, state: "idle" })],
    [/GET .*\/sessions\/8$/, () => ({ id: 8, state: "idle" })],
    [
      /DELETE .*\/sessions\/[\w-]+$/,
      (options) => {
        deleted.push(options.path.split("/").pop() ?? "");
        return {};
      },
    ],
  ]);
  const store = memoryStore();
  const livy = manager(api, store);
  await livy.startSession(TARGET, NEVER_CANCELLED);
  assert.equal([...store.data.values()][0], "8");
  await livy.stopSessionById(TARGET, "orphan-1");
  assert.equal([...store.data.values()][0], "8", "orphan stop keeps ours");
  await livy.stopSessionById(TARGET, "8");
  assert.deepEqual(deleted, ["orphan-1", "8"]);
  assert.equal(store.data.size, 0);
});

test("listLivySessions maps the monitoring API and skips entries without IDs", async () => {
  const api = scriptedApi([
    [
      /GET \/workspaces\/.*\/lakehouses\/.*\/livySessions$/,
      () => ({
        value: [
          {
            livyId: "abc",
            state: "InProgress",
            jobType: "SparkSession",
            livyName: "my session",
            submittedDateTime: "2026-09-26T10:00:00Z",
          },
          { state: "Succeeded" },
        ],
      }),
    ],
  ]);
  assert.deepEqual(await listLivySessions(api, TARGET), [
    {
      livyId: "abc",
      state: "InProgress",
      jobType: "SparkSession",
      name: "my session",
      itemName: undefined,
      submittedDateTime: "2026-09-26T10:00:00Z",
    },
  ]);
});

test("execution diagnostics distinguish startup, bootstrap and warm statements without logging code or IDs", async () => {
  const logs: string[] = [];
  let clock = 0;
  let statements = 0;
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "starting" })],
    [
      /GET .*\/sessions\/7$/,
      () => {
        clock += 40;
        return { state: "idle" };
      },
    ],
    [
      /POST .*\/statements$/,
      () => {
        clock += 3;
        return { id: statements++, state: "waiting" };
      },
    ],
    [
      /GET .*\/statements\/\d+$/,
      () => {
        clock += 12;
        return {
          state: "available",
          output: { status: "ok", data: { "text/plain": "private-result" } },
        };
      },
    ],
  ]);
  const options = {
    pollIntervalMs: 0,
    sleep: async () => undefined,
    bootstrap: { code: "private-bootstrap", kind: "pyspark" },
    logger: { debug: (message: string) => logs.push(message) },
    now: () => clock,
  };
  const livy = new LivySessionManager(api, memoryStore(), options);
  await livy.execute(TARGET, "private-code", "pyspark", NEVER_CANCELLED);
  await livy.execute(TARGET, "private-code", "pyspark", NEVER_CANCELLED);
  const phases = logs.map((line) => /phase=([^ ]+)/.exec(line)?.[1]);
  assert.deepEqual(phases, [
    "queue.user",
    "session.start",
    "bootstrap.submit",
    "bootstrap.wait",
    "session.acquire",
    "statement.submit.user",
    "statement.wait.user",
    "total",
    "queue.user",
    "session.acquire",
    "statement.submit.user",
    "statement.wait.user",
    "total",
  ]);
  assert.ok(
    logs.some((line) =>
      /phase=session.start durationMs=40 outcome=ok$/.test(line),
    ),
  );
  assert.ok(
    logs.some((line) =>
      /phase=statement.wait.user durationMs=12 outcome=ok$/.test(line),
    ),
  );
  const log = logs.join("\n");
  for (const value of [
    ...Object.values(TARGET),
    "private-code",
    "private-bootstrap",
    "private-result",
  ]) {
    assert.ok(!log.includes(value), `diagnostics must not contain ${value}`);
  }
});

test("the Variable Library notebook-state failure gets guidance without replacing its traceback", async () => {
  const errorValue =
    'Failed to resolve variable reference: $(/**/vl_analytics/*), status code: 400, response:{"reason":"The notebook example-id state was not found."}';
  const traceback = [
    "analytics/config.py: notebookutils.variableLibrary.getLibrary(library_name)",
    errorValue,
  ];
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
    [/GET .*\/sessions\/7$/, () => ({ state: "idle" })],
    [/POST .*\/statements$/, () => ({ id: 0, state: "waiting" })],
    [
      /GET .*\/statements\/0$/,
      () => ({
        state: "available",
        output: {
          status: "error",
          ename: "Py4JJavaError",
          evalue: errorValue,
          traceback,
        },
      }),
    ],
  ]);
  const result = await manager(api, memoryStore()).execute(
    TARGET,
    "configuration()",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.equal(result.status, "error");
  assert.equal(result.errorName, "Py4JJavaError");
  assert.equal(result.errorValue, errorValue);
  assert.deepEqual(result.traceback, traceback);
  assert.ok("hint" in result && typeof result.hint === "string");
  assert.match(result.hint, /Lakehouse Livy session/);
  assert.match(result.hint, /deployed.*notebook/);
  assert.ok(!result.hint.includes("example-id"));
  assert.equal(
    api.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/statements"),
    ).length,
    1,
  );
});

test("runtime guidance matches error values or traceback but not unrelated library and Py4J errors", async () => {
  const signature =
    "notebookutils.variableLibrary.getLibrary: Failed to resolve variable reference: The notebook example-id state was not found.";
  const cases = [
    { evalue: signature, traceback: [], expected: true },
    { evalue: "Py4JJavaError", traceback: [signature], expected: true },
    {
      evalue: signature.replace("state was not found", "library was not found"),
      traceback: [],
      expected: false,
    },
    {
      evalue: signature.replace("variableLibrary", "otherApi"),
      traceback: [],
      expected: false,
    },
    {
      evalue: signature.replace(
        "Failed to resolve variable reference",
        "Access denied",
      ),
      traceback: [],
      expected: false,
    },
    { evalue: "HTTP 400: SQL syntax error", traceback: [], expected: false },
    { evalue: undefined, traceback: undefined, expected: false },
  ];
  for (const { evalue, traceback, expected } of cases) {
    const api = scriptedApi([
      [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
      [/GET .*\/sessions\/7$/, () => ({ state: "idle" })],
      [/POST .*\/statements$/, () => ({ id: 0, state: "waiting" })],
      [
        /GET .*\/statements\/0$/,
        () => ({
          state: "available",
          output: {
            status: "error",
            ename: "Py4JJavaError",
            evalue,
            traceback,
          },
        }),
      ],
    ]);
    const result = await manager(api, memoryStore()).execute(
      TARGET,
      "x",
      "pyspark",
      NEVER_CANCELLED,
    );
    assert.equal(result.hint !== undefined, expected);
    assert.equal(result.status, "error");
    assert.equal(result.errorValue, evalue ?? "");
    assert.deepEqual(result.traceback, traceback ?? []);
  }
});

test("a reattached session and module setup are labelled separately from user statements", async () => {
  const logs: string[] = [];
  let clock = 0;
  const api = scriptedApi([
    [
      /GET .*\/sessions\/42$/,
      () => {
        clock += 8;
        return { state: "idle" };
      },
    ],
    [/POST .*\/statements$/, () => ({ id: 0, state: "waiting" })],
    [
      /GET .*\/statements\/0$/,
      () => ({
        state: "available",
        output: { status: "ok", data: {} },
      }),
    ],
  ]);
  const logger = { debug: (message: string) => logs.push(message) };
  const livy = new LivySessionManager(
    api,
    memoryStore({
      [`livy-session/${TARGET.tenantId}/${TARGET.workspaceId}/${TARGET.lakehouseId}`]:
        "42",
    }),
    { logger, now: () => clock },
  );
  const diagnostics = new ExecutionDiagnostics(logger, () => clock);
  await livy.execute(
    TARGET,
    "module prelude",
    "pyspark",
    NEVER_CANCELLED,
    diagnostics,
    "module-setup",
  );
  await livy.execute(
    TARGET,
    "user cell",
    "pyspark",
    NEVER_CANCELLED,
    diagnostics,
  );
  diagnostics.finish("ok");
  assert.ok(
    logs.some((line) =>
      /phase=session.reattach durationMs=8 outcome=ok$/.test(line),
    ),
  );
  assert.equal(logs.filter((line) => line.includes("phase=total")).length, 1);
  assert.ok(
    logs.some((line) => line.includes("phase=statement.wait.module-setup")),
  );
  assert.ok(logs.some((line) => line.includes("phase=statement.wait.user")));
  assert.ok(!logs.some((line) => line.includes("phase=session.start")));
  assert.equal(api.calls.length, 5);
});

test("diagnostics measure queue wait and report cancellation without a new session request", async () => {
  const logs: string[] = [];
  let clock = 0;
  let statement = 0;
  let waiting = true;
  let release: () => void = () => undefined;
  let sleeping: () => void = () => undefined;
  const reachedSleep = new Promise<void>((resolve) => {
    sleeping = resolve;
  });
  const sleep = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
    [/GET .*\/sessions\/7$/, () => ({ state: "idle" })],
    [/POST .*\/statements$/, () => ({ id: statement++, state: "waiting" })],
    [
      /GET .*\/statements\/\d+$/,
      () =>
        waiting
          ? { state: "running" }
          : { state: "available", output: { status: "ok", data: {} } },
    ],
  ]);
  const livy = new LivySessionManager(api, memoryStore(), {
    logger: { debug: (message) => logs.push(message) },
    now: () => clock,
    sleep: async () => {
      sleeping();
      await sleep;
    },
  });
  const first = livy.execute(TARGET, "first", "pyspark", NEVER_CANCELLED);
  await reachedSleep;
  const second = livy.execute(TARGET, "second", "pyspark", NEVER_CANCELLED);
  clock += 30;
  waiting = false;
  release();
  await Promise.all([first, second]);
  assert.ok(
    logs.some((line) =>
      /phase=queue.user durationMs=30 outcome=ok$/.test(line),
    ),
  );
  const callsBeforeCancel = api.calls.length;
  const cancelled: CancelToken = {
    ...NEVER_CANCELLED,
    isCancellationRequested: true,
  };
  await assert.rejects(
    livy.execute(TARGET, "cancelled", "pyspark", cancelled),
    (error: unknown) =>
      error instanceof LivyError && error.kind === "cancelled",
  );
  assert.equal(api.calls.length, callsBeforeCancel);
  assert.match(
    logs.at(-1) ?? "",
    /phase=total durationMs=0 outcome=cancelled$/,
  );
});

test("failed startup and bootstrap are diagnosed without changing existing failure handling", async () => {
  const logs: string[] = [];
  const failure = new FabricApiError("private failure", {
    operation: "start",
    status: 403,
  });

  const failedApi = scriptedApi([[/POST .*\/sessions$/, () => failure]]);
  const options = {
    logger: { debug: (message: string) => logs.push(message) },
    now: () => 0,
    bootstrap: { code: "bootstrap", kind: "pyspark" },
  };
  await assert.rejects(
    new LivySessionManager(failedApi, memoryStore(), options).execute(
      TARGET,
      "x",
      "pyspark",
      NEVER_CANCELLED,
    ),
    (error: unknown) =>
      error instanceof LivyError && error.kind === "session-start",
  );
  assert.ok(
    logs.some((line) =>
      /phase=session.start durationMs=0 outcome=error$/.test(line),
    ),
  );
  assert.match(logs.at(-1) ?? "", /outcome=error$/);
  logs.length = 0;
  let submitted = 0;
  const api = scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
    [/GET .*\/sessions\/7$/, () => ({ state: "idle" })],
    [/POST .*\/statements$/, () => ({ id: submitted++, state: "waiting" })],
    [
      /GET .*\/statements\/0$/,
      () => ({
        state: "available",
        output: { status: "error", ename: "ValueError", evalue: "private" },
      }),
    ],
    [
      /GET .*\/statements\/1$/,
      () => ({
        state: "available",
        output: { status: "ok", data: {} },
      }),
    ],
  ]);
  const result = await new LivySessionManager(
    api,
    memoryStore(),
    options,
  ).execute(TARGET, "x", "pyspark", NEVER_CANCELLED);
  assert.equal(result.status, "ok");
  assert.ok(
    logs.some((line) =>
      /phase=bootstrap.wait durationMs=0 outcome=error$/.test(line),
    ),
  );
  assert.match(logs.at(-1) ?? "", /outcome=ok$/);
});

test("reattachment readiness failures propagate without starting a replacement session", async () => {
  for (const mode of ["cancelled", "dead"] as const) {
    const logs: string[] = [];
    let cancelled = false;
    let polls = 0;
    const token: CancelToken = {
      ...NEVER_CANCELLED,
      get isCancellationRequested() {
        return cancelled;
      },
    };
    const api = scriptedApi([
      [
        /GET .*\/sessions\/42$/,
        () => {
          if (++polls === 1) {
            cancelled = mode === "cancelled";
            return { state: "starting" };
          }
          return { state: "dead" };
        },
      ],
      [/POST .*\/sessions$/, () => ({ id: 99, state: "idle" })],
      [/GET .*\/sessions\/99$/, () => ({ state: "dead" })],
    ]);
    const livy = new LivySessionManager(
      api,
      memoryStore({
        [`livy-session/${TARGET.tenantId}/${TARGET.workspaceId}/${TARGET.lakehouseId}`]:
          "42",
      }),
      { logger: { debug: (message) => logs.push(message) } },
    );
    await assert.rejects(
      livy.execute(TARGET, "x", "pyspark", token),
      (error: unknown) =>
        error instanceof LivyError &&
        error.kind === (mode === "cancelled" ? "cancelled" : "session-start"),
    );
    assert.ok(!api.calls.some((call) => call.method === "POST"), mode);
    assert.ok(
      logs.some((line) =>
        new RegExp(
          `phase=session.reattach .*outcome=${mode === "cancelled" ? "cancelled" : "error"}$`,
        ).test(line),
      ),
    );
    assert.ok(!logs.some((line) => line.includes("phase=session.start")));
  }
});
