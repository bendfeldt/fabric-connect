import assert from "node:assert/strict";
import { test } from "node:test";
import { FabricApiError, LivyError } from "../src/core/errors";
import {
  LivySessionManager,
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
