import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

test("a Spark job's staged files are deleted only once the job can no longer read them", () => {
  // Isolate the VS Code API stand-in; run the actual CodeRunner and runBatch.
  execFileSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const Module = require("node:module");
    const load = Module._load;
    const text = [];
    let cancelled = false;
    let cancelStatus = 200;
    const disposable = () => ({ dispose() {} });
    const vscode = {
      ProgressLocation: { Notification: 1 },
      StatusBarAlignment: { Left: 1 },
      EventEmitter: class { constructor() { this.event = disposable; } fire() {} dispose() {} },
      workspace: {
        createFileSystemWatcher: () => ({ onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable, dispose() {} }),
        onDidChangeConfiguration: disposable
      },
      window: {
        createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }),
        createOutputChannel: () => ({ show() {}, dispose() {}, appendLine: value => text.push(value) }),
        showErrorMessage: async () => undefined,
        withProgress: (_options, action) => action({ report() {} }, { get isCancellationRequested() { return cancelled; }, onCancellationRequested: () => ({ dispose() {} }) })
      }
    };
    Module._load = function(request, parent, isMain) {
      return request === "vscode" ? vscode : load.call(this, request, parent, isMain);
    };
    const root = ${JSON.stringify(path.resolve(__dirname, "../src"))};
    const { CodeRunner } = require(root + "/vscode/codeRunner.js");
    const { ModuleStager } = require(root + "/vscode/moduleStager.js");
    const { FabricApiError } = require(root + "/core/errors.js");

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fc-job-"));
    // Removed however this process ends, a failed setup step included.
    process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));
    const folder = path.join(tmpRoot, "Job.SparkJobDefinition");
    fs.mkdirSync(path.join(folder, "Main"), { recursive: true });
    fs.writeFileSync(path.join(folder, "SparkJobDefinitionV1.json"), JSON.stringify({ executableFile: "main.py" }));
    fs.writeFileSync(path.join(folder, "Main", "main.py"), "print(1)");

    const compute = {
      tenantId: "87654321-4321-4321-4321-cba987654321",
      capacityId: "99999999-8888-7777-6666-555555555555",
      workspaceId: "12345678-1234-1234-1234-123456789abc",
      lakehouseId: "11111111-2222-3333-4444-555555555555"
    };
    let poll = () => ({ state: "success" });
    let failStaging = false;
    const deleted = [];
    // The real ModuleStager over a recording OneLake client.
    const oneLake = {
      uploadFile: async () => { if (failStaging) throw new Error("upload failed"); },
      deleteDirectory: async (_at, relPath) => { deleted.push(relPath); }
    };
    const stager = new ModuleStager(oneLake, undefined);
    const jobFolder = "Files/.fabric-connect/" + stager.runId + "/job-Job-";
    const api = { async request(options) {
      if (options.method === "POST") return { status: 200, body: { id: 42 } };
      if (options.method === "DELETE") {
        if (cancelStatus !== 200) throw new FabricApiError("cancel failed", { operation: "call Fabric API", status: cancelStatus });
        return { status: 200, body: {} };
      }
      if (options.path.includes("/log?")) return { status: 200, body: { log: [] } };
      return { status: 200, body: poll() };
    }};
    const runner = new CodeRunner(
      api, {}, { resolveTargetIfMapped: async () => undefined }, async () => compute,
      {}, stager, () => compute.tenantId, action => action(), async () => undefined, {}
    );
    const uri = { fsPath: path.join(folder, "Main", "main.py") };

    (async () => {
      // The job ended: its files are deleted.
      await runner.runSparkJob(uri);
      assert.equal(deleted.length, 1);
      assert.ok(deleted[0].startsWith(jobFolder), deleted[0]);

      // Tracking is lost while the job may still run: its files are kept.
      poll = () => { throw new FabricApiError("forbidden", { operation: "call Fabric API", status: 403 }); };
      await assert.rejects(runner.runSparkJob(uri), /Lost track of Spark job/);
      assert.equal(deleted.length, 1);
      assert.ok(text.some(line => line.includes("Staged files kept in 'Files/.fabric-connect/" + stager.runId + "/job-Job-") && /may still be running.*delete that folder/.test(line)));

      // Staging failed before submission: whatever was staged is deleted.
      failStaging = true;
      await assert.rejects(runner.runSparkJob(uri), /upload failed/);
      assert.equal(deleted.length, 2);
      assert.ok(deleted[1].startsWith(jobFolder), deleted[1]);
      failStaging = false;

      // Cancelled and Fabric accepted the cancel: its files are deleted.
      cancelled = true;
      await runner.runSparkJob(uri);
      assert.equal(deleted.length, 3);

      // Fabric refused the cancel: the job may still run, so its files stay.
      cancelStatus = 403;
      await assert.rejects(runner.runSparkJob(uri), /Could not confirm that Spark job 'Job .*was cancelled.*may still be running/);
      assert.equal(deleted.length, 3);
      runner.dispose();
      stager.dispose();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { stdio: "pipe" },
  );
});

test("stopping a session deletes only the window's module bundles, not job files", () => {
  execFileSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require("node:assert/strict");
    const Module = require("node:module");
    const load = Module._load;
    const disposable = () => ({ dispose() {} });
    const vscode = {
      StatusBarAlignment: { Left: 1 },
      EventEmitter: class { constructor() { this.event = disposable; } fire() {} dispose() {} },
      window: { createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }) },
      workspace: {
        createFileSystemWatcher: () => ({ onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable, dispose() {} }),
        onDidChangeConfiguration: disposable
      }
    };
    Module._load = function(request, parent, isMain) {
      return request === "vscode" ? vscode : load.call(this, request, parent, isMain);
    };
    const root = ${JSON.stringify(path.resolve(__dirname, "../src"))};
    const { ModuleStager } = require(root + "/vscode/moduleStager.js");
    const { bundlePath } = require(root + "/core/moduleStaging.js");
    const deleted = [];
    const oneLake = { deleteDirectory: async (_at, relPath) => { deleted.push(relPath); } };
    const stager = new ModuleStager(oneLake, undefined);
    (async () => {
      await stager.cleanup({ tenantId: "t", workspaceId: "w", lakehouseId: "l" });
      assert.deepEqual(deleted, ["Files/.fabric-connect/" + stager.runId + "/modules"]);
      assert.ok(bundlePath(stager.runId, "a".repeat(64)).startsWith(deleted[0] + "/"));
      stager.dispose();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { stdio: "pipe" },
  );
});
