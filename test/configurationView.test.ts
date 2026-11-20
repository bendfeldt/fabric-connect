import assert from "node:assert/strict";
import Module from "node:module";
import { test } from "node:test";

class TestTreeItem {
  description?: string;
  command?: { command: string };
  iconPath?: { id: string };
  contextValue?: string;

  constructor(
    readonly label: string,
    readonly collapsibleState: number,
  ) {}
}

function loadConfigurationView(): typeof import("../src/vscode/configurationView").ConfigurationView {
  const stub = {
    EventEmitter: class {
      event = () => undefined;
      fire(): void {}
      dispose(): void {}
    },
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    TreeItem: TestTreeItem,
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
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
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (
      require("../src/vscode/configurationView") as typeof import("../src/vscode/configurationView")
    ).ConfigurationView;
  } finally {
    loader._load = original;
  }
}

test("Configuration shows the Variable Library status and opens its picker", async () => {
  const stub = {
    EventEmitter: class {
      event = () => undefined;
      fire(): void {}
      dispose(): void {}
    },
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    TreeItem: TestTreeItem,
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
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
  let ConfigurationView: typeof import("../src/vscode/configurationView").ConfigurationView;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ConfigurationView = (
      require("../src/vscode/configurationView") as typeof import("../src/vscode/configurationView")
    ).ConfigurationView;
  } finally {
    loader._load = original;
  }

  const view = new ConfigurationView(
    {
      current: () => ({ account: "user" }),
      accountSignedIn: () => true,
    } as never,
    async () => undefined,
    () => undefined,
    async () => ({
      mode: "remote",
      label: "Remote",
      tooltip: "",
      icon: "cloud",
    }),
    () => ({ name: "settings", variableCount: 2 }),
  );
  const nodes = await view.getChildren();
  const libraryNode = nodes.find((node) => node.kind === "variableLibrary");
  assert.ok(libraryNode);
  const item = view.getTreeItem(libraryNode) as unknown as TestTreeItem;
  assert.equal(item.label, "Variable library");
  assert.equal(item.description, "settings · 2 variables");
  assert.equal(item.command?.command, "fabric-connect.variableLibrary");
  assert.equal(item.contextValue, "fabricConfigVariableLibrary");
  view.dispose();

  const emptyView = new ConfigurationView(
    {
      current: () => ({ account: "user" }),
      accountSignedIn: () => true,
    } as never,
    async () => undefined,
    () => undefined,
    async () => ({
      mode: "remote",
      label: "Remote",
      tooltip: "",
      icon: "cloud",
    }),
    () => undefined,
  );
  const emptyNodes = await emptyView.getChildren();
  const emptyLibraryNode = emptyNodes.find(
    (node) => node.kind === "variableLibrary",
  );
  assert.ok(emptyLibraryNode);
  assert.equal(
    (emptyView.getTreeItem(emptyLibraryNode) as unknown as TestTreeItem)
      .description,
    "not selected",
  );
  emptyView.dispose();
});

test("Configuration presents a complete host Lakehouse before capacity metadata", async () => {
  const ConfigurationView = loadConfigurationView();
  const view = new ConfigurationView(
    {
      current: () => ({ account: "user" }),
      accountSignedIn: () => true,
    } as never,
    async () => ({
      tenantId: "11111111-1111-1111-1111-111111111111",
      capacityId: "22222222-2222-2222-2222-222222222222",
      capacityName: "Development",
      sku: "F8",
      workspaceId: "33333333-3333-3333-3333-333333333333",
      workspaceName: "Sandbox",
      lakehouseId: "44444444-4444-4444-4444-444444444444",
      lakehouseName: "scratch",
    }),
    () => undefined,
    async () => ({
      mode: "remote",
      label: "Remote",
      tooltip: "",
      icon: "cloud",
    }),
    () => undefined,
  );
  const node = (await view.getChildren()).find(
    (candidate) => candidate.kind === "compute",
  );
  assert.ok(node);
  const item = view.getTreeItem(node) as unknown as TestTreeItem;
  assert.equal(item.label, "Execution host");
  assert.equal(item.description, "Sandbox / scratch");
  view.dispose();

  const legacy = new ConfigurationView(
    {
      current: () => ({ account: "user" }),
      accountSignedIn: () => true,
    } as never,
    async () => ({
      tenantId: "11111111-1111-1111-1111-111111111111",
      capacityId: "22222222-2222-2222-2222-222222222222",
      capacityName: "Legacy capacity",
    }),
    () => undefined,
    async () => ({
      mode: "remote",
      label: "Remote",
      tooltip: "",
      icon: "cloud",
    }),
    () => undefined,
  );
  const legacyNode = (await legacy.getChildren()).find(
    (candidate) => candidate.kind === "compute",
  );
  assert.ok(legacyNode);
  const legacyItem = legacy.getTreeItem(legacyNode) as unknown as TestTreeItem;
  assert.equal(legacyItem.label, "Execution host");
  assert.equal(legacyItem.description, "not selected");
  assert.equal(legacyItem.collapsibleState, 0);
  assert.equal(legacyItem.command?.command, "fabric-connect.connectCompute");
  assert.equal(legacyItem.contextValue, "fabricConfigCompute");
  legacy.dispose();
});
