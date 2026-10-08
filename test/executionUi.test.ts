import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

test("real execution consumers preserve failures and render hints separately across editor and text paths", () => {
  // Isolate the VS Code API stand-in; execute the actual controller, runner and Livy manager.
  execFileSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require("node:assert/strict");
    const Module = require("node:module");
    const load = Module._load;
    const controllers = [], outputs = [], text = [], logs = [], submitted = [];
    const disposable = () => ({ dispose() {} });
    let cancelled = false, failPrelude = false, failHost = false, enabled = true;
    const token = { get isCancellationRequested() { return cancelled; } };
    const fileUri = { fsPath: "/repo/example.py", toString() { return this.fsPath; } };
    const notebookUri = { fsPath: "/repo/Example.Notebook/notebook-content.py", toString() { return this.fsPath; } };
    const source = "# Fabric notebook source\\n\\n# CELL ********************\\n\\nconfiguration()\\n\\n# METADATA ********************\\n\\n# META {\\n# META   \\"language\\": \\"python\\"\\n# META }\\n";
    const document = {
      uri: fileUri, languageId: "python", getText: () => "configuration()",
      lineAt: () => ({ text: "configuration()" })
    };
    const vscode = {
      StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 1 },
      NotebookCellOutput: class { constructor(items) { this.items = items; } },
      NotebookCellOutputItem: {
        error: error => ({ mime: "application/vnd.code.notebook.error", data: Buffer.from(JSON.stringify({ message: error.message, stack: error.stack })) }),
        text: (value, mime = "text/plain") => ({ mime, data: Buffer.from(value) })
      },
      notebooks: { createNotebookController: () => {
        const controller = {
          dispose() {},
          createNotebookCellExecution: () => ({
            token, start() {}, end(success) { outputs.push({ success }); },
            async clearOutput() { outputs.push({ cleared: true }); },
            async replaceOutput(value) { outputs.push({ value }); }
          })
        };
        controllers.push(controller);
        return controller;
      }},
      window: {
        activeTextEditor: { document, selection: { isEmpty: true, active: { line: 0 } } },
        createOutputChannel: () => ({ show() {}, dispose() {}, appendLine: value => text.push(value), append: value => text.push(value) }),
        createStatusBarItem: () => ({ hide() {}, show() {}, dispose() {} }),
        onDidChangeActiveNotebookEditor: disposable,
        onDidChangeActiveTextEditor: disposable,
        withProgress: (_options, action) => action({ report() {} }, token)
      },
      workspace: {
        onDidChangeNotebookDocument: disposable,
        openTextDocument: async uri => uri === notebookUri
          ? { ...document, uri, getText: () => source }
          : document
      }
    };
    Module._load = function(request, parent, isMain) {
      return request === "vscode" ? vscode : load.call(this, request, parent, isMain);
    };
    const root = ${JSON.stringify(path.resolve(__dirname, "../src"))};
    const { FabricNotebookController, toCellOutputs } = require(root + "/vscode/notebookController.js");
    const { CodeRunner } = require(root + "/vscode/codeRunner.js");
    const { LivySessionManager } = require(root + "/core/livySessionManager.js");
    const { ExecutionDiagnostics } = require(root + "/core/executionDiagnostics.js");
    const target = {
      tenantId: "87654321-4321-4321-4321-cba987654321",
      workspaceId: "12345678-1234-1234-1234-123456789abc",
      lakehouseId: "11111111-2222-3333-4444-555555555555"
    };
    const errorValue = "notebookutils.variableLibrary.getLibrary: Failed to resolve variable reference: The notebook example-id state was not found.";
    const traceback = ["original frame", errorValue];
    const statements = new Map();
    const api = { async request(options) {
      if (options.method === "POST" && options.path.endsWith("/sessions")) return { body: { id: 7, state: "idle" } };
      if (options.method === "GET" && options.path.endsWith("/sessions/7")) return { body: { state: "idle" } };
      if (options.method === "POST" && options.path.endsWith("/statements")) {
        const id = statements.size;
        statements.set(id, options.body.code);
        submitted.push(options.body.code);
        return { body: { id, state: "waiting" } };
      }
      const code = statements.get(Number(options.path.split("/").pop()));
      return { body: {
        state: "available",
        output: code === "module prelude" && !failPrelude
          ? { status: "ok", data: {} }
          : { status: "error", ename: "Py4JJavaError", evalue: errorValue, traceback }
      }};
    }};
    const logger = { debug(message) { if (enabled) logs.push(message); } };
    const livy = new LivySessionManager(api, { get() {}, set() {} }, { logger });
    const run = {
      diagnostics: () => new ExecutionDiagnostics(logger),
      prepare: async () => "module prelude",
      importHint: async () => "Existing import guidance"
    };
    const compute = async () => { if (failHost) throw new Error("host failed"); return target; };
    const targets = { resolveTargetIfMapped: async () => undefined };
    const withHost = action => action();
    const host = { target, label: "test host", source: "compute" };
    const notebook = { uri: notebookUri, metadata: {}, notebookType: "fabric-notebook-source" };
    const cell = { index: 0, document };
    const controller = new FabricNotebookController(livy, targets, compute, run, () => target.tenantId, withHost, async () => ({}));
    const runner = new CodeRunner(api, livy, targets, compute, run, {}, () => target.tenantId, withHost, async () => host, { show() {} });
    (async () => {
      await controllers[0].executeHandler([cell], notebook);
      const rendered = outputs.find(entry => entry.value).value;
      assert.equal(rendered.length, 2);
      const error = JSON.parse(rendered[0].items[0].data.toString());
      assert.equal(error.stack, traceback.join("\\n"));
      assert.equal(error.message, "Py4JJavaError: " + errorValue);
      const guidance = rendered[1].items[0].data.toString();
      assert.match(guidance, /Lakehouse Livy session/);
      assert.match(guidance, /Existing import guidance/);
      assert.equal(outputs.at(-1).success, false);
      assert.equal(toCellOutputs({ status: "error", errorValue: "unrelated", traceback: [] }).length, 1);
      await runner.runFile(fileUri);
      await runner.runSelection();
      await runner.runNotebookCells(notebookUri, { cell: 0 });
      await runner.runNotebookCells(notebookUri, { cell: 0, above: true });
      await runner.runNotebookCells(notebookUri, "all");
      assert.equal(text.filter(line => line.includes("[fabric-connect] Fabric Connect")).length, 5);
      assert.equal(text.filter(line => line.includes("Existing import guidance")).length, 5);
      for (const phase of ["host.resolve", "code.prepare", "modules.prepare", "statement.wait.module-setup", "statement.wait.user", "output.render"]) {
        assert.ok(logs.some(line => line.includes("phase=" + phase)));
      }
      assert.ok(!logs.join("\\n").includes("example-id"));
      assert.ok(!logs.join("\\n").includes("/repo/"));
      assert.match(logs.at(-1), /phase=total .*outcome=error$/);
      failPrelude = true;
      const before = submitted.length;
      await runner.runFile(fileUri);
      assert.equal(submitted.length, before + 1, "staging failure must not execute user code");
      failPrelude = false;
      failHost = true;
      await assert.rejects(runner.runFile(fileUri), /host failed/);
      assert.match(logs.at(-1), /phase=total .*outcome=error$/);
      failHost = false;
      cancelled = true;
      await controllers[0].executeHandler([cell], notebook);
      assert.ok(outputs.some(entry => entry.cleared));
      assert.equal(outputs.at(-1).success, undefined);
      assert.match(logs.at(-1), /phase=total .*outcome=cancelled$/);
      cancelled = false;
      enabled = false;
      const logCount = logs.length;
      await runner.runSelection();
      assert.equal(logs.length, logCount);
      runner.dispose();
      controller.dispose();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { stdio: "pipe" },
  );
});
