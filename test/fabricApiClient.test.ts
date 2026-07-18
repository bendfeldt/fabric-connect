import assert from "node:assert/strict";
import { test } from "node:test";
import { FabricApiError } from "../src/core/errors";
import { FabricApiClient, redactPath } from "../src/core/fabricApiClient";
import type { IAuthProvider } from "../src/core/types";

const auth: IAuthProvider = {
  getToken: async () => "test-token",
};
const TENANT = "87654321-4321-4321-4321-cba987654321";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(responses: Array<() => Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("unexpected extra request");
    }
    const result = next();
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }) as typeof fetch;
  const client = new FabricApiClient(auth, {
    fetchFn,
    sleep: async () => undefined,
  });
  return { client, calls };
}

test("successful request returns parsed body and correlation ID", async () => {
  const { client, calls } = makeClient([
    () => jsonResponse(200, { value: [1, 2] }, { "x-ms-request-id": "corr-1" }),
  ]);
  const response = await client.request<{ value: number[] }>({
    method: "GET",
    path: "/workspaces/x/lakehouses",
    tenantId: TENANT,
  });
  assert.deepEqual(response.body, { value: [1, 2] });
  assert.equal(response.correlationId, "corr-1");
  assert.equal(calls.length, 1);
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-token");
});

test("retries 429 and 5xx with backoff, then succeeds", async () => {
  const { client, calls } = makeClient([
    () => jsonResponse(429, {}, { "retry-after": "0" }),
    () => jsonResponse(503, {}),
    () => jsonResponse(200, { ok: true }),
  ]);
  const response = await client.request({
    method: "GET",
    path: "/workspaces/x",
    tenantId: TENANT,
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
});

test("does not retry non-retryable statuses like 403", async () => {
  const { client, calls } = makeClient([
    () => jsonResponse(403, { error: { message: "Forbidden by policy" } }),
  ]);
  await assert.rejects(
    client.request({ method: "GET", path: "/workspaces/x", tenantId: TENANT }),
    (error: unknown) => {
      assert.ok(error instanceof FabricApiError);
      assert.equal(error.status, 403);
      assert.match(error.message, /lacks permission/);
      assert.match(error.message, /Forbidden by policy/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("exhausted retries surface the last FabricApiError with correlation ID", async () => {
  const { client, calls } = makeClient([
    () => jsonResponse(503, {}, { "x-ms-request-id": "corr-a" }),
    () => jsonResponse(503, {}, { "x-ms-request-id": "corr-b" }),
    () => jsonResponse(503, {}, { "x-ms-request-id": "corr-c" }),
    () => jsonResponse(503, {}, { "x-ms-request-id": "corr-d" }),
  ]);
  await assert.rejects(
    client.request({ method: "GET", path: "/workspaces/x", tenantId: TENANT }),
    (error: unknown) => {
      assert.ok(error instanceof FabricApiError);
      assert.equal(error.correlationId, "corr-d");
      assert.match(error.message, /corr-d/);
      return true;
    },
  );
  assert.equal(calls.length, 4);
});

test("network-level failures are retried and normalized", async () => {
  const { client } = makeClient([
    () => new Error("socket hang up"),
    () => jsonResponse(200, { ok: true }),
  ]);
  const response = await client.request({
    method: "GET",
    path: "/workspaces/x",
    tenantId: TENANT,
  });
  assert.equal(response.status, 200);
});

test("malformed (non-JSON) success body becomes a FabricApiError", async () => {
  const { client } = makeClient([
    () => new Response("<html>gateway</html>", { status: 200 }),
  ]);
  await assert.rejects(
    client.request({ method: "GET", path: "/workspaces/x", tenantId: TENANT }),
    /malformed/,
  );
});

test("GUIDs are redacted from logged paths", () => {
  assert.equal(
    redactPath("/workspaces/12345678-1234-1234-1234-123456789abc/lakehouses"),
    "/workspaces/<redacted-id>/lakehouses",
  );
});
