import assert from "node:assert/strict";
import { test } from "node:test";
import { executionContextCode } from "../src/core/executionContext";
import type { LivyTarget } from "../src/core/livySessionManager";
import type { FabricRequestOptions, IFabricApiClient } from "../src/core/types";

const target: LivyTarget = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  lakehouseId: "33333333-3333-4333-8333-333333333333",
  sessionScope: "file:///repo/Department.Notebook/notebook-content.py",
};

function fixture(active = "dev"): {
  api: IFabricApiClient;
  calls: FabricRequestOptions[];
} {
  const calls: FabricRequestOptions[] = [];
  const api: IFabricApiClient = {
    async request<T>(options: FabricRequestOptions) {
      calls.push(options);
      let body: unknown;
      if (options.path.includes("/items?")) {
        body = {
          value: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              displayName: "settings",
              type: "VariableLibrary",
            },
          ],
        };
      } else if (options.method === "GET") {
        body = {
          workspaceId: target.workspaceId,
          properties: { activeValueSetName: active },
        };
      } else {
        const parts = {
          "variables.json": {
            variables: [
              { name: "source", value: "base" },
              { name: "not_forwarded", value: "excluded" },
            ],
          },
          "valueSets/dev.json": {
            name: "dev",
            variableOverrides: [{ name: "source", value: "development" }],
          },
        };
        body = {
          definition: {
            parts: Object.entries(parts).map(([path, value]) => ({
              path,
              payloadType: "InlineBase64",
              payload: Buffer.from(JSON.stringify(value)).toString("base64"),
            })),
          },
        };
      }
      return { status: 200, body: body as T };
    },
  };
  return { api, calls };
}

test("the private bridge supplies only selected active values and real host identity", async () => {
  const { api, calls } = fixture();
  const code = await executionContextCode(api, target, "local", {
    settings: ["source"],
  });
  assert.ok(code);
  const line = code.split("\n")[1];
  const literal = line.slice(
    "_fabric_connect_execution = _fc_context_json.loads(".length,
    -1,
  );
  const descriptor = JSON.parse(JSON.parse(literal));
  assert.deepEqual(descriptor, {
    schema_version: 1,
    workspace_id: target.workspaceId,
    lakehouse_id: target.lakehouseId,
    session_scope: target.sessionScope,
    module_mode: "local",
    libraries: {
      settings: {
        workspace_id: target.workspaceId,
        active_value_set: "dev",
        values: { source: "development" },
      },
    },
  });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.ok(
    calls.every(
      (call) => call.method === "GET" || call.path.endsWith("/getDefinition"),
    ),
  );
  assert.ok(!code.includes("not_forwarded") && !code.includes("excluded"));
});

test("unconfigured libraries make no API calls and plain files receive no notebook context", async () => {
  const { api, calls } = fixture();
  await executionContextCode(api, target, "remote", {});
  const { sessionScope: _, ...plain } = target;
  assert.equal(
    await executionContextCode(api, plain, "local", { settings: ["source"] }),
    undefined,
  );
  assert.equal(calls.length, 0);
});

test("missing active value sets and missing selected variables fail without defaults", async () => {
  await assert.rejects(
    executionContextCode(fixture("missing").api, target, "local", {
      settings: ["source"],
    }),
    /Cannot resolve/,
  );
  await assert.rejects(
    executionContextCode(fixture().api, target, "local", {
      settings: ["absent"],
    }),
    /Cannot resolve/,
  );
});

test("the workspace setting accepts at most one Variable Library", async () => {
  await assert.rejects(
    executionContextCode(fixture().api, target, "local", {
      settings: ["source"],
      another_library: ["source"],
    }),
    /Only one Variable Library/,
  );
});
