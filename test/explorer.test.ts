import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalFirstViolationError, PullError } from "../src/core/errors";
import { FabricApiClient } from "../src/core/fabricApiClient";
import {
  awaitOperation,
  getItemDefinition,
  itemFolderName,
  safePartPath,
} from "../src/core/itemDefinition";
import { LocalItemIndex } from "../src/core/localItemIndex";
import { NameCache, guidAt } from "../src/core/nameCache";
import type {
  FabricRequestOptions,
  FabricResponse,
  IFabricApiClient,
} from "../src/core/types";
import { assertWriteAllowed } from "../src/core/writePolicy";

const TENANT = "87654321-4321-4321-4321-cba987654321";
const WS = "11111111-1111-1111-1111-111111111111";
const ITEM = "22222222-2222-2222-2222-222222222222";
const b64 = (text: string) => Buffer.from(text).toString("base64");

function scripted(
  respond: (options: FabricRequestOptions) => FabricResponse<unknown>,
): IFabricApiClient & { calls: FabricRequestOptions[] } {
  const calls: FabricRequestOptions[] = [];
  return {
    calls,
    async request<T>(options: FabricRequestOptions) {
      calls.push(options);
      return respond(options) as FabricResponse<T>;
    },
  };
}

// --- pulling definitions ----------------------------------------------------------

test("getDefinition is an allowed read; updateDefinition stays blocked", () => {
  const ok = (path: string) =>
    assertWriteAllowed({ method: "POST", path, tenantId: TENANT }, "POST <p>");
  ok(`/workspaces/${WS}/items/${ITEM}/getDefinition`);
  ok(`/workspaces/${WS}/items/${ITEM}/getDefinition?format=ipynb`);
  for (const path of [
    `/workspaces/${WS}/items/${ITEM}/updateDefinition`,
    `/workspaces/${WS}/items/${ITEM}/getDefinition?format=ipynb&x=1`,
    `/workspaces/${WS}/items/${ITEM}/getDefinition/../updateDefinition`,
    `/workspaces/${WS}/notebooks/${ITEM}/getDefinition`,
  ]) {
    assert.throws(
      () =>
        assertWriteAllowed(
          { method: "POST", path, tenantId: TENANT },
          "POST <p>",
        ),
      LocalFirstViolationError,
      path,
    );
  }
});

test("a definition answered directly is decoded part by part", async () => {
  const api = scripted(() => ({
    status: 200,
    body: {
      definition: {
        parts: [
          {
            path: "notebook-content.py",
            payload: b64("# Fabric notebook source\n"),
            payloadType: "InlineBase64",
          },
          {
            path: ".platform",
            payload: b64("{}"),
            payloadType: "InlineBase64",
          },
        ],
      },
    },
  }));
  const parts = await getItemDefinition(api, TENANT, WS, ITEM);
  assert.deepEqual(
    parts.map((p) => [p.path, new TextDecoder().decode(p.data)]),
    [
      ["notebook-content.py", "# Fabric notebook source\n"],
      [".platform", "{}"],
    ],
  );
  assert.equal(
    api.calls[0].path,
    `/workspaces/${WS}/items/${ITEM}/getDefinition`,
  );
});

test("a 202 definition is followed through the operation to its result", async () => {
  let polls = 0;
  const api = scripted((options) => {
    if (options.method === "POST") {
      return {
        status: 202,
        body: undefined,
        operationId: "op-1",
        retryAfterSeconds: 1,
      };
    }
    if (options.path === "/operations/op-1") {
      polls++;
      return {
        status: 200,
        body: { status: polls < 2 ? "Running" : "Succeeded" },
      };
    }
    assert.equal(options.path, "/operations/op-1/result");
    return {
      status: 200,
      body: { definition: { parts: [{ path: "a.json", payload: b64("1") }] } },
    };
  });
  const sleeps: number[] = [];
  const parts = await getItemDefinition(api, TENANT, WS, ITEM, "ipynb", {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(parts[0].path, "a.json");
  assert.equal(sleeps[0], 1000, "honours Retry-After");
  assert.match(api.calls[0].path, /getDefinition\?format=ipynb$/);
});

test("failed, unfollowable and timed-out operations are typed errors", async () => {
  const failed = scripted((o) =>
    o.method === "POST"
      ? { status: 202, body: undefined, operationId: "op-2" }
      : {
          status: 200,
          body: { status: "Failed", error: { message: "no access" } },
        },
  );
  await assert.rejects(
    awaitOperation(
      failed,
      TENANT,
      await failed.request({ method: "POST", path: "/x", tenantId: TENANT }),
      "read",
      { sleep: async () => undefined },
    ),
    (error: unknown) =>
      error instanceof PullError && /no access/.test(error.message),
  );
  await assert.rejects(
    awaitOperation(
      failed,
      TENANT,
      { status: 202, body: undefined, operationId: "../x" },
      "read",
    ),
    PullError,
  );
  const slow = scripted(() => ({ status: 200, body: { status: "Running" } }));
  await assert.rejects(
    awaitOperation(
      slow,
      TENANT,
      { status: 202, body: undefined, operationId: "op-3" },
      "read",
      {
        sleep: async () => undefined,
        timeoutMs: 0,
      },
    ),
    PullError,
  );
});

test("definition parts can never escape the item folder", () => {
  assert.equal(safePartPath("a/b.json"), "a/b.json");
  assert.equal(safePartPath("a\\b.json"), "a/b.json");
  assert.equal(safePartPath("./a/../b.json"), "b.json");
  for (const bad of [
    "../x",
    "a/../../x",
    "/etc/passwd",
    "C:/x",
    "..",
    ".",
    "",
  ]) {
    assert.throws(() => safePartPath(bad), PullError, bad);
  }
});

test("item folders follow the git-integration naming, with unsafe characters replaced", () => {
  assert.equal(itemFolderName("Sales Load", "Notebook"), "Sales Load.Notebook");
  assert.equal(itemFolderName('a/b:c*"d', "Lakehouse"), "a_b_c__d.Lakehouse");
});

test("the client surfaces operation headers for 202 responses", async () => {
  const client = new FabricApiClient(
    { getToken: async () => "t" },
    {
      fetchFn: (async () =>
        new Response(null, {
          status: 202,
          headers: { "x-ms-operation-id": "op-9", "retry-after": "5" },
        })) as typeof fetch,
      sleep: async () => undefined,
    },
  );
  const response = await client.request({
    method: "POST",
    path: `/workspaces/${WS}/items/${ITEM}/getDefinition`,
    tenantId: TENANT,
  });
  assert.equal(response.status, 202);
  assert.equal(response.operationId, "op-9");
  assert.equal(response.retryAfterSeconds, 5);
});

// --- GUID hover --------------------------------------------------------------------

test("guidAt finds the GUID under the cursor", () => {
  const line = `"workspaceId": "${WS.toUpperCase()}", "x": 1`;
  const start = line.indexOf(WS.toUpperCase());
  assert.equal(guidAt(line, start), WS);
  assert.equal(guidAt(line, start + 36), WS);
  assert.equal(guidAt(line, 0), undefined);
});

test("the name cache knows listed entities and local logicalIds", async () => {
  const cache = new NameCache();
  cache.remember(ITEM.toUpperCase(), {
    kind: "item",
    displayName: "Bronze",
    type: "Lakehouse",
    workspaceName: "Sandbox",
  });
  assert.equal(
    NameCache.describe(cache.lookup(ITEM)!),
    "Fabric item: Bronze (Lakehouse) in workspace Sandbox",
  );
  const index = await LocalItemIndex.build({
    findPlatformFiles: async () => ["/repo/Load.Notebook/.platform"],
    readFile: async () =>
      JSON.stringify({
        metadata: { type: "Notebook", displayName: "Load" },
        config: { logicalId: "aaaaaaaa-0000-0000-0000-000000000009" },
      }),
  });
  const local = cache.lookup("AAAAAAAA-0000-0000-0000-000000000009", index);
  assert.equal(local?.kind, "local item");
  assert.equal(local?.displayName, "Load");
  assert.equal(
    cache.lookup("bbbbbbbb-0000-0000-0000-000000000000", index),
    undefined,
  );
});
