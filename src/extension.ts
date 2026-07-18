/**
 * Composition root. Plain, readable constructor calls — no DI container,
 * no decorators, no reflection. A request can be traced from "cell run"
 * to "Livy call" by reading this file top to bottom.
 *
 * Activation is lazy: VS Code activates the extension only when a Fabric
 * notebook is opened (contributes.notebooks) or one of our commands runs,
 * never unconditionally on startup.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FABRIC_SCOPES } from './core/constants';
import { FabricApiClient } from './core/fabricApiClient';
import { LivySessionManager } from './core/livySessionManager';
import { NotebookCodec } from './core/notebookCodec';
import { TargetResolver } from './core/targetResolver';
import { EntraAuthProvider } from './vscode/authProvider';
import { LakehousePanel } from './vscode/lakehousePanel';
import { FabricNotebookController } from './vscode/notebookController';
import {
  FabricNotebookSerializer,
  NOTEBOOK_TYPE,
} from './vscode/notebookSerializer';

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const output = vscode.window.createOutputChannel('Fabric Connect');
  const logger = {
    debug(message: string): void {
      if (
        vscode.workspace
          .getConfiguration('fabric-connect')
          .get<boolean>('debugLogging', false)
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
          return await fs.readFile(filePath, 'utf8');
        } catch {
          return undefined;
        }
      },
    },
    workspaceRoot ?? '',
  );
  // Part 1 registers only 'notebook'; Part 2 adds 'pipeline' here without
  // touching the Target Config Module.
  targetResolver.registerItemType('notebook', { itemType: 'notebook' });

  const livyManager = new LivySessionManager(apiClient, {
    get: (key) => context.workspaceState.get<string>(key),
    set: (key, value) => {
      void context.workspaceState.update(key, value);
    },
  });

  const codec = new NotebookCodec();
  const serializer = new FabricNotebookSerializer(codec);
  const controller = new FabricNotebookController(livyManager, targetResolver, (uri) =>
    serializer.getModel(uri),
  );
  const lakehousePanel = new LakehousePanel(
    apiClient,
    targetResolver,
    (uri) => serializer.getModel(uri),
    (uri) => serializer.markDirty(uri),
  );

  context.subscriptions.push(
    output,
    controller,
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer, {
      transientOutputs: true,
    }),
    vscode.workspace.onDidOpenNotebookDocument((doc) => {
      if (doc.notebookType === NOTEBOOK_TYPE) {
        serializer.associate(doc.uri);
      }
    }),
    vscode.workspace.onDidCloseNotebookDocument((doc) => {
      serializer.handleDocumentClosed(doc.uri);
    }),
    vscode.window.onDidChangeActiveNotebookEditor((editor) => {
      if (editor?.notebook.notebookType === NOTEBOOK_TYPE) {
        serializer.setActiveModel(editor.notebook.uri);
      }
    }),

    vscode.commands.registerCommand('fabric-connect.signIn', () =>
      runReportingErrors(async () => {
        const tenantId = await promptTenantId(context);
        if (tenantId === undefined) {
          return;
        }
        await auth.getToken(tenantId, FABRIC_SCOPES);
        void vscode.window.showInformationMessage(
          `Signed in to tenant ${tenantId}.`,
        );
      }),
    ),

    vscode.commands.registerCommand('fabric-connect.openAsFabricNotebook', () =>
      runReportingErrors(async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'Fabric Notebook': ['ipynb'] },
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

    vscode.commands.registerCommand('fabric-connect.manageLakehouses', () =>
      runReportingErrors(async () => {
        const notebook = vscode.window.activeNotebookEditor?.notebook;
        if (notebook === undefined || notebook.notebookType !== NOTEBOOK_TYPE) {
          void vscode.window.showWarningMessage(
            'Open a Fabric notebook first, then run this command to manage its lakehouses.',
          );
          return;
        }
        await lakehousePanel.show(notebook.uri);
      }),
    ),

    vscode.commands.registerCommand('fabric-connect.stopLivySession', () =>
      runReportingErrors(async () => {
        const notebook = vscode.window.activeNotebookEditor?.notebook;
        if (notebook === undefined || notebook.notebookType !== NOTEBOOK_TYPE) {
          void vscode.window.showWarningMessage(
            'Open a Fabric notebook first, then run this command to stop its Livy session.',
          );
          return;
        }
        const folder = path.dirname(notebook.uri.fsPath);
        const resolved = await targetResolver.resolveTarget(folder);
        const model = serializer.getModel(notebook.uri);
        const lakehouse = model?.getLakehouseAttachments().defaultLakehouse;
        if (lakehouse === undefined) {
          void vscode.window.showInformationMessage(
            'This notebook has no default Lakehouse, so it has no Livy session to stop.',
          );
          return;
        }
        await livyManager.stopSession({
          tenantId: resolved.tenantId,
          workspaceId: resolved.workspaceId,
          lakehouseId: lakehouse.id,
        });
        void vscode.window.showInformationMessage('Livy session stopped.');
      }),
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

const LAST_TENANT_KEY = 'fabric-connect.lastTenantId';

async function promptTenantId(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const tenantId = await vscode.window.showInputBox({
    prompt: 'Entra tenant ID (GUID) to sign in to',
    value: context.globalState.get<string>(LAST_TENANT_KEY),
    validateInput: (value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? undefined
        : 'Enter a tenant GUID, e.g. 00000000-0000-0000-0000-000000000000',
  });
  if (tenantId !== undefined) {
    await context.globalState.update(LAST_TENANT_KEY, tenantId);
  }
  return tenantId;
}
