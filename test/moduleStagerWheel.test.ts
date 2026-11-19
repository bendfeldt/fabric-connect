import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import Module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

test("wheel selection is workspace-scoped, hashed and staged ephemerally", async () => {
  const originalLoad = (
    Module as unknown as {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    }
  )._load;
  const state: Record<string, string | string[]> = {
    pythonModules: "remote",
    localWheel: "",
    sourceRoots: [],
  };
  let selectedMode = "wheel";
  let selectedFile: string | undefined;
  const uploaded: Array<{ path: string; bytes: Uint8Array }> = [];
  const deleted: string[] = [];
  const vscode = {
    ConfigurationTarget: { Workspace: 2 },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback?: unknown) => state[key] ?? fallback,
        update: async (key: string, value: string | string[]) => {
          state[key] = value;
        },
      }),
    },
    window: {
      showQuickPick: async (items: { mode: string }[]) =>
        items.find((item) => item.mode === selectedMode),
      showOpenDialog: async () =>
        selectedFile === undefined ? undefined : [{ fsPath: selectedFile }],
      createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }),
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

  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "fabric-connect-wheel-"),
  );
  const wheel = path.join(root, "dist", "sample-1.0-py3-none-any.whl");
  const outside = `${root}-outside.whl`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ModuleStager } = require("../src/vscode/moduleStager") as {
      ModuleStager: new (...args: never[]) => object;
    };
    const stager = Object.create(ModuleStager.prototype) as {
      workspaceRoot: string;
      runId: string;
      oneLake: {
        uploadFile: (
          target: unknown,
          relPath: string,
          bytes: Uint8Array,
        ) => Promise<void>;
        deleteDirectory: (target: unknown, relPath: string) => Promise<void>;
      };
      localPackages: () => Promise<Map<string, string>>;
      pickMode: () => Promise<unknown>;
      prepare: (target: unknown) => Promise<{
        key: string;
        createStatement: () => Promise<{ code: string; kind: string }>;
        cleanup?: () => Promise<void>;
      }>;
      describe: () => Promise<{ label: string }>;
    };
    stager.workspaceRoot = root;
    stager.runId = "run-test";
    stager.localPackages = async () => new Map();
    stager.oneLake = {
      uploadFile: async (_target, relPath, bytes) => {
        uploaded.push({ path: relPath, bytes });
      },
      deleteDirectory: async (_target, relPath) => {
        deleted.push(relPath);
      },
    };

    assert.equal(await stager.pickMode(), undefined);
    assert.equal(state.pythonModules, "remote");
    assert.equal(state.localWheel, "");

    await fs.mkdir(path.dirname(wheel), { recursive: true });
    await fs.writeFile(wheel, "wheel bytes v1");
    selectedFile = wheel;
    const transition = (await stager.pickMode()) as {
      previous: string;
      selected: string;
      wheelChanged: boolean;
    };
    assert.deepEqual(transition, {
      previous: "remote",
      selected: "wheel",
      wheelChanged: true,
    });
    assert.equal(state.pythonModules, "wheel");
    assert.equal(state.localWheel, "dist/sample-1.0-py3-none-any.whl");
    assert.equal(
      (await stager.describe()).label,
      "Wheel · sample-1.0-py3-none-any.whl",
    );

    const first = await stager.prepare({
      tenantId: "tenant",
      workspaceId: "workspace",
      lakehouseId: "lakehouse",
    });
    const statement = await first.createStatement();
    assert.match(statement.code, /^%pip install --force-reinstall /);
    assert.equal(statement.kind, "pyspark");
    assert.equal(path.basename(uploaded[0].path), path.basename(wheel));
    assert.equal(Buffer.from(uploaded[0].bytes).toString(), "wheel bytes v1");
    const concurrent = await stager.prepare({
      tenantId: "tenant",
      workspaceId: "workspace",
      lakehouseId: "lakehouse",
    });
    await concurrent.createStatement();
    assert.notEqual(uploaded[0].path, uploaded[1].path);
    await first.cleanup?.();
    await concurrent.cleanup?.();
    assert.equal(deleted.length, 2);
    assert.notEqual(deleted[0], deleted[1]);

    await fs.writeFile(wheel, "wheel bytes v2, same path and version");
    const second = await stager.prepare({
      tenantId: "tenant",
      workspaceId: "workspace",
      lakehouseId: "lakehouse",
    });
    assert.notEqual(second.key, first.key);

    await fs.writeFile(outside, "outside");
    selectedFile = outside;
    await assert.rejects(stager.pickMode(), /Cannot use/);
    assert.equal(state.pythonModules, "wheel");
    assert.equal(state.localWheel, "dist/sample-1.0-py3-none-any.whl");

    const notWheel = path.join(root, "not-a-wheel.txt");
    await fs.writeFile(notWheel, "not a wheel");
    selectedFile = notWheel;
    await assert.rejects(stager.pickMode(), /Cannot use/);
    assert.equal(state.localWheel, "dist/sample-1.0-py3-none-any.whl");

    await fs.rm(wheel);
    await assert.rejects(
      stager.prepare({ tenantId: "t", workspaceId: "w", lakehouseId: "l" }),
      /Cannot read selected wheel/,
    );
  } finally {
    loader._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});
