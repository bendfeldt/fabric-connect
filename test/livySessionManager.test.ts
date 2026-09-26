import assert from "node:assert/strict";
import { test } from "node:test";
import { FabricApiError, LivyError } from "../src/core/errors";
import {
  LivySessionManager,
  listLivySessions,
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
