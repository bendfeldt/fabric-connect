import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import Module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

test("wheel selection streams a workspace-contained sibling wheelhouse", async () => {
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
  let uploadCount = 0;
  let deleteCount = 0;
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
  const dependency = path.join(path.dirname(wheel), "dep-1.0-py3-none-any.whl");
  const outside = root + "-outside.whl";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ModuleStager } =
      require("../src/vscode/moduleStager") as typeof import("../src/vscode/moduleStager");
    const stager = Object.create(ModuleStager.prototype) as {
      workspaceRoot: string;
      oneLake: {
        uploadFile: (...args: unknown[]) => Promise<void>;
        deleteDirectory: (...args: unknown[]) => Promise<void>;
      };
      localPackages: () => Promise<Map<string, string>>;
      pickMode: () => Promise<unknown>;
      prepare: (
        target: unknown,
      ) => Promise<import("../src/core/livySessionManager").LivySessionSetup>;
      describe: () => Promise<{ label: string }>;
    };
    stager.workspaceRoot = root;
    stager.oneLake = {
      uploadFile: async () => {
        uploadCount++;
      },
      deleteDirectory: async () => {
        deleteCount++;
      },
    };
    stager.localPackages = async () => new Map();
    assert.equal(await stager.pickMode(), undefined);
    await fs.mkdir(path.dirname(wheel), { recursive: true });
    const selectedBytes = Buffer.alloc(256 * 1024 + 17, 0x5a);
    const dependencyBytes = Buffer.from("dependency wheel bytes");
    await fs.writeFile(wheel, selectedBytes);
    await fs.writeFile(dependency, dependencyBytes);
    selectedFile = wheel;
    assert.deepEqual(await stager.pickMode(), {
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
    const setup = await stager.prepare({});
    const statements = [];
    for await (const statement of setup.createStatements())
      statements.push(statement);
    assert.equal(setup.requiresFreshSession, true);
    assert.match(
      statements[0].code,
      /dep-1\.0-py3-none-any\.whl.*sample-1\.0-py3-none-any\.whl/s,
    );
    const dataStatements = statements.slice(1, -1);
    assert.equal(dataStatements.length, 3);
    const reconstructed = new Map<string, Buffer[]>();
    const sizes = new Map<string, number>();
    for (const statement of dataStatements) {
      const fileName = statement.code.match(/"wheelhouse" \/ "([^"]+)"/)?.[1];
      const offset = Number(statement.code.match(/seek\((\d+)\)/)?.[1]);
      const encoded = statement.code.match(/b64decode\("([^"]+)"\)/)?.[1];
      assert.ok(fileName);
      assert.ok(encoded);
      assert.equal(offset, sizes.get(fileName) ?? 0);
      const chunk = Buffer.from(encoded, "base64");
      const chunks = reconstructed.get(fileName) ?? [];
      chunks.push(chunk);
      reconstructed.set(fileName, chunks);
      sizes.set(fileName, offset + chunk.length);
    }
    assert.deepEqual(
      Buffer.concat(reconstructed.get("dep-1.0-py3-none-any.whl")!),
      dependencyBytes,
    );
    assert.deepEqual(
      Buffer.concat(reconstructed.get("sample-1.0-py3-none-any.whl")!),
      selectedBytes,
    );
    assert.equal(
      sizes.get("sample-1.0-py3-none-any.whl"),
      selectedBytes.length,
    );
    assert.match(
      statements.at(-1)!.code,
      new RegExp(createHash("sha256").update(selectedBytes).digest("hex")),
    );
    assert.match(
      statements.at(-1)!.code,
      new RegExp(createHash("sha256").update(dependencyBytes).digest("hex")),
    );
    assert.match(statements.at(-1)!.code, /--no-index/);
    assert.match(statements.at(-1)!.code, /addPyFile/);
    assert.doesNotMatch(
      statements.map((item) => item.code).join("\n"),
      /abfss|notebookutils|sitecustomize|%pip/,
    );
    const same = await stager.prepare({});
    assert.equal(same.key, setup.key);
    await fs.writeFile(wheel, "selected wheel changed");
    const selectedChanged = await stager.prepare({});
    assert.notEqual(selectedChanged.key, setup.key);
    await fs.writeFile(dependency, "dependency changed");
    assert.notEqual((await stager.prepare({})).key, selectedChanged.key);
    assert.equal(uploadCount, 0);
    assert.equal(deleteCount, 0);
    await fs.writeFile(outside, "outside");
    const externalLink = path.join(
      path.dirname(wheel),
      "external-1.0-py3-none-any.whl",
    );
    await fs.symlink(outside, externalLink);
    await assert.rejects(stager.prepare({}), /Cannot read selected wheel/);
    await fs.rm(externalLink);
    selectedFile = outside;
    await assert.rejects(stager.pickMode(), /Cannot use/);
    assert.equal(state.localWheel, "dist/sample-1.0-py3-none-any.whl");
    const notWheel = path.join(root, "not-a-wheel.txt");
    await fs.writeFile(notWheel, "not a wheel");
    selectedFile = notWheel;
    await assert.rejects(stager.pickMode(), /Cannot use/);
    await fs.rm(wheel);
    selectedFile = wheel;
    await assert.rejects(stager.prepare({}), /Cannot read selected wheel/);
  } finally {
    loader._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});
