import assert from "node:assert/strict";
import { test } from "node:test";
import type { FabricRequestOptions, IFabricApiClient } from "../src/core/types";
import {
  resolveVariableLibraryTarget,
  VariableLibraryPicker,
  type VariableLibraryChoice,
  type VariableLibraryPickerUi,
} from "../src/vscode/variableLibraryPicker";

const library = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "settings",
};
const target = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

function setup(
  choice: VariableLibraryChoice | undefined,
  selected: readonly string[] | undefined,
  current: unknown = {},
) {
  const writes: Record<string, string[]>[] = [];
  const warnings: string[] = [];
  let preselected: readonly string[] = [];
  let nextQuickPick: VariableLibraryChoice | undefined = choice;
  let nextVariables: readonly string[] | undefined = selected;
  const calls: string[] = [];
  const api: IFabricApiClient = {
    async request<T>(options: FabricRequestOptions) {
      calls.push(options.path);
      const body =
        options.method === "GET"
          ? {
              value: [
                {
                  id: library.id,
                  displayName: library.name,
                  type: "VariableLibrary",
                },
              ],
            }
          : {
              definition: {
                parts: [
                  {
                    path: "variables.json",
                    payload: Buffer.from(
                      JSON.stringify({
                        variables: [
                          { name: "region", value: "unused" },
                          { name: "tier", value: "unused" },
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
  const ui: VariableLibraryPickerUi = {
    async chooseLibrary(libraries) {
      assert.deepEqual(libraries, [library]);
      const picked = nextQuickPick;
      nextQuickPick = undefined;
      return picked;
    },
    async chooseVariables(names, defaults) {
      assert.deepEqual(names, ["region", "tier"]);
      preselected = defaults;
      const picked = nextVariables;
      nextVariables = undefined;
      return picked;
    },
    warn: (message) => warnings.push(message),
  };
  const picker = new VariableLibraryPicker(
    api,
    async () => target,
    {
      read: () => current,
      async write(value) {
        writes.push(value);
      },
    },
    ui,
  );
  return {
    picker,
    writes,
    warnings,
    get preselected() {
      return preselected;
    },
    calls,
  };
}

test("preselects saved names and persists only the chosen library", async () => {
  const state = setup({ kind: "library", library }, ["tier"], {
    settings: ["region"],
    legacy: ["old"],
  });
  await state.picker.pick();
  assert.deepEqual(state.preselected, ["region"]);
  assert.deepEqual(state.writes, [{ settings: ["tier"] }]);
});

test("cancellation preserves the setting and clear writes an empty workspace map", async () => {
  const cancelled = setup(undefined, undefined, { settings: ["region"] });
  await cancelled.picker.pick();
  assert.deepEqual(cancelled.writes, []);
  assert.deepEqual(cancelled.calls, [
    `/workspaces/${target.workspaceId}/items?type=VariableLibrary`,
  ]);

  const cleared = setup({ kind: "clear" }, undefined, { settings: ["region"] });
  await cleared.picker.pick();
  assert.deepEqual(cleared.writes, [{}]);
});

test("cancelling or accepting no variables never overwrites saved settings", async () => {
  const cancelled = setup({ kind: "library", library }, undefined, {
    settings: ["region"],
  });
  await cancelled.picker.pick();
  assert.deepEqual(cancelled.writes, []);

  const empty = setup({ kind: "library", library }, [], {
    settings: ["region"],
  });
  await empty.picker.pick();
  assert.deepEqual(empty.writes, []);
  assert.match(empty.warnings[0], /at least one variable/);
});

test("uses the notebook target when active and the compute host otherwise", async () => {
  let notebookCalls = 0;
  let hostCalls = 0;
  const notebook = await resolveVariableLibraryTarget(
    true,
    async () => {
      notebookCalls += 1;
      return target;
    },
    async () => {
      hostCalls += 1;
      return { ...target, workspaceId: "host" };
    },
  );
  const host = await resolveVariableLibraryTarget(
    false,
    async () => {
      notebookCalls += 1;
      return target;
    },
    async () => {
      hostCalls += 1;
      return { ...target, workspaceId: "host" };
    },
  );
  assert.equal(notebook.workspaceId, target.workspaceId);
  assert.equal(host.workspaceId, "host");
  assert.equal(notebookCalls, 1);
  assert.equal(hostCalls, 1);

  await assert.rejects(
    resolveVariableLibraryTarget(
      true,
      async () => {
        throw new Error("invalid notebook metadata");
      },
      async () => {
        hostCalls += 1;
        return target;
      },
    ),
    /invalid notebook metadata/,
  );
  assert.equal(hostCalls, 1);
});
