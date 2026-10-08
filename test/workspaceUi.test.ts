import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";

const standIn = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const load = Module._load;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-workspace-ui-"));
const tenantId = "11111111-1111-1111-1111-111111111111";
const capacityId = "22222222-2222-2222-2222-222222222222";
const workspaceId = "33333333-3333-3333-3333-333333333333";
const lakehouseId = "44444444-4444-4444-4444-444444444444";
const nextLakehouseId = "55555555-5555-5555-5555-555555555555";
const environmentId = "66666666-6666-6666-6666-666666666666";
const nextEnvironmentId = "77777777-7777-7777-7777-777777777777";
const localFile = path.join(temp, ".fabric", "local.json");
const errors = [];
let messageHandler, applied = true, saved = true;
const notebookUri = {
  fsPath: path.join(temp, "Example.Notebook", "notebook-content.ipynb"),
  toString() { return this.fsPath; }
};
const notebook = {
  uri: notebookUri, notebookType: "fabric-notebook",
  metadata: { fabricRoot: { metadata: { keep: "untouched" } } },
  async save() { return saved; }
};
const disposable = () => ({ dispose() {} });
const vscode = {
  EventEmitter: class {
    event = () => disposable();
    fire() {}
    dispose() {}
  },
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Notification: 1 },
  QuickPickItemKind: { Separator: -1 },
  ViewColumn: { Beside: 2 },
  WorkspaceEdit: class {
    set(uri, edits) { this.uri = uri; this.edits = edits; }
  },
  NotebookEdit: { updateNotebookMetadata: metadata => ({ metadata }) },
  commands: { async executeCommand() {} },
  workspace: {
    notebookDocuments: [notebook], textDocuments: [],
    async applyEdit(edit) {
      if (applied) notebook.metadata = edit.edits[0].metadata;
      return applied;
    }
  },
  window: {
    visibleNotebookEditors: [{ notebook }],
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    async showInformationMessage() {},
    async showWarningMessage() {},
    async showErrorMessage(message) { errors.push(message); },
    async showInputBox() { return "My capacity"; },
    async showQuickPick(items) {
      return items.find(item => item.value !== undefined && item.value.id !== "");
    },
    async withProgress(_options, action) { return action(); },
    createWebviewPanel: () => ({
      reveal() {}, onDidDispose: disposable,
      webview: {
        html: "",
        onDidReceiveMessage(handler) { messageHandler = handler; return disposable(); }
      }
    })
  }
};
Module._load = function(request, parent, isMain) {
  return request === "vscode" ? vscode : load.call(this, request, parent, isMain);
};
const { ComputeConnection } = require(sourceRoot + "/vscode/computeConnection.js");
const { LakehousePanel } = require(sourceRoot + "/vscode/lakehousePanel.js");
const { LakehouseBindingStore } = require(sourceRoot + "/vscode/lakehouseBindingStore.js");
const { readComputeProfile, writeComputeProfile } = require(sourceRoot + "/core/computeProfile.js");
const { getLakehouseAttachments } = require(sourceRoot + "/core/notebookCodec.js");
fs.mkdirSync(path.dirname(localFile));
fs.writeFileSync(path.join(temp, ".gitignore"), ".fabric/\n");
const initial = {
  tenantId, capacityId, capacityName: "Capacity " + capacityId.slice(0, 8),
  workspaceId, workspaceName: "Workspace", lakehouseId, lakehouseName: "Old host",
  environmentId, environmentName: "Old environment"
};
fs.writeFileSync(localFile, writeComputeProfile('{"unrelated":{"keep":true}}', initial));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function refreshFixture() {
  const response = deferred(), started = deferred();
  const api = { async request(options) {
    if (options.path === "/capacities") {
      started.resolve();
      return response.promise;
    }
    if (options.path === "/v1.0/myorg/capacities") return { body: { value: [] } };
    if (options.path === "/workspaces") return { body: { value: [
      { id: workspaceId, displayName: "Workspace", capacityId }
    ] } };
    if (options.path.endsWith("/lakehouses")) return { body: { value: [
      { id: nextLakehouseId, displayName: "New host" }
    ] } };
    if (options.path.endsWith("/environments")) return { body: { value: [
      { id: nextEnvironmentId, displayName: "New environment" }
    ] } };
    throw new Error("Unexpected request: " + options.path);
  }};
  const connection = new ComputeConnection(api, temp, async () => tenantId);
  const refresh = connection.refreshCapacityName(tenantId);
  const finish = () => response.resolve({ body: { value: [{
    id: capacityId, displayName: "Actual capacity", sku: "F8", state: "Active"
  }] } });
  return { connection, refresh, started: started.promise, finish };
}
async function panelFixture(bound = true) {
  const bindings = new LakehouseBindingStore(temp);
  if (bound) {
    await bindings.set(notebookUri, { tenantId, workspaceId, lakehouseId, lakehouseName: "Old host" });
  }
  const api = { async request() { return { body: { value: [
    { id: nextLakehouseId, displayName: "New default" }
  ] } }; } };
  const targets = { async resolveTargetIfMapped() { return { tenantId, workspaceId }; } };
  const panel = new LakehousePanel(
    api, targets, async () => undefined, bindings
  );
  await panel.show(notebookUri);
  return bindings;
}
`;

function runConsumer(script: string): void {
  execFileSync(
    process.execPath,
    [
      "-e",
      `const sourceRoot = ${JSON.stringify(path.resolve(__dirname, "../src"))};
${standIn}
(async () => {
  try {
    ${script}
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    { stdio: "pipe" },
  );
}

test("capacity-name refresh does not reconnect after disconnect", () => {
  runConsumer(`
    const fixture = refreshFixture();
    await fixture.started;
    await fixture.connection.disconnect();
    fixture.finish();
    await fixture.refresh;
    assert.equal(await fixture.connection.current(), undefined);
  `);
});

test("capacity-name refresh does not restore a superseded capacity", () => {
  runConsumer(`
    const fixture = refreshFixture();
    await fixture.started;
    await fixture.connection.connect({
      id: nextLakehouseId, displayName: "Other capacity", sku: "F16", region: "", state: "Active"
    });
    const selected = await fixture.connection.current();
    fixture.finish();
    await fixture.refresh;
    assert.deepEqual(await fixture.connection.current(), selected);
  `);
});

test("capacity-name refresh preserves a newly selected host and Environment", () => {
  runConsumer(`
    const fixture = refreshFixture();
    await fixture.started;
    await fixture.connection.changeHost();
    fixture.finish();
    await fixture.refresh;
    const current = await fixture.connection.current();
    assert.equal(current.lakehouseId, nextLakehouseId);
    assert.equal(current.environmentId, nextEnvironmentId);
    assert.equal(current.capacityName, "Actual capacity");
  `);
});

test("capacity-name refresh preserves a name given during the listing", () => {
  runConsumer(`
    const fixture = refreshFixture();
    await fixture.started;
    await fixture.connection.nameCapacity();
    const named = await fixture.connection.current();
    fixture.finish();
    await fixture.refresh;
    assert.deepEqual(await fixture.connection.current(), named);
  `);
});

test("capacity-name refresh updates names without dropping unrelated local state", () => {
  runConsumer(`
    const fixture = refreshFixture();
    await fixture.started;
    fixture.finish();
    await fixture.refresh;
    assert.deepEqual(await fixture.connection.current(), {
      ...initial, capacityName: "Actual capacity", sku: "F8"
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(localFile, "utf8")).unrelated, { keep: true });
  `);
});

test("Lakehouse panel Make default clears the binding after a successful edit", () => {
  runConsumer(`
    const bindings = await panelFixture();
    await messageHandler({ command: "makeDefault", id: nextLakehouseId, name: "New default" });
    assert.equal(errors.length, 0);
    assert.equal(getLakehouseAttachments(notebook.metadata.fabricRoot).defaultLakehouse.id, nextLakehouseId);
    assert.equal(await bindings.get(notebookUri), undefined);
    assert.equal(notebook.metadata.fabricRoot.metadata.keep, "untouched");
  `);
});

test("Lakehouse panel retains the binding when the metadata edit is rejected", () => {
  runConsumer(`
    const bindings = await panelFixture();
    const binding = await bindings.get(notebookUri);
    applied = false;
    await messageHandler({ command: "makeDefault", id: nextLakehouseId, name: "New default" });
    assert.match(errors[0], /rejected the metadata edit/);
    assert.deepEqual(await bindings.get(notebookUri), binding);
  `);
});

test("Lakehouse panel retains the binding when saving fails", () => {
  runConsumer(`
    const bindings = await panelFixture();
    const binding = await bindings.get(notebookUri);
    vscode.window.visibleNotebookEditors = [];
    saved = false;
    await messageHandler({ command: "makeDefault", id: nextLakehouseId, name: "New default" });
    assert.match(errors[0], /saving the notebook failed/);
    assert.deepEqual(await bindings.get(notebookUri), binding);
  `);
});

test("Lakehouse panel Attach retains the local binding", () => {
  runConsumer(`
    const bindings = await panelFixture();
    const binding = await bindings.get(notebookUri);
    await messageHandler({ command: "attach", id: nextLakehouseId, name: "Attached" });
    assert.equal(errors.length, 0);
    assert.deepEqual(await bindings.get(notebookUri), binding);
  `);
});

test("Lakehouse panel Make default works outside the repo without a binding", () => {
  runConsumer(`
    notebookUri.fsPath = path.join(path.dirname(temp), "Outside.Notebook", "notebook-content.ipynb");
    await panelFixture(false);
    const before = fs.readFileSync(localFile, "utf8");
    await messageHandler({ command: "makeDefault", id: nextLakehouseId, name: "New default" });
    assert.equal(errors.length, 0);
    assert.equal(getLakehouseAttachments(notebook.metadata.fabricRoot).defaultLakehouse.id, nextLakehouseId);
    assert.equal(fs.readFileSync(localFile, "utf8"), before);
  `);
});
