import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalFirstViolationError } from "../src/core/errors";
import { FabricApiClient } from "../src/core/fabricApiClient";
import { LivySessionManager } from "../src/core/livySessionManager";
import type { FabricRequestOptions, IAuthProvider } from "../src/core/types";
import {
  assertOneLakeWriteAllowed,
  assertWriteAllowed,
  WRITE_ALLOWLIST,
} from "../src/core/writePolicy";

const TENANT = "87654321-4321-4321-4321-cba987654321";
const WS = "11111111-1111-1111-1111-111111111111";
const LH = "22222222-2222-2222-2222-222222222222";
const ITEM = "33333333-3333-3333-3333-333333333333";
const LIVY = `/workspaces/${WS}/lakehouses/${LH}/livyapi/versions/2023-12-01`;

function req(
  method: FabricRequestOptions["method"],
  p: string,
  extra: Partial<FabricRequestOptions> = {},
): FabricRequestOptions {
  return { method, path: p, tenantId: TENANT, ...extra };
}

function check(options: FabricRequestOptions): void {
  assertWriteAllowed(options, `${options.method} <path>`);
}

test("GET requests are always allowed", () => {
  check(req("GET", `/workspaces/${WS}/items`));
  check(req("GET", `/workspaces/${WS}/items/${ITEM}/getDefinition`));
});

test("Livy session lifecycle writes are allowed", () => {
  check(req("POST", `${LIVY}/sessions`, { body: { kind: "pyspark" } }));
  check(req("POST", `${LIVY}/sessions/42/statements`, { body: {} }));
  check(req("POST", `${LIVY}/sessions/42/statements/7/cancel`));
  check(req("DELETE", `${LIVY}/sessions/42`));
});

test("Livy batches (Spark jobs from local files) can be submitted and cancelled", () => {
  check(req("POST", `${LIVY}/batches`, { body: { file: "abfss://x" } }));
  check(req("DELETE", `${LIVY}/batches/7`));
});

test("deployment, item mutation and job-run writes are blocked", () => {
  const blocked: Array<[FabricRequestOptions["method"], string]> = [
    ["POST", `/workspaces/${WS}/items`],
    ["POST", `/workspaces/${WS}/notebooks`],
    ["POST", `/workspaces/${WS}/items/${ITEM}/updateDefinition`],
    ["PATCH", `/workspaces/${WS}/items/${ITEM}`],
    ["DELETE", `/workspaces/${WS}/items/${ITEM}`],
    ["PATCH", `/workspaces/${WS}/lakehouses/${LH}`],
    ["DELETE", `/workspaces/${WS}/lakehouses/${LH}`],
    [
      "POST",
      `/workspaces/${WS}/items/${ITEM}/jobs/instances?jobType=RunNotebook`,
    ],
    ["POST", `/workspaces/${WS}/git/commitToGit`],
    ["POST", `/workspaces/${WS}/git/updateFromGit`],
    ["POST", `/deploymentPipelines/${ITEM}/deploy`],
    ["POST", `/workspaces`],
    ["POST", `/workspaces/${WS}/assignToCapacity`],
    ["POST", `${LIVY}/batches/7/log`],
    ["PATCH", `${LIVY}/batches/7`],
  ];
  for (const [method, p] of blocked) {
    assert.throws(
      () => check(req(method, p)),
      LocalFirstViolationError,
      `${method} ${p} should be blocked`,
    );
  }
});

test("allowlist cannot be satisfied by traversal, encoding or query strings", () => {
  const tricks = [
    `${LIVY}/sessions/../../../../../items`,
    `${LIVY}/sessions/%2e%2e/statements`,
    `${LIVY}/sessions?redirect=/items`,
    `${LIVY}/sessions/42/statements#x`,
    `/x${LIVY}/sessions`,
    `${LIVY}/sessions/42/statements/7/cancel/extra`,
  ];
  for (const p of tricks) {
    assert.throws(() => check(req("POST", p)), LocalFirstViolationError, p);
  }
});

test("the violation error names the operation and next step, not the IDs", () => {
  try {
    assertWriteAllowed(
      req("POST", `/workspaces/${WS}/items`),
      "POST /workspaces/<redacted-id>/items",
    );
    assert.fail("expected a violation");
  } catch (error) {
    assert.ok(error instanceof LocalFirstViolationError);
    assert.equal(error.operation, "enforce local-first write policy");
    assert.match(error.message, /local-first/);
    assert.match(error.message, /Next step:/);
    assert.doesNotMatch(error.message, new RegExp(WS));
  }
});

test("creating a Lakehouse (or any item) is always blocked (D3)", () => {
  for (const [method, p] of [
    ["POST", `/workspaces/${WS}/lakehouses`],
    ["POST", `/workspaces/${WS}/items`],
    ["POST", `/workspaces/${WS}/warehouses`],
    ["POST", `/workspaces/${WS}/environments`],
  ] as const) {
    assert.throws(
      () => check(req(method, p, { body: { displayName: "scratch" } })),
      LocalFirstViolationError,
      `${method} ${p}`,
    );
  }
});

test("blocked writes never reach auth or the network", async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const auth: IAuthProvider = {
    getToken: async () => {
      tokenCalls++;
      return "token";
    },
  };
  const client = new FabricApiClient(auth, {
    fetchFn: (async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    }) as typeof fetch,
    sleep: async () => undefined,
  });
  await assert.rejects(
    client.request(
      req("POST", `/workspaces/${WS}/items/${ITEM}/updateDefinition`),
    ),
    LocalFirstViolationError,
  );
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("real Livy session traffic passes the policy through the real client", async () => {
  const seen: string[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const p = new URL(String(url)).pathname.replace(/^\/v1/, "");
    seen.push(`${method} ${p.slice(LIVY.length)}`);
    const route = `${method} ${p.slice(LIVY.length)}`;
    const body =
      route === "POST /sessions"
        ? { id: 7, state: "idle" }
        : route === "POST /sessions/7/statements"
          ? { id: 0, state: "waiting" }
          : route === "GET /sessions/7/statements/0"
            ? {
                id: 0,
                state: "available",
                output: { status: "ok", data: { "text/plain": "1" } },
              }
            : route === "GET /sessions/7"
              ? { id: 7, state: "idle" }
              : undefined;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: 200,
    });
  }) as typeof fetch;
  const client = new FabricApiClient(
    { getToken: async () => "token" },
    { fetchFn, sleep: async () => undefined },
  );
  const data = new Map<string, string>();
  const livy = new LivySessionManager(
    client,
    {
      get: (k) => data.get(k),
      set: (k, v) => (v === undefined ? data.delete(k) : data.set(k, v)),
    },
    { pollIntervalMs: 0, sleep: async () => undefined },
  );
  const target = { tenantId: TENANT, workspaceId: WS, lakehouseId: LH };
  await livy.execute(target, "1", "pyspark", {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  });
  await livy.stopSession(target);
  assert.ok(seen.includes("POST /sessions"), seen.join(", "));
  assert.ok(seen.includes("POST /sessions/7/statements"), seen.join(", "));
  assert.ok(seen.includes("DELETE /sessions/7"), seen.join(", "));
});

test("the allowlist is exactly the reviewed set (changing it is a plan change)", () => {
  assert.deepEqual(
    WRITE_ALLOWLIST.map((r) => `${r.method} ${r.purpose}`),
    [
      "POST start a Livy session",
      "DELETE stop a Livy session",
      "POST run a Livy statement",
      "POST cancel a Livy statement",
      "POST submit a Livy batch (a Spark job from local files)",
      "DELETE cancel a Livy batch",
    ],
  );
});

test("OneLake writes are limited to the scratch folder", () => {
  assertOneLakeWriteAllowed("PUT", "Files/.fabric-connect/run-1/modules.zip");
  assertOneLakeWriteAllowed("DELETE", "Files/.fabric-connect/run-1");
  const blocked = [
    "Files/data.csv",
    "Tables/sales",
    "Files/.fabric-connect",
    "Files/.fabric-connect/",
    "Files/.fabric-connect/../data.csv",
    "Files/.fabric-connect/run/../../Tables/x",
    "Files/.fabric-connect/./x",
    "Files/.fabric-connect/run//x",
    "Files/.fabric-connect/%2e%2e/x",
    "files/.fabric-connect/run/x",
    "/Files/.fabric-connect/run/x",
  ];
  for (const p of blocked) {
    assert.throws(
      () => assertOneLakeWriteAllowed("PUT", p),
      LocalFirstViolationError,
      p,
    );
  }
});
