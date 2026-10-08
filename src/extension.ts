/**
 * Composition root. Plain, readable constructor calls — no DI container,
 * no decorators, no reflection. A request can be traced from "cell run"
 * to "Livy call" by reading this file top to bottom.
 *
 * Activation is lazy: VS Code activates the extension only when a Fabric
 * notebook is opened (contributes.notebooks) or one of our commands runs,
 * never unconditionally on startup.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  type ComputeProfile,
  describeCompute,
  hostOf,
} from "./core/computeProfile";
import { FabricApiClient } from "./core/fabricApiClient";
import { probeLivyHost } from "./core/livyHost";
import { DISPLAY_BOOTSTRAP_CODE } from "./core/displayProtocol";
import {
  LivySessionManager,
  listLivySessions,
} from "./core/livySessionManager";
import { CachedItemIndex } from "./core/localItemIndex";
import { NameCache, guidAt } from "./core/nameCache";
import { OneLakeClient } from "./core/oneLakeClient";
import { TargetResolver } from "./core/targetResolver";
import type { TenantInfo } from "./core/tenantDirectory";
import { EntraAuthProvider } from "./vscode/authProvider";
import {
  API_NOTEBOOK_TYPE,
  ApiNotebookController,
  ApiNotebookSerializer,
} from "./vscode/apiNotebookController";
import { CodeRunner } from "./vscode/codeRunner";
import { ConfigurationView } from "./vscode/configurationView";
import {
  type AttachmentSources,
  notebookTypeOf,
} from "./vscode/lakehouseAttachments";
import { LakehouseBindingStore } from "./vscode/lakehouseBindingStore";
import { type LakehouseNode, LakehousesView } from "./vscode/lakehousesView";
import { type RepoNode, RepoView } from "./vscode/repoView";
import { type ExplorerRoot, FabricExplorer } from "./vscode/explorer";
import { ComputeConnection } from "./vscode/computeConnection";
import { LakehousePanel } from "./vscode/lakehousePanel";
import {
  activeFabricNotebookUri,
  fabricNotebookFor,
} from "./vscode/activeNotebook";
import { ModuleStager } from "./vscode/moduleStager";
import { NotebookCellLensProvider } from "./vscode/notebookCellLens";
import { NotebookTextDiff, openAsText } from "./vscode/notebookTextDiff";
import { TEXT_VIEW_SCHEME } from "./core/notebookTextDiff";
import { QueryRunner } from "./vscode/queryRunner";
import { ResultsPanel } from "./vscode/resultsPanel";
import { SignInManager } from "./vscode/signIn";
import { TenantPicker } from "./vscode/tenantPicker";
import {
  FabricNotebookController,
  resolveNotebookHost,
} from "./vscode/notebookController";
import {
  FabricNotebookSerializer,
  FabricSourceNotebookSerializer,
  NOTEBOOK_SOURCE_TYPE,
  NOTEBOOK_TYPE,
  isFabricNotebook,
} from "./vscode/notebookSerializer";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const output = vscode.window.createOutputChannel("Fabric Connect");
  const logger = {
    debug(message: string): void {
      if (
        vscode.workspace
          .getConfiguration("fabric-connect")
          .get<boolean>("debugLogging", false)
      ) {
        output.appendLine(`[${new Date().toISOString()}] ${message}`);
      }
    },
  };

  const auth = new EntraAuthProvider();
  const apiClient = new FabricApiClient(auth, { logger });

  const targetResolver = new TargetResolver(
    {
      readFile: async (filePath) => {
        try {
          return await fs.readFile(filePath, "utf8");
        } catch {
          return undefined;
        }
      },
    },
    workspaceRoot ?? "",
  );
  // Part 1 registers only 'notebook'; Part 2 adds 'pipeline' here without
  // touching the Target Config Module.
  targetResolver.registerItemType("notebook", { itemType: "notebook" });

  const livyManager = new LivySessionManager(
    apiClient,
    {
      get: (key) => context.workspaceState.get<string>(key),
      set: (key, value) => {
        void context.workspaceState.update(key, value);
      },
    },
    // Defines display() in every session so DataFrames render as tables.
    { bootstrap: { code: DISPLAY_BOOTSTRAP_CODE, kind: "pyspark" } },
  );

  const readFile = async (filePath: string): Promise<string | undefined> => {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return undefined;
    }
  };
  // Items in this working tree, from their .platform files: scanned once,
  // rescanned only after a .platform file is created, changed or deleted.
  const itemIndex = new CachedItemIndex({
    findPlatformFiles: async () =>
      (
        await vscode.workspace.findFiles("**/.platform", "**/node_modules/**")
      ).map((uri) => uri.fsPath),
    readFile,
  });
  const localIndex = () => itemIndex.get();
  const platformWatcher =
    vscode.workspace.createFileSystemWatcher("**/.platform");
  const invalidateIndex = () => itemIndex.invalidate();
  context.subscriptions.push(
    platformWatcher,
    platformWatcher.onDidCreate(invalidateIndex),
    platformWatcher.onDidChange(invalidateIndex),
    platformWatcher.onDidDelete(invalidateIndex),
  );

  // The repo's sign-in (account + tenant, saved in .fabric/local.json) is
  // the tenant everything uses; signing in is asked for when it is missing.
  let computeTenant = async (): Promise<TenantInfo[]> => [];
  const tenants = new TenantPicker(apiClient, context.globalState, () =>
    computeTenant(),
  );
  const signIn = new SignInManager(
    auth,
    tenants,
    workspaceRoot,
    context.workspaceState,
  );
  const requireTenant = () => signIn.requireTenant();

  const computeConnection = new ComputeConnection(
    apiClient,
    workspaceRoot,
    requireTenant,
  );
  const compute = () => computeConnection.current();
  // The compute connection's tenant is offered when switching tenant.
  computeTenant = async () => {
    const profile = await compute();
    return profile === undefined ? [] : [{ id: profile.tenantId }];
  };

  const oneLake = new OneLakeClient(auth);
  const stager = new ModuleStager(oneLake, workspaceRoot);
  const runContext = {
    index: localIndex,
    fs: { readFile },
    prepare: (target: Parameters<ModuleStager["prepare"]>[0]) =>
      stager.prepare(target),
    importHint: (
      errorName: string | undefined,
      errorValue: string | undefined,
    ) => stager.importHint(errorName, errorValue),
  };

  const serializer = new FabricNotebookSerializer();
  // Where a notebook's Lakehouses come from besides its metadata: repo
  // Lakehouse items by logicalId (a default with such an ID, as Fabric
  // writes in git, is not a deployed Lakehouse) and this machine's
  // per-notebook bindings in .fabric/local.json.
  const bindingStore = new LakehouseBindingStore(workspaceRoot);
  const attachmentSources: AttachmentSources = {
    logicalNames: async () => {
      const index = await localIndex();
      return (id: string) => {
        const item = index.findByLogicalId(id);
        return item?.type === "Lakehouse" ? item.displayName : undefined;
      };
    },
    localBinding: (notebook) => bindingStore.get(notebook),
  };
  const controller = new FabricNotebookController(
    livyManager,
    targetResolver,
    compute,
    runContext,
    () => signIn.tenant(),
    (resolve) => computeConnection.runWithHost(resolve),
    (target) => probeLivyHost(apiClient, target),
    attachmentSources,
  );
  const resultsPanel = new ResultsPanel();
  const queryRunner = new QueryRunner(
    apiClient,
    workspaceRoot,
    compute,
    requireTenant,
    resultsPanel,
  );
  const names = new NameCache();
  const newExplorer = (root: ExplorerRoot) =>
    new FabricExplorer(
      apiClient,
      oneLake,
      livyManager,
      compute,
      () => signIn.tenant(),
      names,
      resultsPanel,
      workspaceRoot,
      () => computeConnection.connectedCapacityId(),
      () => computeConnection.requireHost(),
      root,
    );
  // The Explorer side bar's "Fabric" tree, and its parts as the views of
  // the Fabric Activity Bar container.
  const explorer = newExplorer("all");
  const explorerViews: Array<[string, FabricExplorer]> = [
    ["fabricConnect.explorer", explorer],
    ["fabricConnect.connections", newExplorer("connections")],
  ];
  const explorers = explorerViews.map(([, view]) => view);
  const refreshExplorers = () => {
    for (const view of explorers) {
      view.refresh();
    }
  };
  const configurationView = new ConfigurationView(
    signIn,
    compute,
    (profile) => computeConnection.nameHiddenReason(profile),
    () => stager.describe(),
  );
  // Lakehouses attached to the active (or Repo-selected) notebook, offered
  // from the workspaces on the connected capacity.
  const lakehousesView = new LakehousesView(
    apiClient,
    async () => signIn.tenant() ?? (await compute())?.tenantId,
    () => computeConnection.connectedCapacityId(),
    bindingStore,
    attachmentSources,
    oneLake,
  );
  const lakehousesTree = vscode.window.createTreeView(
    "fabricConnect.lakehouses",
    { treeDataProvider: lakehousesView },
  );
  const describeLakehousesTarget = (notebook: vscode.Uri | undefined) => {
    lakehousesTree.description =
      notebook === undefined
        ? undefined
        : path.basename(path.dirname(notebook.fsPath));
  };
  describeLakehousesTarget(lakehousesView.currentTarget());
  // The working tree, run on the connected compute (named in the title).
  const repoView = new RepoView(
    workspaceRoot,
    (id) => lakehousesView.nameOf(id),
    attachmentSources,
  );
  const repoTree = vscode.window.createTreeView("fabricConnect.repo", {
    treeDataProvider: repoView,
  });
  const describeRepoTarget = async () => {
    let profile: ComputeProfile | undefined;
    try {
      profile = await compute();
    } catch {
      // The status bar and Configuration view report an invalid file.
    }
    repoTree.description =
      profile === undefined ? "no compute" : describeCompute(profile);
  };
  void describeRepoTarget();
  const codeRunner = new CodeRunner(
    apiClient,
    livyManager,
    targetResolver,
    compute,
    runContext,
    stager,
    () => signIn.tenant(),
    (resolve) => computeConnection.runWithHost(resolve),
    async (uri) =>
      resolveNotebookHost(
        await fabricNotebookFor(uri),
        targetResolver,
        compute,
        () => signIn.tenant(),
        attachmentSources,
      ),
    resultsPanel,
  );
  const lakehousePanel = new LakehousePanel(
    apiClient,
    targetResolver,
    compute,
    bindingStore,
  );

  void computeConnection.refreshStatus();
  void stager.refreshStatus();
  const textDiff = new NotebookTextDiff();
  void signIn
    .restore()
    .then(() => computeConnection.refreshCapacityName(signIn.tenant()));

  context.subscriptions.push(
    output,
    computeConnection,
    computeConnection.onDidChange(() => {
      void controller.refreshHostStatus();
    }),
    controller,
    codeRunner,
    stager,
    resultsPanel,
    vscode.workspace.registerNotebookSerializer(
      API_NOTEBOOK_TYPE,
      new ApiNotebookSerializer(),
      { transientOutputs: true },
    ),
    new ApiNotebookController(
      apiClient,
      async () =>
        signIn.tenant() ??
        (await compute())?.tenantId ??
        (await signIn.requireTenant()),
    ),
    ...explorers,
    ...explorerViews.map(([id, view]) =>
      vscode.window.registerTreeDataProvider(id, view),
    ),
    configurationView,
    vscode.window.registerTreeDataProvider(
      "fabricConnect.configuration",
      configurationView,
    ),
    stager.onDidChange(() => configurationView.refresh()),
    computeConnection.onDidChange(() => {
      refreshExplorers();
      configurationView.refresh();
      void describeRepoTarget();
      lakehousesView.refresh();
    }),
    repoView,
    repoTree,
    lakehousesView,
    lakehousesTree,
    lakehousesView.onDidChangeTarget(describeLakehousesTarget),
    // Selecting a notebook in Repo makes it the Lakehouses view's target.
    repoTree.onDidChangeSelection((e) => {
      const node = e.selection[0];
      if (node?.kind === "item" && node.content !== undefined) {
        lakehousesView.setTarget(node.content);
      } else if (
        node?.kind === "lakehouse" ||
        node?.kind === "unboundDefault"
      ) {
        lakehousesView.setTarget(node.notebook);
      }
    }),
    vscode.commands.registerCommand("fabric-connect.lakehouses.refresh", () =>
      lakehousesView.refresh(),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.lakehouses.attach",
      (node: LakehouseNode) =>
        runReportingErrors(() => lakehousesView.attach(node)),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.lakehouses.setDefault",
      (node: LakehouseNode) =>
        runReportingErrors(() => lakehousesView.setDefault(node)),
    ),
    // From the status bar or a notification (a notebook URI), or the
    // unbound row (a tree node with `notebook`).
    vscode.commands.registerCommand(
      "fabric-connect.bindDefaultLakehouse",
      (arg?: vscode.Uri | { notebook?: vscode.Uri }) =>
        runReportingErrors(() =>
          lakehousesView.bindDefault(
            arg instanceof vscode.Uri ? arg : arg?.notebook,
          ),
        ),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.unbindDefaultLakehouse",
      (arg?: vscode.Uri | { notebook?: vscode.Uri }) =>
        runReportingErrors(() =>
          lakehousesView.unbindDefault(
            arg instanceof vscode.Uri ? arg : arg?.notebook,
          ),
        ),
    ),
    bindingStore,
    bindingStore.onDidChange(() => {
      lakehousesView.refresh();
      repoView.refresh();
      void controller.refreshHostStatus();
    }),
    vscode.commands.registerCommand(
      "fabric-connect.lakehouses.detach",
      (node: LakehouseNode) =>
        runReportingErrors(() => lakehousesView.detach(node)),
    ),
    vscode.commands.registerCommand("fabric-connect.repo.refresh", () =>
      repoView.refresh(),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.repo.run",
      (node: RepoNode) => runReportingErrors(() => repoView.run(node)),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.repo.openPlatform",
      (node: RepoNode) => runReportingErrors(() => repoView.openPlatform(node)),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.repo.editItemMetadata",
      (node: RepoNode) =>
        runReportingErrors(() => repoView.editItemMetadata(node)),
    ),
    signIn,
    signIn.onDidChange(() => {
      void computeConnection.refreshCapacityName(signIn.tenant());
      refreshExplorers();
      configurationView.refresh();
      lakehousesView.refresh();
    }),
    // Hovering a GUID anywhere names the Fabric item, workspace or capacity
    // behind it (from the explorer's listings and local .platform files).
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      {
        provideHover: async (document, position) => {
          const id = guidAt(
            document.lineAt(position.line).text,
            position.character,
          );
          if (id === undefined) {
            return undefined;
          }
          const entity = names.lookup(id, await localIndex());
          if (entity === undefined) {
            return undefined;
          }
          const text = new vscode.MarkdownString();
          text.appendText(NameCache.describe(entity));
          return new vscode.Hover(text);
        },
      },
    ),
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer, {
      transientOutputs: true,
    }),
    vscode.workspace.registerNotebookSerializer(
      NOTEBOOK_SOURCE_TYPE,
      new FabricSourceNotebookSerializer(),
      { transientOutputs: true },
    ),

    vscode.commands.registerCommand("fabric-connect.signIn", (from?: unknown) =>
      runReportingErrors(async () => {
        if (
          (await signIn.signIn()) !== undefined &&
          from === FROM_WALKTHROUGH
        ) {
          await openWalkthroughStep("connectCompute");
        }
      }),
    ),
    vscode.commands.registerCommand("fabric-connect.switchTenant", () =>
      runReportingErrors(async () => {
        await signIn.switchTenant();
      }),
    ),
    vscode.commands.registerCommand("fabric-connect.signOut", () =>
      runReportingErrors(() => signIn.signOut()),
    ),
    vscode.commands.registerCommand("fabric-connect.accountMenu", () =>
      runReportingErrors(() => signIn.showMenu()),
    ),

    vscode.commands.registerCommand("fabric-connect.openAsFabricNotebook", () =>
      runReportingErrors(async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "Fabric Notebook": ["ipynb"] },
        });
        const uri = picked?.[0];
        if (uri === undefined) {
          return;
        }
        await vscode.window.showNotebookDocument(
          await vscode.workspace.openNotebookDocument(uri),
        );
      }),
    ),

    vscode.commands.registerCommand("fabric-connect.manageLakehouses", () =>
      runReportingErrors(async () => {
        const uri = activeFabricNotebookUri();
        const notebook =
          uri === undefined ? undefined : await fabricNotebookFor(uri);
        if (notebook === undefined || !isFabricNotebook(notebook)) {
          void vscode.window.showWarningMessage(
            "Open a Fabric notebook first, then run this command to manage its lakehouses.",
          );
          return;
        }
        await lakehousePanel.show(notebook.uri);
      }),
    ),

    vscode.commands.registerCommand("fabric-connect.stopLivySession", () =>
      runReportingErrors(async () => {
        const uri = activeFabricNotebookUri();
        const notebook =
          uri === undefined ? undefined : await fabricNotebookFor(uri);
        if (notebook === undefined || !isFabricNotebook(notebook)) {
          void vscode.window.showWarningMessage(
            "Open a Fabric notebook first, then run this command to stop its Livy session.",
          );
          return;
        }
        const host = await resolveNotebookHost(
          notebook,
          targetResolver,
          compute,
          () => signIn.tenant(),
          attachmentSources,
        );
        await livyManager.stopSession(host.target);
        await stager.cleanup(host.target);
        void vscode.window.showInformationMessage(
          `Livy session on ${host.label} stopped.`,
        );
      }),
    ),

    vscode.commands.registerCommand("fabric-connect.restartLivySession", () =>
      runReportingErrors(async () => {
        const uri = activeFabricNotebookUri();
        const notebook =
          uri === undefined ? undefined : await fabricNotebookFor(uri);
        if (notebook === undefined || !isFabricNotebook(notebook)) {
          void vscode.window.showWarningMessage(
            "Open a Fabric notebook first, then run this command to restart its Livy session.",
          );
          return;
        }
        const host = await computeConnection.runWithHost(() =>
          resolveNotebookHost(
            notebook,
            targetResolver,
            compute,
            () => signIn.tenant(),
            attachmentSources,
          ),
        );
        await livyManager.stopSession(host.target);
        await stager.cleanup(host.target);
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Starting a new Livy session on ${host.label}…`,
            cancellable: true,
          },
          (_progress, token) => livyManager.startSession(host.target, token),
        );
        void vscode.window.showInformationMessage(
          `Livy session on ${host.label} restarted.`,
        );
      }),
    ),

    vscode.commands.registerCommand("fabric-connect.showLivySessions", () =>
      runReportingErrors(async () => {
        const activeUri = activeFabricNotebookUri();
        const notebook =
          activeUri === undefined
            ? undefined
            : await fabricNotebookFor(activeUri);
        const current = await compute();
        const hosted = current === undefined ? undefined : hostOf(current);
        const host =
          notebook !== undefined && isFabricNotebook(notebook)
            ? (
                await resolveNotebookHost(
                  notebook,
                  targetResolver,
                  compute,
                  () => signIn.tenant(),
                  attachmentSources,
                )
              ).target
            : hosted === undefined
              ? undefined
              : {
                  tenantId: hosted.tenantId,
                  workspaceId: hosted.workspaceId,
                  lakehouseId: hosted.lakehouseId,
                };
        if (host === undefined) {
          void vscode.window.showWarningMessage(
            "Open a Fabric notebook, or pick a host Lakehouse ('Change Host Lakehouse…' in Configuration), so there is a Lakehouse to list sessions for.",
          );
          return;
        }
        const sessions = (await listLivySessions(apiClient, host)).filter(
          (s) => s.jobType !== "SparkBatch",
        );
        const active = sessions.filter(
          (s) => s.state === "InProgress" || s.state === "NotStarted",
        );
        if (active.length === 0) {
          void vscode.window.showInformationMessage(
            `No active Livy sessions on this Lakehouse (${sessions.length} finished).`,
          );
          return;
        }
        const chosen = await vscode.window.showQuickPick(
          active.map((s) => ({
            label: s.name ?? s.itemName ?? "Livy session",
            description: s.state,
            detail: s.submittedDateTime
              ? `Submitted ${s.submittedDateTime}`
              : undefined,
            session: s,
          })),
          {
            placeHolder: "Active Livy sessions — pick one to stop it",
            canPickMany: true,
          },
        );
        if (chosen === undefined || chosen.length === 0) {
          return;
        }
        for (const item of chosen) {
          await livyManager.stopSessionById(host, item.session.livyId);
        }
        void vscode.window.showInformationMessage(
          `Stopped ${chosen.length} Livy session${chosen.length === 1 ? "" : "s"}.`,
        );
      }),
    ),

    vscode.commands.registerCommand("fabric-connect.pythonModules", () =>
      runReportingErrors(() => stager.pickMode()),
    ),

    vscode.languages.registerCodeLensProvider(
      [
        { scheme: "file", pattern: "**/*.Notebook/notebook-content.py" },
        { scheme: "file", pattern: "**/*.Notebook/notebook-content.sql" },
        { scheme: "file", pattern: "**/*.Notebook/notebook-content.scala" },
        { scheme: "file", pattern: "**/*.Notebook/notebook-content.r" },
      ],
      new NotebookCellLensProvider(),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.runNotebookCell",
      (uri: vscode.Uri, cell: number) =>
        runReportingErrors(() => codeRunner.runNotebookCells(uri, { cell })),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.runNotebookCellsAbove",
      (uri: vscode.Uri, cell: number) =>
        runReportingErrors(() =>
          codeRunner.runNotebookCells(uri, { cell, above: true }),
        ),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.runNotebookAll",
      (uri?: vscode.Uri) =>
        runReportingErrors(async () => {
          const target = uri ?? activeFabricNotebookUri();
          if (target === undefined) {
            void vscode.window.showWarningMessage(
              "Open a Fabric notebook first, then run this command to run all its cells.",
            );
            return;
          }
          await codeRunner.runNotebookCells(target, "all");
        }),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.openAsNotebook",
      (uri?: vscode.Uri) =>
        runReportingErrors(async () => {
          const target = uri ?? activeFabricNotebookUri();
          if (target === undefined) {
            void vscode.window.showWarningMessage(
              "Open a Fabric notebook's notebook-content file first, then run this command.",
            );
            return;
          }
          await vscode.commands.executeCommand(
            "vscode.openWith",
            target,
            notebookTypeOf(target),
          );
        }),
    ),
    vscode.commands.registerCommand(
      "fabric-connect.openAsText",
      (arg?: unknown) => runReportingErrors(() => openAsText(arg)),
    ),
    textDiff,
    vscode.workspace.registerTextDocumentContentProvider(
      TEXT_VIEW_SCHEME,
      textDiff,
    ),
    vscode.commands.registerCommand(
      "fabric-connect.openChangesAsText",
      (arg?: unknown) => runReportingErrors(() => textDiff.openChanges(arg)),
    ),

    vscode.commands.registerCommand(
      "fabric-connect.runFile",
      (uri?: vscode.Uri) => runReportingErrors(() => codeRunner.runFile(uri)),
    ),

    vscode.commands.registerCommand("fabric-connect.runSelection", () =>
      runReportingErrors(() => codeRunner.runSelection()),
    ),

    vscode.commands.registerCommand(
      "fabric-connect.runSparkJob",
      (uri?: vscode.Uri) =>
        runReportingErrors(() => codeRunner.runSparkJob(uri)),
    ),

    vscode.commands.registerCommand("fabric-connect.runQuery", () =>
      runReportingErrors(() => queryRunner.runActiveFile()),
    ),

    vscode.commands.registerCommand("fabric-connect.changeQueryTarget", () =>
      runReportingErrors(() => queryRunner.changeTarget()),
    ),

    ...explorerCommands(explorer, computeConnection, refreshExplorers),

    vscode.commands.registerCommand("fabric-connect.newApiNotebook", () =>
      runReportingErrors(async () => {
        const document = await vscode.workspace.openNotebookDocument(
          API_NOTEBOOK_TYPE,
          new vscode.NotebookData([
            new vscode.NotebookCellData(
              vscode.NotebookCellKind.Code,
              "%api\nGET /workspaces",
              "fabric-api",
            ),
          ]),
        );
        await vscode.window.showNotebookDocument(document);
      }),
    ),

    vscode.commands.registerCommand(
      "fabric-connect.connectCompute",
      (from?: unknown) =>
        runReportingErrors(async () => {
          if (
            (await computeConnection.connect()) &&
            from === FROM_WALKTHROUGH
          ) {
            await openWalkthroughStep("notebooks");
          }
        }),
    ),

    vscode.commands.registerCommand("fabric-connect.disconnectCompute", () =>
      runReportingErrors(() => computeConnection.disconnect()),
    ),
    vscode.commands.registerCommand("fabric-connect.changeHost", () =>
      runReportingErrors(() => computeConnection.changeHost()),
    ),
    vscode.commands.registerCommand("fabric-connect.nameCapacity", () =>
      runReportingErrors(() => computeConnection.nameCapacity()),
    ),
  );
}

export function deactivate(): void {
  // Livy sessions are intentionally left running so the next window can
  // reattach to them (see LivySessionManager.dispose).
}

/** Argument the walkthrough's links pass, so a success moves it along. */
const FROM_WALKTHROUGH = "walkthrough";
const WALKTHROUGH = "bendfeldt.fabric-connect#gettingStarted";

async function openWalkthroughStep(step: string): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openWalkthrough", {
    category: WALKTHROUGH,
    step: `${WALKTHROUGH}#${step}`,
  });
}

async function runReportingErrors(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Explorer context-menu commands; each receives the clicked tree node. The
 * nodes of every explorer view have the same shape, so one explorer runs
 * the actions for all of them.
 */
function explorerCommands(
  explorer: FabricExplorer,
  computeConnection: ComputeConnection,
  refresh: () => void,
): vscode.Disposable[] {
  type Node = Parameters<FabricExplorer["copyId"]>[0];
  const actions: Record<string, (node: Node) => Promise<void>> = {
    "explorer.copyId": (n) => explorer.copyId(n),
    "explorer.copyName": (n) => explorer.copyName(n),
    "explorer.copyOneLakePath": (n) => explorer.copyOneLakePath(n),
    "explorer.copySqlConnectionString": (n) =>
      explorer.copySqlConnectionString(n),
    "explorer.previewTable": (n) => explorer.previewTable(n),
    "explorer.previewFile": (n) => explorer.previewFile(n),
    "explorer.pullItem": (n) => explorer.pullItem(n),
    "explorer.openInFabric": (n) => explorer.openInFabric(n),
  };
  return [
    vscode.commands.registerCommand("fabric-connect.explorer.refresh", () =>
      refresh(),
    ),
    // From a capacity or workspace node; from the palette, pick one.
    vscode.commands.registerCommand(
      "fabric-connect.selectCapacity",
      (node?: Node) =>
        runReportingErrors(async () => {
          await computeConnection.selectCapacity(
            node === undefined ? undefined : await explorer.capacityOf(node),
          );
        }),
    ),
    ...Object.entries(actions).map(([id, action]) =>
      vscode.commands.registerCommand(`fabric-connect.${id}`, (node: Node) =>
        runReportingErrors(() => action(node)),
      ),
    ),
  ];
}
