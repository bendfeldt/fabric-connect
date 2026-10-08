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
    notebooks: Array<{ type: string; priority?: string }>;
    viewsContainers?: {
      activitybar?: Array<{ id: string; icon: string }>;
    };
    views: Record<string, Array<{ id: string }>>;
    menus: Record<string, Array<{ command: string; when?: string }>>;
    configuration: { properties: Record<string, unknown> };
    languages?: Array<{ id: string; filenames?: string[] }>;
    configurationDefaults?: Record<string, unknown>;
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
      onDidChangeConfiguration: event,
      onDidSaveTextDocument: event,
      registerTextDocumentContentProvider: () => disposable,
      onDidSaveNotebookDocument: event,
      createFileSystemWatcher: () => anything(),
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
      onDidChangeActiveTextEditor: event,
      createOutputChannel: () => anything(),
      createStatusBarItem: () => anything(),
      registerTreeDataProvider: (id: string) => {
        recorded.treeViews.push(id);
        return disposable;
      },
      createTreeView: (id: string) => {
        recorded.treeViews.push(id);
        return anything();
      },
    },
    languages: {
      registerHoverProvider: () => disposable,
      registerCodeLensProvider: () => disposable,
    },
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

test("a Fabric Activity Bar container holds the views, next to the Explorer's", () => {
  const containers = manifest.contributes.viewsContainers?.activitybar ?? [];
  const fabric = containers.find((c) => c.id === "fabric-connect");
  assert.ok(fabric !== undefined, "Activity Bar container fabric-connect");
  assert.match(fabric.icon, /\.svg$/, "Activity Bar icons are SVG");
  const svg = readFileSync(path.join(ROOT, fabric.icon), "utf8");
  assert.match(svg, /currentColor/, "the icon follows the theme colour");
  assert.deepEqual(
    (manifest.contributes.views["fabric-connect"] ?? []).map((v) => v.id),
    [
      "fabricConnect.configuration",
      "fabricConnect.repo",
      "fabricConnect.lakehouses",
      "fabricConnect.connections",
    ],
  );
  assert.deepEqual(
    (manifest.contributes.views["explorer"] ?? []).map((v) => v.id),
    ["fabricConnect.explorer"],
    "the Explorer side bar keeps its Fabric view",
  );
});

test("Lakehouse actions are offered only in the Lakehouses view, never in Repo", () => {
  const entries = (manifest.contributes.menus["view/item/context"] ??
    []) as Array<{ command: string; when?: string }>;
  const lakehouseEntries = entries.filter((e) =>
    e.command.startsWith("fabric-connect.lakehouses."),
  );
  assert.ok(lakehouseEntries.length > 0);
  for (const entry of lakehouseEntries) {
    assert.match(entry.when ?? "", /^view == fabricConnect\.lakehouses /);
  }
});

test("Bind / Unbind Lakehouse are offered on binding rows of the Lakehouses view only", () => {
  const entries = (manifest.contributes.menus["view/item/context"] ??
    []) as Array<{ command: string; when?: string }>;
  for (const command of [
    "fabric-connect.bindDefaultLakehouse",
    "fabric-connect.unbindDefaultLakehouse",
  ]) {
    const matching = entries.filter((e) => e.command === command);
    assert.ok(matching.length > 0, command);
    for (const entry of matching) {
      assert.match(
        entry.when ?? "",
        /^view == fabricConnect\.lakehouses && viewItem == fabric(Unbound|Bound)Lakehouse$/,
        command,
      );
    }
  }
  assert.ok(
    !entries.some(
      (e) =>
        e.command === "fabric-connect.unbindDefaultLakehouse" &&
        /Unbound/.test(e.when ?? ""),
    ),
    "nothing to unbind on an unbound row",
  );
});

test(".platform opens as JSON and notebook tabs are named after their item folder", () => {
  const json = (manifest.contributes.languages ?? []).find(
    (l) => l.id === "json",
  );
  assert.deepEqual(json?.filenames, [".platform"]);
  assert.deepEqual(
    manifest.contributes.configurationDefaults?.[
      "workbench.editor.customLabels.patterns"
    ],
    { "**/*.Notebook/notebook-content.*": "${dirname}" },
  );
});

test("notebooks open in the notebook editor; text diffs come from Open Changes as Text", () => {
  const priority = (type: string) =>
    manifest.contributes.notebooks.find((n) => n.type === type)?.priority;
  // Both stay the default editor: openNotebookDocument(uri) needs one, and
  // the raw diff is offered on the Source Control row instead.
  assert.equal(priority("fabric-notebook-source"), undefined);
  assert.equal(priority("fabric-notebook"), undefined);
  const scm = (
    manifest.contributes.menus["scm/resourceState/context"] ?? []
  ).map((entry) => entry.command);
  assert.ok(scm.includes("fabric-connect.openChangesAsText"));
});

test("Lakehouses view rows browse OneLake with the explorer's table and file actions", () => {
  const inView = manifest.contributes.menus["view/item/context"].filter((e) =>
    (e.when ?? "").includes("view == fabricConnect.lakehouses"),
  );
  // A minimal evaluator for the `when` clauses used here: the view, plus
  // `viewItem == X` or `viewItem =~ /re/`.
  const shownFor = (when: string, viewItem: string) => {
    const eq = /viewItem == (\S+)/.exec(when);
    const re = /viewItem =~ \/(.+?)\/(?:\s|$)/.exec(when);
    return eq !== null
      ? eq[1] === viewItem
      : re !== null
        ? new RegExp(re[1]).test(viewItem)
        : true;
  };
  const offered = (command: string, viewItem: string, group?: string) =>
    inView.some(
      (e) =>
        e.command === command &&
        shownFor(e.when ?? "", viewItem) &&
        (group === undefined || (e as { group?: string }).group === group),
    );
  const preview = "fabric-connect.explorer.previewTable";
  assert.ok(offered(preview, "fabricTable", "inline"));
  assert.ok(offered(preview, "fabricTable", "0_preview"));
  assert.ok(!offered(preview, "fabricFile"));
  assert.ok(offered("fabric-connect.explorer.previewFile", "fabricFile"));
  assert.ok(!offered("fabric-connect.explorer.previewFile", "fabricFolder"));
  for (const viewItem of ["fabricTable", "fabricFolder", "fabricFile"]) {
    assert.ok(offered("fabric-connect.explorer.copyOneLakePath", viewItem));
  }
  // None of them land on the view's own Lakehouse rows.
  for (const row of [
    "fabricLakehouse",
    "fabricLakehouse attached default",
    "fabricBoundLakehouse",
  ]) {
    for (const command of [
      preview,
      "fabric-connect.explorer.previewFile",
      "fabric-connect.explorer.copyOneLakePath",
    ]) {
      assert.ok(!offered(command, row), `${command} on ${row}`);
    }
  }
});

test("the icon and entry point referenced by the manifest exist", () => {
  assert.ok(
    manifest.icon !== undefined && existsSync(path.join(ROOT, manifest.icon)),
  );
  assert.ok(existsSync(path.join(ROOT, manifest.main)));
});
