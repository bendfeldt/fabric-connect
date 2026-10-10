import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthError, FabricApiError, LivyError } from "../src/core/errors";
import { ExecutionDiagnostics } from "../src/core/executionDiagnostics";
import { FabricApiClient } from "../src/core/fabricApiClient";
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

interface RecoveryCall {
  readonly method: string;
  readonly path: string;
  readonly code?: string;
}

function recoveryResponse(status: number, message?: unknown): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "x-ms-request-id": "corr-terminal" },
  });
}

function terminalMessage(
  sessionId: string,
  workspaceId = TARGET.workspaceId,
): string {
  return `Session ${sessionId} of workspace ${workspaceId} is in a terminal state. Scheduler state : Ended. Plugin state : Ended. Livy state : dead`;
}

function requestSession(call: RecoveryCall): string {
  const id = /\/sessions\/([^/]+)\/statements(?:\/[^/]+)?$/.exec(
    call.path,
  )?.[1];
  assert.ok(id, "Expected a session statement request");
  return id;
}

function recoveryApi(
  respond: (call: RecoveryCall) => Response | Promise<Response> | undefined,
) {
  const calls: RecoveryCall[] = [];
  let started = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const call: RecoveryCall = {
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
      code:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { code?: string }).code
          : undefined,
    };
    calls.push(call);
    const response = respond(call);
    if (response !== undefined) {
      return response;
    }
    let body: unknown;
    if (call.method === "POST" && call.path.endsWith("/sessions")) {
      body = {
        id: `00000000-0000-4000-8000-${String(++started).padStart(12, "0")}`,
        state: "starting",
      };
    } else if (call.method === "POST" && call.path.endsWith("/statements")) {
      body = { id: 0, state: "waiting" };
    } else if (call.method === "GET" && call.path.endsWith("/statements/0")) {
      body = { id: 0, state: "available", output: { status: "ok", data: {} } };
    } else if (call.method === "GET" && /\/sessions\/[^/]+$/.test(call.path)) {
      body = { state: "idle" };
    } else if (
      call.method === "DELETE" &&
      /\/sessions\/[^/]+$/.test(call.path)
    ) {
      body = {};
    } else {
      throw new Error(
        `Unexpected recovery request: ${call.method} ${call.path}`,
      );
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return {
    calls,
    client: new FabricApiClient(
      { getToken: async () => "test-token" },
      { fetchFn, sleep: async () => undefined },
    ),
    get started() {
      return started;
    },
  };
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

test("terminal-session HTTP 400 recovers on the next run without reload or replay", async () => {
  let dead = false;
  const api = recoveryApi((call) =>
    dead && call.method === "POST" && call.path.endsWith("/statements")
      ? recoveryResponse(400, terminalMessage(requestSession(call)))
      : undefined,
  );
  const store = memoryStore();
  const livy = manager(api.client, store);
  await livy.execute(TARGET, "first", "pyspark", NEVER_CANCELLED);
  dead = true;
  await assert.rejects(
    livy.execute(TARGET, "failed", "pyspark", NEVER_CANCELLED),
    (error: unknown) => {
      assert.ok(error instanceof LivyError);
      assert.equal(error.kind, "session-expired");
      assert.ok(error.cause instanceof FabricApiError);
      assert.equal(error.cause.status, 400);
      assert.equal(error.cause.correlationId, "corr-terminal");
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /Livy state : dead/);
      assert.match(error.message, /corr-terminal/);
      return true;
    },
  );
  assert.equal(store.data.size, 0);
  assert.equal(api.started, 1);
  await assert.rejects(
    livy.execute(TARGET, "cancelled", "pyspark", {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    }),
    (error: unknown) =>
      error instanceof LivyError && error.kind === "cancelled",
  );
  assert.equal(api.started, 1);
  dead = false;
  assert.equal(
    (await livy.execute(TARGET, "next", "pyspark", NEVER_CANCELLED)).status,
    "ok",
  );
  assert.equal(api.started, 2);
  assert.deepEqual(
    api.calls.filter((call) => call.code).map((call) => call.code),
    ["first", "failed", "next"],
  );
  assert.equal(
    api.calls.filter(
      (call) => call.method === "GET" && /\/sessions\/[^/]+$/.test(call.path),
    ).length,
    2,
  );
  assert.ok(!api.calls.some((call) => call.method === "DELETE"));
});

for (const [label, status, detail] of [
  ["generic rejection", 400, () => "Invalid statement"],
  [
    "nonterminal state",
    400,
    (id: string) => terminalMessage(id).replace("dead", "busy"),
  ],
  [
    "nonterminal scheduler",
    400,
    (id: string) =>
      terminalMessage(id).replace(
        "Scheduler state : Ended",
        "Scheduler state : Starting",
      ),
  ],
  [
    "truncated detail",
    400,
    (id: string) => terminalMessage(id).split(" Plugin")[0],
  ],
  ["wrong session", 400, () => terminalMessage("other-session")],
  [
    "wrong workspace",
    400,
    (id: string) => terminalMessage(id, "other-workspace"),
  ],
  [
    "embedded user text",
    400,
    (id: string) => `Invalid code: ${terminalMessage(id)}`,
  ],
  [
    "trailing user text",
    400,
    (id: string) => `${terminalMessage(id)} in supplied code`,
  ],
  ["malformed detail", 400, () => ({ state: "dead" })],
  ["authentication failure", 401, (id: string) => terminalMessage(id)],
  ["access failure", 403, (id: string) => terminalMessage(id)],
] as const) {
  test(`${label} does not invalidate a cached session`, async () => {
    let failed = false;
    const api = recoveryApi((call) =>
      failed && call.method === "POST" && call.path.endsWith("/statements")
        ? recoveryResponse(status, detail(requestSession(call)))
        : undefined,
    );
    const store = memoryStore();
    const livy = manager(api.client, store);
    await livy.execute(TARGET, "first", "pyspark", NEVER_CANCELLED);
    const original = [...store.data.entries()];
    failed = true;
    await assert.rejects(
      livy.execute(TARGET, "failed", "pyspark", NEVER_CANCELLED),
      FabricApiError,
    );
    assert.deepEqual([...store.data.entries()], original);
    failed = false;
    await livy.execute(TARGET, "next", "pyspark", NEVER_CANCELLED);
    assert.equal(api.started, 1);
  });
}

for (const status of [400, 404]) {
  for (const reattach of [false, true]) {
    test(`late HTTP ${status} cannot clear a newer ${reattach ? "reattached" : "replacement"} session generation`, async () => {
      let finishOld: ((response: Response) => void) | undefined;
      let submitted: (() => void) | undefined;
      const oldSubmitted = new Promise<void>((resolve) => {
        submitted = resolve;
      });
      const api = recoveryApi((call) => {
        if (call.code !== "old") {
          return undefined;
        }
        submitted?.();
        return new Promise<Response>((resolve) => {
          finishOld = resolve;
        });
      });
      const store = memoryStore();
      const livy = manager(api.client, store);
      await livy.startSession(TARGET, NEVER_CANCELLED);
      const oldId = [...store.data.values()][0];
      const old = livy.execute(TARGET, "old", "pyspark", NEVER_CANCELLED);
      const rejected = assert.rejects(old);
      await oldSubmitted;
      if (reattach) {
        await livy.dispose();
      } else {
        await livy.stopSession(TARGET);
      }
      await livy.startSession(TARGET, NEVER_CANCELLED);
      const current = [...store.data.entries()];
      finishOld?.(recoveryResponse(status, terminalMessage(oldId)));
      await rejected;
      assert.deepEqual([...store.data.entries()], current);
      await livy.execute(TARGET, "next", "pyspark", NEVER_CANCELLED);
      assert.equal(api.started, reattach ? 1 : 2);
    });
  }
}

test("terminal recovery leaves other hosts and Environments cached", async () => {
  const api = recoveryApi((call) =>
    call.code === "failed"
      ? recoveryResponse(400, terminalMessage(requestSession(call)))
      : undefined,
  );
  const store = memoryStore();
  const livy = manager(api.client, store);
  const otherHost = {
    ...TARGET,
    lakehouseId: "22222222-2222-3333-4444-555555555555",
  };
  const otherEnvironment = {
    ...TARGET,
    environmentId: "33333333-2222-3333-4444-555555555555",
  };
  for (const target of [TARGET, otherHost, otherEnvironment]) {
    await livy.startSession(target, NEVER_CANCELLED);
  }
  const others = [...store.data.entries()].slice(1);
  await assert.rejects(
    livy.execute(TARGET, "failed", "pyspark", NEVER_CANCELLED),
  );
  assert.deepEqual([...store.data.entries()], others);
  for (const target of [otherHost, otherEnvironment]) {
    await livy.execute(target, "next", "pyspark", NEVER_CANCELLED);
  }
  assert.equal(api.started, 3);
});

for (const phase of ["readiness", "creation", "reattachment"] as const) {
  test(`late ${phase} response cannot change a replacement's persisted ID`, async () => {
    let finishOld: ((response: Response) => void) | undefined;
    let announceOld: (() => void) | undefined;
    const oldPending = new Promise<void>((resolve) => {
      announceOld = resolve;
    });
    let intercepted = false;
    const api = recoveryApi((call) => {
      const acquisitionRequest =
        phase === "creation"
          ? call.method === "POST" && call.path.endsWith("/sessions")
          : call.method === "GET" && /\/sessions\/[^/]+$/.test(call.path);
      if (intercepted || !acquisitionRequest) {
        return undefined;
      }
      intercepted = true;
      announceOld?.();
      return new Promise<Response>((resolve) => {
        finishOld = resolve;
      });
    });
    const key = `livy-session/${TARGET.tenantId}/${TARGET.workspaceId}/${TARGET.lakehouseId}`;
    const store = memoryStore(
      phase === "reattachment" ? { [key]: "old-session" } : {},
    );
    const livy = manager(api.client, store);
    const oldOutcome = livy.startSession(TARGET, NEVER_CANCELLED).then(
      () => ({ status: "ok" as const }),
      (error: unknown) => ({ status: "error" as const, error }),
    );
    await oldPending;
    await livy.stopSession(TARGET);
    await livy.startSession(TARGET, NEVER_CANCELLED);
    const replacement = [...store.data.entries()];
    assert.equal(replacement.length, 1);
    assert.ok(finishOld);
    finishOld(
      new Response(
        JSON.stringify(
          phase === "creation"
            ? { id: "old-session", state: "starting" }
            : { state: "dead" },
        ),
        { status: 200 },
      ),
    );
    const outcome = await oldOutcome;
    assert.deepEqual([...store.data.entries()], replacement);
    assert.equal(outcome.status, "error");
    if (outcome.status === "error") {
      assert.ok(outcome.error instanceof LivyError);
      assert.equal(
        outcome.error.kind,
        phase === "readiness" ? "session-start" : "cancelled",
      );
    }
    const requests = api.calls.length;
    await livy.execute(TARGET, "next", "pyspark", NEVER_CANCELLED);
    assert.equal(api.calls.length, requests + 2);
    assert.equal(api.started, phase === "readiness" ? 2 : 1);
  });
}

test("stop before acquisition begins makes no remote session request", async () => {
  const api = recoveryApi(() => undefined);
  const store = memoryStore();
  const livy = manager(api.client, store);
  const outcome = livy.startSession(TARGET, NEVER_CANCELLED).then(
    () => ({ status: "ok" as const }),
    (error: unknown) => ({ status: "error" as const, error }),
  );
  await livy.stopSession(TARGET);
  const result = await outcome;
  assert.deepEqual(api.calls, []);
  assert.equal(store.data.size, 0);
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.ok(result.error instanceof LivyError);
    assert.equal(result.error.kind, "cancelled");
  }
});

test("terminal recovery bootstraps the replacement and preserves explicit preparation", async () => {
  const api = recoveryApi((call) =>
    call.code === "failed"
      ? recoveryResponse(400, terminalMessage(requestSession(call)))
      : undefined,
  );
  const livy = new LivySessionManager(api.client, memoryStore(), {
    bootstrap: { code: "bootstrap", kind: "pyspark" },
    pollIntervalMs: 0,
    sleep: async () => undefined,
  });
  await livy.execute(TARGET, "first", "pyspark", NEVER_CANCELLED);
  await assert.rejects(
    livy.execute(TARGET, "failed", "pyspark", NEVER_CANCELLED),
  );
  await livy.execute(
    TARGET,
    "prepare",
    "pyspark",
    NEVER_CANCELLED,
    undefined,
    "module-setup",
  );
  await livy.execute(TARGET, "next", "pyspark", NEVER_CANCELLED);
  assert.equal(api.started, 2);
  assert.deepEqual(
    api.calls.filter((call) => call.code).map((call) => call.code),
    ["bootstrap", "first", "failed", "bootstrap", "prepare", "next"],
  );
});

test("statement polling preserves 404 recovery but does not classify terminal-shaped HTTP 400", async () => {
  for (const status of [400, 404]) {
    const api = recoveryApi((call) =>
      call.method === "GET" && call.path.endsWith("/statements/0")
        ? recoveryResponse(status, terminalMessage(requestSession(call)))
        : undefined,
    );
    const store = memoryStore();
    await assert.rejects(
      manager(api.client, store).execute(
        TARGET,
        "x",
        "pyspark",
        NEVER_CANCELLED,
      ),
      status === 404 ? LivyError : FabricApiError,
    );
    assert.equal(store.data.size, status === 404 ? 0 : 1);
  }
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

test("a reattach failure other than 404 keeps the saved session instead of starting another", async () => {
  const key = `livy-session/${TARGET.tenantId}/${TARGET.workspaceId}/${TARGET.lakehouseId}`;
  const failures: Array<[string, Error]> = [
    [
      "503",
      new FabricApiError("unavailable", {
        operation: "call Fabric API",
        status: 503,
      }),
    ],
    [
      "403",
      new FabricApiError("forbidden", {
        operation: "call Fabric API",
        status: 403,
      }),
    ],
    [
      "network",
      new FabricApiError("network", { operation: "call Fabric API" }),
    ],
  ];
  failures.push([
    "sign-in",
    new AuthError("cancelled", { operation: "acquire token" }),
  ]);
  for (const [label, failure] of failures) {
    const api = scriptedApi([
      [/GET .*\/sessions\/42$/, () => failure],
      [/POST .*\/sessions$/, () => ({ id: 99, state: "idle" })],
    ]);
    const store = memoryStore({ [key]: "42" });
    await assert.rejects(
      manager(api, store).execute(TARGET, "x", "pyspark", NEVER_CANCELLED),
      (error: unknown) =>
        error instanceof LivyError &&
        error.kind === "session-start" &&
        error.cause === failure,
      label,
    );
    assert.ok(!api.calls.some((call) => call.method === "POST"), label);
    assert.equal(store.get(key), "42", label);
  }
});

test("a saved session that is gone (404) is replaced by a new one", async () => {
  const key = `livy-session/${TARGET.tenantId}/${TARGET.workspaceId}/${TARGET.lakehouseId}`;
  const api = scriptedApi([
    [
      /GET .*\/sessions\/42$/,
      () =>
        new FabricApiError("gone", {
          operation: "call Fabric API",
          status: 404,
        }),
    ],
    [/POST .*\/sessions$/, () => ({ id: 99, state: "idle" })],
    [/GET .*\/sessions\/99$/, () => ({ id: 99, state: "idle" })],
    [/POST .*\/sessions\/99\/statements$/, () => ({ id: 1, state: "waiting" })],
    [
      /GET .*\/sessions\/99\/statements\/1$/,
      () => ({ id: 1, state: "available", output: { status: "ok", data: {} } }),
    ],
  ]);
  const store = memoryStore({ [key]: "42" });
  const result = await manager(api, store).execute(
    TARGET,
    "x",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.equal(result.status, "ok");
  assert.equal(store.get(key), "99");
});

function networkFailure(): FabricApiError {
  return new FabricApiError("network", { operation: "call Fabric API" });
}

function clockedManager(api: IFabricApiClient, pollIntervalMs: number) {
  let clock = 0;
  return new LivySessionManager(api, memoryStore(), {
    pollIntervalMs,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
}

function pollingApi(statementPoll: () => unknown) {
  return scriptedApi([
    [/POST .*\/sessions$/, () => ({ id: 7, state: "idle" })],
    [/GET .*\/sessions\/7$/, () => ({ id: 7, state: "idle" })],
    [/POST .*\/sessions\/7\/statements$/, () => ({ id: 1, state: "waiting" })],
    [/GET .*\/sessions\/7\/statements\/1$/, statementPoll],
  ]);
}

test("a running cell keeps polling through a short network outage", async () => {
  let polls = 0;
  const api = pollingApi(() =>
    ++polls <= 3
      ? networkFailure()
      : { id: 1, state: "available", output: { status: "ok", data: {} } },
  );
  const result = await clockedManager(api, 1000).execute(
    TARGET,
    "x",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.equal(result.status, "ok");
  assert.equal(polls, 4);
});

test("a running cell reports the network error once an outage outlasts two minutes", async () => {
  let polls = 0;
  const failure = networkFailure();
  const api = pollingApi(() => {
    polls++;
    return failure;
  });
  await assert.rejects(
    clockedManager(api, 30_000).execute(
      TARGET,
      "x",
      "pyspark",
      NEVER_CANCELLED,
    ),
    (error: unknown) => error === failure,
  );
  // Polls at 0, 30, 60, 90 and 120 seconds; the last one gives up.
  assert.equal(polls, 5);
});

test("an HTTP error while polling is not treated as an outage", async () => {
  let polls = 0;
  const api = pollingApi(() => {
    polls++;
    return new FabricApiError("gone", {
      operation: "call Fabric API",
      status: 404,
    });
  });
  await assert.rejects(
    clockedManager(api, 1000).execute(TARGET, "x", "pyspark", NEVER_CANCELLED),
    (error: unknown) =>
      error instanceof LivyError && error.kind === "session-expired",
  );
  assert.equal(polls, 1);
});

test("a successful poll ends an outage, so separate short outages never add up", async () => {
  // Polls every 30 s: four failures, one running answer, four failures, done.
  // Counted as one outage, the second run of failures would pass two minutes.
  const script = [
    ...Array(4).fill("fail"),
    "running",
    ...Array(4).fill("fail"),
    "available",
  ];
  let polls = 0;
  const api = pollingApi(() => {
    const step = script[polls++];
    return step === "fail"
      ? networkFailure()
      : step === "running"
        ? { id: 1, state: "running" }
        : { id: 1, state: "available", output: { status: "ok", data: {} } };
  });
  const result = await clockedManager(api, 30_000).execute(
    TARGET,
    "x",
    "pyspark",
    NEVER_CANCELLED,
  );
  assert.equal(result.status, "ok");
  assert.equal(polls, script.length);
});
