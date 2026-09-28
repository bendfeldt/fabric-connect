/**
 * Shipping check: activates the compiled extension against a recording
 * stub of the `vscode` API and compares what it registers with what
 * package.json declares. Catches the "declared in the manifest but never
 * wired" (and the reverse) class of bugs that unit tests of core modules
 * cannot see, without needing a real VS Code.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const ROOT = path.join(__dirname, "..", "..");
const manifest = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as {
  main: string;
  icon?: string;
  contributes: {
    commands: Array<{ command: string }>;
    notebooks: Array<{ type: string }>;
    views: Record<string, Array<{ id: string }>>;
    menus: Record<string, Array<{ command: string }>>;
    configuration: { properties: Record<string, unknown> };
    walkthroughs?: Array<{
      steps: Array<{
        id: string;
        description: string;
        media: { markdown?: string };
        completionEvents?: string[];
      }>;
    }>;
  };
};

interface Recorded {
  commands: string[];
  serializers: string[];
  controllers: string[];
  treeViews: string[];
  configKeys: string[];
}

/** A value that tolerates any property access, call or construction. */
function anything(): unknown {
  const target = function () {
    /* stub */
  };
  return new Proxy(target, {
    get: (_t, prop) => {
      if (prop === "then") {
        return undefined; // not a promise
      }
      if (prop === Symbol.toPrimitive) {
        return () => "";
      }
      if (prop === "dispose") {
        return () => undefined;
      }
      return anything();
    },
    // The extension assigns properties (e.g. `statusBar.name`); accept them.
    set: () => true,
    apply: () => anything(),
    construct: () => anything() as object,
  });
}

function vscodeStub(workspaceRoot: string, recorded: Recorded): unknown {
  const disposable = { dispose: () => undefined };
  const event = () => disposable;
  class EventEmitter {
    event = event;
    fire(): void {}
    dispose(): void {}
  }
  const stub: Record<string, unknown> = {
    EventEmitter,
    StatusBarAlignment: { Left: 1, Right: 2 },
    NotebookCellKind: { Markup: 1, Code: 2 },
    ProgressLocation: { Notification: 15 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Beside: -2 },
    commands: {
      registerCommand: (id: string) => {
        recorded.commands.push(id);
        return disposable;
      },
      executeCommand: async () => undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      notebookDocuments: [],
      registerNotebookSerializer: (type: string) => {
        recorded.serializers.push(type);
        return disposable;
      },
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => {
          recorded.configKeys.push(key);
          return fallback;
        },
      }),
      onDidChangeNotebookDocument: event,
      findFiles: async () => [],
    },
    notebooks: {
      createNotebookController: (_id: string, type: string) => {
        recorded.controllers.push(type);
        return { dispose: () => undefined };
      },
    },
    window: {
      activeNotebookEditor: undefined,
      activeTextEditor: undefined,
      onDidChangeActiveNotebookEditor: event,
      createOutputChannel: () => anything(),
      createStatusBarItem: () => anything(),
      registerTreeDataProvider: (id: string) => {
        recorded.treeViews.push(id);
        return disposable;
      },
    },
    languages: { registerHoverProvider: () => disposable },
    authentication: {
      getSession: async () => undefined,
      getAccounts: async () => [],
      onDidChangeSessions: event,
    },
  };
  return new Proxy(stub, {
    get: (target, prop: string) => (prop in target ? target[prop] : anything()),
  });
}

let activated: Recorded | undefined;

/**
 * Activates once: the compiled extension is cached by `require`, so every
 * later call would still talk to the first stub.
 */
function activateWithStub(): Recorded {
  activated ??= activateOnce();
  return activated;
}

function activateOnce(): Recorded {
  const recorded: Recorded = {
    commands: [],
    serializers: [],
    controllers: [],
    treeViews: [],
    configKeys: [],
  };
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "fabric-connect-"));
  const stub = vscodeStub(workspaceRoot, recorded);
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
    const main = path.join(ROOT, manifest.main);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const extension = require(main) as {
      activate: (context: unknown) => void;
    };
    const memento = { get: () => undefined, update: async () => undefined };
    extension.activate({
      subscriptions: [],
      workspaceState: memento,
      globalState: memento,
    });
  } finally {
    loader._load = original;
  }
  return recorded;
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

test("every declared command is registered on activation, and nothing else", () => {
  const recorded = activateWithStub();
  assert.deepEqual(
    sorted(recorded.commands),
    sorted(manifest.contributes.commands.map((c) => c.command)),
  );
});

test("every notebook type has a serializer; Livy/API notebooks have controllers", () => {
  const recorded = activateWithStub();
  const declared = sorted(manifest.contributes.notebooks.map((n) => n.type));
  assert.deepEqual(sorted(recorded.serializers), declared);
  assert.deepEqual(sorted(recorded.controllers), declared);
});

test("every declared view has a tree data provider", () => {
  const recorded = activateWithStub();
  const views = Object.values(manifest.contributes.views)
    .flat()
    .map((v) => v.id);
  assert.deepEqual(sorted(recorded.treeViews), sorted(views));
});

test("settings read by the extension are declared in the manifest", () => {
  const recorded = activateWithStub();
  const declared = new Set(
    Object.keys(manifest.contributes.configuration.properties),
  );
  for (const key of recorded.configKeys) {
    assert.ok(
      declared.has(`fabric-connect.${key}`),
      `setting fabric-connect.${key} is read but not declared`,
    );
  }
});

test("menus and walkthroughs only reference declared commands and existing media", () => {
  const commands = new Set(manifest.contributes.commands.map((c) => c.command));
  for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
    for (const entry of entries) {
      assert.ok(commands.has(entry.command), `${menu}: ${entry.command}`);
    }
  }
  const walkthroughs = manifest.contributes.walkthroughs ?? [];
  assert.ok(walkthroughs.length > 0, "a getting-started walkthrough ships");
  for (const step of walkthroughs.flatMap((w) => w.steps)) {
    for (const match of step.description.matchAll(
      /command:(fabric-connect\.[\w.]+)/g,
    )) {
      assert.ok(commands.has(match[1]), `walkthrough link ${match[1]}`);
    }
    for (const event of step.completionEvents ?? []) {
      const onCommand = /^onCommand:(fabric-connect\.[\w.]+)$/.exec(event);
      if (onCommand !== null) {
        assert.ok(commands.has(onCommand[1]), `completion event ${event}`);
      }
    }
    if (step.media.markdown !== undefined) {
      assert.ok(
        existsSync(path.join(ROOT, step.media.markdown)),
        step.media.markdown,
      );
    }
  }
});

test("setup walkthrough steps tick on success, not on clicking the link", () => {
  // onCommand fires when the link is clicked, even if sign-in is cancelled.
  const steps = new Map(
    (manifest.contributes.walkthroughs ?? [])
      .flatMap((w) => w.steps)
      .map((step) => [step.id, step]),
  );
  for (const [id, context] of [
    ["signIn", "fabricConnect.signedIn"],
    ["connectCompute", "fabricConnect.computeConnected"],
  ]) {
    assert.deepEqual(steps.get(id)?.completionEvents, [`onContext:${context}`]);
    assert.match(
      steps.get(id)?.description ?? "",
      /\?%5B%22walkthrough%22%5D\)/,
      `${id} link passes "walkthrough" so success moves to the next step`,
    );
  }
});

test("the icon and entry point referenced by the manifest exist", () => {
  assert.ok(
    manifest.icon !== undefined && existsSync(path.join(ROOT, manifest.icon)),
  );
  assert.ok(existsSync(path.join(ROOT, manifest.main)));
});
