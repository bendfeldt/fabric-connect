import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";
import type { FabricRequestOptions, IFabricApiClient } from "../src/core/types";

test("the main Fabric Explorer still lists tenant connections", async () => {
  const stub = {
    EventEmitter: class {
      event = () => undefined;
      fire(): void {}
      dispose(): void {}
    },
  };
  const loader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = loader._load;
  loader._load = function (request, parent, isMain) {
    return request === "vscode"
      ? stub
      : original.call(this, request, parent, isMain);
  };
  let FabricExplorer: typeof import("../src/vscode/explorer").FabricExplorer;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    FabricExplorer = (
      require("../src/vscode/explorer") as typeof import("../src/vscode/explorer")
    ).FabricExplorer;
  } finally {
    loader._load = original;
  }

  const calls: FabricRequestOptions[] = [];
  const api: IFabricApiClient = {
    async request<T>(options: FabricRequestOptions) {
      calls.push(options);
      return {
        status: 200,
        body: {
          value: [
            {
              id: "connection-id",
              displayName: "Shared SQL",
              connectivityType: "ShareableCloud",
              connectionDetails: { type: "SQL" },
            },
          ],
        } as T,
      };
    },
  };
  const explorer = new FabricExplorer(
    api,
    {} as never,
    {} as never,
    async () => undefined,
    () => "tenant-id",
    {} as never,
    {} as never,
    undefined,
    async () => undefined,
    async () => {
      throw new Error("not needed");
    },
  );
  const groups = await explorer.getChildren();
  const connections = groups.find(
    (node) => (node as { group?: string }).group === "connections",
  );
  assert.ok(connections);
  const items = await explorer.getChildren(connections as never);
  assert.deepEqual(
    items.map((node) => (node as { label?: string }).label),
    ["Shared SQL"],
  );
  assert.ok(calls.some((call) => call.path === "/connections"));
  explorer.dispose();
});
