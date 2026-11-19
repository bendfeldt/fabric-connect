import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";
import { restartTrackedSessionAfterModeChange } from "../src/vscode/moduleModeTransition";

test("Python module picker reports the selected transition", async () => {
  const originalLoad = (
    Module as unknown as {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    }
  )._load;
  let setting = "local";
  let selectedMode: string | undefined = "remote";
  const vscode = {
    ConfigurationTarget: { Workspace: 2 },
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => (key === "pythonModules" ? setting : []),
        update: async (_key: string, value: string) => {
          setting = value;
        },
      }),
    },
    window: {
      showQuickPick: async (items: { mode: string }[]) =>
        selectedMode === undefined
          ? undefined
          : items.find((item) => item.mode === selectedMode),
    },
  };
  const loader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  loader._load = function (request, parent, isMain) {
    return request === "vscode"
      ? vscode
      : originalLoad.call(this, request, parent, isMain);
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ModuleStager } = require("../src/vscode/moduleStager") as {
      ModuleStager: new (...args: never[]) => unknown;
    };
    const stager = Object.create(ModuleStager.prototype) as {
      workspaceRoot: string;
      localPackages: () => Promise<Map<string, string>>;
      mode: () => "local" | "wheel" | "remote";
      pickMode: () => Promise<unknown>;
      prepare(target: unknown): Promise<unknown>;
    };
    stager.workspaceRoot = "/repo";
    stager.localPackages = async () => new Map();
    stager.mode = () => setting as "local" | "wheel" | "remote";

    const transition = await stager.pickMode();
    assert.deepEqual(transition, {
      previous: "local",
      selected: "remote",
    });
    assert.equal(setting, "remote");
    assert.equal(await stager.prepare({}), undefined);
    await assert.rejects(
      restartTrackedSessionAfterModeChange(
        transition as { previous: "local"; selected: "remote" },
        {
          tenantId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          lakehouseId: "33333333-3333-4333-8333-333333333333",
        },
        { hasSession: () => true, stopSession: async () => {} },
        async () => {
          throw new Error("restart failed");
        },
      ),
      /restart failed/,
    );
    assert.equal(setting, "remote");
    assert.deepEqual(await stager.pickMode(), {
      previous: "remote",
      selected: "remote",
    });
    selectedMode = undefined;
    assert.equal(await stager.pickMode(), undefined);
    assert.equal(setting, "remote");
  } finally {
    loader._load = originalLoad;
  }
});
