import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listVariableLibraries,
  variableLibraryVariableNames,
} from "../src/core/variableLibraries";
import type { FabricRequestOptions, IFabricApiClient } from "../src/core/types";

const target = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

test("lists Variable Libraries across pages in the selected workspace", async () => {
  const calls: FabricRequestOptions[] = [];
  const api: IFabricApiClient = {
    async request<T>(options: FabricRequestOptions) {
      calls.push(options);
      const body = options.path.endsWith("continuationToken=next")
        ? {
            value: [
              {
                id: "55555555-5555-4555-8555-555555555555",
                displayName: "Second",
                type: "VariableLibrary",
              },
              { id: "ignored", displayName: "Notebook", type: "Notebook" },
            ],
          }
        : {
            value: [
              {
                id: "44444444-4444-4444-8444-444444444444",
                displayName: "First",
                type: "VariableLibrary",
              },
            ],
            continuationToken: "next",
          };
      return { status: 200, body: body as T };
    },
  };

  assert.deepEqual(await listVariableLibraries(api, target), [
    { id: "44444444-4444-4444-8444-444444444444", name: "First" },
    { id: "55555555-5555-4555-8555-555555555555", name: "Second" },
  ]);
  assert.equal(
    calls[0].path,
    `/workspaces/${target.workspaceId}/items?type=VariableLibrary`,
  );
  assert.match(calls[1].path, /continuationToken=next$/);
  assert.ok(calls.every((call) => call.tenantId === target.tenantId));
});

test("returns only variable names from the definition", async () => {
  const calls: FabricRequestOptions[] = [];
  const api: IFabricApiClient = {
    async request<T>(options: FabricRequestOptions) {
      calls.push(options);
      const body = {
        definition: {
          parts: [
            {
              path: "variables.json",
              payload: Buffer.from(
                JSON.stringify({
                  variables: [
                    { name: "region", value: "secret-region" },
                    { name: "environment", value: "secret-environment" },
                  ],
                }),
              ).toString("base64"),
            },
          ],
        },
      };
      return { status: 200, body: body as T };
    },
  };

  assert.deepEqual(
    await variableLibraryVariableNames(
      api,
      target,
      "44444444-4444-4444-8444-444444444444",
    ),
    ["region", "environment"],
  );
  assert.ok(calls.every((call) => call.method === "POST"));
  assert.equal(
    calls[0].path,
    `/workspaces/${target.workspaceId}/items/44444444-4444-4444-8444-444444444444/getDefinition`,
  );
});

test("rejects repeated continuation tokens rather than looping", async () => {
  const api: IFabricApiClient = {
    async request<T>() {
      return {
        status: 200,
        body: { value: [], continuationToken: "repeat" } as T,
      };
    },
  };

  await assert.rejects(listVariableLibraries(api, target), /repeated/);
});
