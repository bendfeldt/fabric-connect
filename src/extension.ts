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
import * as vscode from "vscode";
import { FABRIC_SCOPES } from "./core/constants";
import { FabricApiClient } from "./core/fabricApiClient";
import { DISPLAY_BOOTSTRAP_CODE } from "./core/displayProtocol";
import {
  LivySessionManager,
  listLivySessions,
} from "./core/livySessionManager";
import { LocalItemIndex } from "./core/localItemIndex";
import { NameCache, guidAt } from "./core/nameCache";
import { OneLakeClient } from "./core/oneLakeClient";
import { TargetResolver } from "./core/targetResolver";
import { EntraAuthProvider } from "./vscode/authProvider";
import {
  API_NOTEBOOK_TYPE,
  ApiNotebookController,
  ApiNotebookSerializer,
} from "./vscode/apiNotebookController";
import { CodeRunner } from "./vscode/codeRunner";
import { FabricExplorer } from "./vscode/explorer";
import { ComputeConnection } from "./vscode/computeConnection";
import { LakehousePanel } from "./vscode/lakehousePanel";
import { ModuleStager } from "./vscode/moduleStager";
import { QueryRunner } from "./vscode/queryRunner";
import { ResultsPanel } from "./vscode/resultsPanel";
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
  // Items in this working tree, from their .platform files (rebuilt on use,
  // so newly pulled or renamed notebooks are always seen).
  const localIndex = () =>
    LocalItemIndex.build({
      findPlatformFiles: async () =>
        (
          await vscode.workspace.findFiles("**/.platform", "**/node_modules/**")
        ).map((uri) => uri.fsPath),
      readFile,
    });

  const computeConnection = new ComputeConnection(
    apiClient,
    workspaceRoot,
    () => promptTenantId(context),
  );
  const compute = () => computeConnection.current();

  const oneLake = new OneLakeClient(auth);
  const stager = new ModuleStager(oneLake, workspaceRoot);
  const runContext = {
    index: localIndex,
    fs: { readFile },
    prepare: (target: Parameters<ModuleStager["prepare"]>[0]) =>
      stager.prepare(target),
  };

  const serializer = new FabricNotebookSerializer();
  const controller = new FabricNotebookController(
    livyManager,
    targetResolver,
    compute,
    runContext,
  );
  const resultsPanel = new ResultsPanel();
  const queryRunner = new QueryRunner(
    apiClient,
    workspaceRoot,
    compute,
    () => promptTenantId(context),
    resultsPanel,
  );
  const names = new NameCache();
  const explorer = new FabricExplorer(
    apiClient,
    oneLake,
    livyManager,
    compute,
    () => context.globalState.get<string>(LAST_TENANT_KEY),
    names,
    resultsPanel,
    workspaceRoot,
  );
  const codeRunner = new CodeRunner(
    apiClient,
    livyManager,
    targetResolver,
    compute,
    runContext,
    stager,
  );
  const lakehousePanel = new LakehousePanel(apiClient, targetResolver, compute);

  void computeConnection.refreshStatus();

  context.subscriptions.push(
    output,
    computeConnection,
    computeConnection.onDidChange(() => {
      void controller.refreshHostStatus();
    }),
    controller,
    codeRunner,
    resultsPanel,
    vscode.workspace.registerNotebookSerializer(
      API_NOTEBOOK_TYPE,
      new ApiNotebookSerializer(),
      { transientOutputs: true },
    ),
    new ApiNotebookController(
      apiClient,
      async () =>
        (await compute())?.tenantId ??
        context.globalState.get<string>(LAST_TENANT_KEY),
    ),
    explorer,
    vscode.window.registerTreeDataProvider("fabricConnect.explorer", explorer),
    computeConnection.onDidChange(() => explorer.refresh()),
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

    vscode.commands.registerCommand("fabric-connect.signIn", () =>
      runReportingErrors(async () => {
        const tenantId = await promptTenantId(context);
        if (tenantId === undefined) {
          return;
        }
        await auth.getToken(tenantId, FABRIC_SCOPES);
        explorer.refresh();
        void vscode.window.showInformationMessage(
          `Signed in to tenant ${tenantId}.`,
        );
      }),
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
        const notebook = vscode.window.activeNotebookEditor?.notebook;
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
        const notebook = vscode.window.activeNotebookEditor?.notebook;
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
        const notebook = vscode.window.activeNotebookEditor?.notebook;
        if (notebook === undefined || !isFabricNotebook(notebook)) {
          void vscode.window.showWarningMessage(
            "Open a Fabric notebook first, then run this command to restart its Livy session.",
          );
          return;
        }
        const host = await resolveNotebookHost(
          notebook,
          targetResolver,
          compute,
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
        const notebook = vscode.window.activeNotebookEditor?.notebook;
        const current = await compute();
        const host =
          notebook !== undefined && isFabricNotebook(notebook)
            ? (await resolveNotebookHost(notebook, targetResolver, compute))
                .target
            : current === undefined
              ? undefined
              : {
                  tenantId: current.tenantId,
                  workspaceId: current.workspaceId,
                  lakehouseId: current.lakehouseId,
                };
        if (host === undefined) {
          void vscode.window.showWarningMessage(
            "Open a Fabric notebook or run 'Fabric: Connect to Compute' first, so there is a Lakehouse to list sessions for.",
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

    ...explorerCommands(explorer),

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

    vscode.commands.registerCommand("fabric-connect.connectCompute", () =>
      runReportingErrors(() => computeConnection.connect()),
    ),

    vscode.commands.registerCommand("fabric-connect.disconnectCompute", () =>
      runReportingErrors(() => computeConnection.disconnect()),
    ),
  );
}

export function deactivate(): void {
  // Livy sessions are intentionally left running so the next window can
  // reattach to them (see LivySessionManager.dispose).
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

const LAST_TENANT_KEY = "fabric-connect.lastTenantId";

async function promptTenantId(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const tenantId = await vscode.window.showInputBox({
    prompt: "Entra tenant ID (GUID) to sign in to",
    value: context.globalState.get<string>(LAST_TENANT_KEY),
    validateInput: (value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
        ? undefined
        : "Enter a tenant GUID, e.g. 00000000-0000-0000-0000-000000000000",
  });
  if (tenantId !== undefined) {
    await context.globalState.update(LAST_TENANT_KEY, tenantId);
  }
  return tenantId;
}

/** Explorer context-menu commands; each receives the clicked tree node. */
function explorerCommands(explorer: FabricExplorer): vscode.Disposable[] {
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
      explorer.refresh(),
    ),
    ...Object.entries(actions).map(([id, action]) =>
      vscode.commands.registerCommand(`fabric-connect.${id}`, (node: Node) =>
        runReportingErrors(() => action(node)),
      ),
    ),
  ];
}
