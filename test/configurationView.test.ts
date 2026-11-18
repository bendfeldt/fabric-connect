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
