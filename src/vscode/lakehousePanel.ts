/**
 * Lakehouse Panel Module: a webview panel to browse, attach, and detach
 * lakehouses for the active notebook (multiple attachments supported).
 * Lists lakehouses via the shared Fabric API Client and writes attachments
 * into the notebook's metadata through the Fidelity Module's model.
 *
 * Webview safety: strict CSP, no remote script loading, plain vanilla JS
 * (no UI framework — Part 1's panel doesn't need one), and every value
 * from the API is HTML-escaped before rendering.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { LakehouseError } from '../core/errors';
import type { NotebookModel } from '../core/notebookCodec';
import type { IFabricApiClient, ITargetResolver } from '../core/types';

interface LakehouseListResponse {
  value?: Array<{ id?: string; displayName?: string }>;
}

interface PanelContext {
  readonly notebookUri: vscode.Uri;
  readonly workspaceId: string;
  readonly tenantId: string;
  readonly model: NotebookModel;
}

export class LakehousePanel {
  constructor(
    private readonly api: IFabricApiClient,
    private readonly targets: ITargetResolver,
    private readonly getModel: (uri: vscode.Uri) => NotebookModel | undefined,
    private readonly onModelChanged: (uri: vscode.Uri) => void,
  ) {}

  async show(notebookUri: vscode.Uri): Promise<void> {
    const folder = path.dirname(notebookUri.fsPath);
    const resolved = await this.targets.resolveTarget(folder);
    const model = this.getModel(notebookUri);
    if (model === undefined) {
      throw new LakehouseError(
        `Cannot manage lakehouses: notebook '${path.basename(notebookUri.fsPath)}' is not open as a Fabric notebook.`,
        {
          operation: 'open Lakehouse panel',
          entity: `notebook ${path.basename(notebookUri.fsPath)}`,
          remediation:
            "Open the file with 'Fabric: Open File as Fabric Notebook' first.",
        },
      );
    }
    const context: PanelContext = {
      notebookUri,
      workspaceId: resolved.workspaceId,
      tenantId: resolved.tenantId,
      model,
    };

    const panel = vscode.window.createWebviewPanel(
      'fabricConnect.lakehouses',
      'Fabric Lakehouses',
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] },
    );
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      await this.handleMessage(panel, context, message);
    });
    await this.render(panel, context);
  }

  private async handleMessage(
    panel: vscode.WebviewPanel,
    context: PanelContext,
    message: unknown,
  ): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const { command, id, name } = message as {
      command?: string;
      id?: string;
      name?: string;
    };
    try {
      if (command === 'attach' && typeof id === 'string') {
        context.model.attachLakehouse(
          { id, name, workspaceId: context.workspaceId },
          false,
        );
      } else if (command === 'makeDefault' && typeof id === 'string') {
        context.model.attachLakehouse(
          { id, name, workspaceId: context.workspaceId },
          true,
        );
      } else if (command === 'detach' && typeof id === 'string') {
        context.model.detachLakehouse(id);
      } else if (command !== 'refresh') {
        return;
      }
      this.onModelChanged(context.notebookUri);
      await this.render(panel, context);
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async render(
    panel: vscode.WebviewPanel,
    context: PanelContext,
  ): Promise<void> {
    let available: Array<{ id: string; name: string }>;
    try {
      const response = await this.api.request<LakehouseListResponse>({
        method: 'GET',
        path: `/workspaces/${context.workspaceId}/lakehouses`,
        tenantId: context.tenantId,
      });
      available = (response.body.value ?? [])
        .filter((lh): lh is { id: string; displayName?: string } => typeof lh.id === 'string')
        .map((lh) => ({ id: lh.id, name: lh.displayName ?? lh.id }));
    } catch (cause) {
      throw new LakehouseError(
        `Failed to list lakehouses in the target workspace.`,
        {
          operation: 'list lakehouses',
          entity: 'target workspace',
          remediation:
            'Check that your account has at least Viewer access to the workspace, then refresh the panel.',
          cause,
        },
      );
    }

    const attachments = context.model.getLakehouseAttachments();
    const attachedIds = new Set(attachments.known.map((k) => k.id));
    const defaultId = attachments.defaultLakehouse?.id;

    const rows = available
      .map((lh) => {
        const attached = attachedIds.has(lh.id) || lh.id === defaultId;
        const isDefault = lh.id === defaultId;
        const name = escapeHtml(lh.name);
        const id = escapeHtml(lh.id);
        const badge = isDefault ? ' <span class="badge">default</span>' : '';
        const actions = attached
          ? `<button data-cmd="detach" data-id="${id}">Detach</button>` +
            (isDefault
              ? ''
              : ` <button data-cmd="makeDefault" data-id="${id}" data-name="${name}">Make default</button>`)
          : `<button data-cmd="attach" data-id="${id}" data-name="${name}">Attach</button>`;
        return `<li><span class="name">${name}</span>${badge}<span class="actions">${actions}</span></li>`;
      })
      .join('\n');

    const nonce = createNonce();
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); padding: 0.5rem 1rem; }
  ul { list-style: none; padding: 0; }
  li { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0; }
  .name { flex: 1; }
  .badge { font-size: 0.8em; opacity: 0.7; border: 1px solid currentColor; border-radius: 3px; padding: 0 0.3em; }
  button { cursor: pointer; }
</style>
</head>
<body>
<h3>Lakehouses in target workspace</h3>
<ul>${rows.length > 0 ? rows : '<li>No lakehouses found in this workspace.</li>'}</ul>
<button data-cmd="refresh">Refresh</button>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) { return; }
    vscodeApi.postMessage({
      command: target.dataset.cmd,
      id: target.dataset.id,
      name: target.dataset.name,
    });
  });
</script>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
