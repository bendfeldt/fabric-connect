/**
 * Lakehouse Panel Module: a webview panel to browse, attach, and detach
 * lakehouses for the active notebook (multiple attachments supported).
 * Lists lakehouses via the shared Fabric API Client and writes attachments
 * into the notebook document's metadata with a WorkspaceEdit, so VS Code
 * marks the document dirty, saving persists the change through the Fidelity
 * Module, and attach/detach is undoable like any other edit.
 *
 * The panel never captures a document or model: every message looks the
 * notebook up by URI, so a panel left open across close/reopen (or revert)
 * always edits the live document — or fails loudly if it is gone.
 *
 * Webview safety: strict CSP, no remote script loading, plain vanilla JS
 * (no UI framework — Part 1's panel doesn't need one), and every value
 * from the API is HTML-escaped before rendering.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { LakehouseError } from "../core/errors";
import {
  attachLakehouse,
  detachLakehouse,
  getLakehouseAttachments,
} from "../core/notebookCodec";
import type { IFabricApiClient, ITargetResolver } from "../core/types";
import {
  NOTEBOOK_TYPE,
  fabricRootOf,
  withFabricRoot,
} from "./notebookSerializer";

interface LakehouseListResponse {
  value?: Array<{ id?: string; displayName?: string }>;
}

interface PanelContext {
  readonly notebookUri: vscode.Uri;
  readonly workspaceId: string;
  readonly tenantId: string;
}

export class LakehousePanel {
  /** One panel per notebook; repeat invocations reveal the existing one. */
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly api: IFabricApiClient,
    private readonly targets: ITargetResolver,
  ) {}

  async show(notebookUri: vscode.Uri): Promise<void> {
    const folder = path.dirname(notebookUri.fsPath);
    const resolved = await this.targets.resolveTarget(folder);
    this.findNotebook(notebookUri); // fail before opening a panel
    const context: PanelContext = {
      notebookUri,
      workspaceId: resolved.workspaceId,
      tenantId: resolved.tenantId,
    };

    const key = notebookUri.toString();
    const existing = this.panels.get(key);
    if (existing !== undefined) {
      existing.reveal();
      await this.render(existing, context);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "fabricConnect.lakehouses",
      "Fabric Lakehouses",
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] },
    );
    this.panels.set(key, panel);
    panel.onDidDispose(() => {
      this.panels.delete(key);
    });
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      await this.handleMessage(panel, context, message);
    });
    await this.render(panel, context);
  }

  /** The open Fabric notebook for this URI, or a loud, actionable error. */
  private findNotebook(uri: vscode.Uri): vscode.NotebookDocument {
    const notebook = vscode.workspace.notebookDocuments.find(
      (doc) =>
        doc.uri.toString() === uri.toString() &&
        doc.notebookType === NOTEBOOK_TYPE,
    );
    if (notebook === undefined || fabricRootOf(notebook) === undefined) {
      throw new LakehouseError(
        `Cannot manage lakehouses: notebook '${path.basename(uri.fsPath)}' is not open as a Fabric notebook.`,
        {
          operation: "open Lakehouse panel",
          entity: `notebook ${path.basename(uri.fsPath)}`,
          remediation:
            "Open the file with 'Fabric: Open File as Fabric Notebook', then retry from the panel.",
        },
      );
    }
    return notebook;
  }

  private async handleMessage(
    panel: vscode.WebviewPanel,
    context: PanelContext,
    message: unknown,
  ): Promise<void> {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const { command, id, name } = message as {
      command?: unknown;
      id?: unknown;
      name?: unknown;
    };
    const lakehouseName = typeof name === "string" ? name : undefined;
    try {
      if (command === "attach" && typeof id === "string") {
        await this.applyAttachmentEdit(context, (root) =>
          attachLakehouse(
            root,
            { id, name: lakehouseName, workspaceId: context.workspaceId },
            false,
          ),
        );
      } else if (command === "makeDefault" && typeof id === "string") {
        await this.applyAttachmentEdit(context, (root) =>
          attachLakehouse(
            root,
            { id, name: lakehouseName, workspaceId: context.workspaceId },
            true,
          ),
        );
      } else if (command === "detach" && typeof id === "string") {
        await this.applyAttachmentEdit(context, (root) =>
          detachLakehouse(root, id),
        );
      } else if (command !== "refresh") {
        return;
      }
      await this.render(panel, context);
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Applies a metadata edit to the live document, marking it dirty. */
  private async applyAttachmentEdit(
    context: PanelContext,
    update: (root: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const notebook = this.findNotebook(context.notebookUri);
    const root = fabricRootOf(notebook);
    if (root === undefined) {
      return; // findNotebook already guarantees this; keep the type narrow
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [
      vscode.NotebookEdit.updateNotebookMetadata(
        withFabricRoot(notebook.metadata, update(root)),
      ),
    ]);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new LakehouseError(
        `Failed to update lakehouse attachments: VS Code rejected the metadata edit on '${path.basename(context.notebookUri.fsPath)}'.`,
        {
          operation: "update lakehouse attachment",
          entity: `notebook ${path.basename(context.notebookUri.fsPath)}`,
          remediation: "Retry; if it persists, reopen the notebook first.",
        },
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
        method: "GET",
        path: `/workspaces/${context.workspaceId}/lakehouses`,
        tenantId: context.tenantId,
      });
      available = (response.body.value ?? [])
        .filter(
          (lh): lh is { id: string; displayName?: string } =>
            typeof lh.id === "string",
        )
        .map((lh) => ({ id: lh.id, name: lh.displayName ?? lh.id }));
    } catch (cause) {
      throw new LakehouseError(
        `Failed to list lakehouses in the target workspace.`,
        {
          operation: "list lakehouses",
          entity: "target workspace",
          remediation:
            "Check that your account has at least Viewer access to the workspace, then refresh the panel.",
          cause,
        },
      );
    }

    const root = fabricRootOf(this.findNotebook(context.notebookUri));
    const attachments = getLakehouseAttachments(root ?? {});
    const attachedIds = new Set(attachments.known.map((k) => k.id));
    const defaultId = attachments.defaultLakehouse?.id;

    const rows = available
      .map((lh) => {
        const attached = attachedIds.has(lh.id) || lh.id === defaultId;
        const isDefault = lh.id === defaultId;
        const name = escapeHtml(lh.name);
        const id = escapeHtml(lh.id);
        const badge = isDefault ? ' <span class="badge">default</span>' : "";
        const actions = attached
          ? `<button data-cmd="detach" data-id="${id}">Detach</button>` +
            (isDefault
              ? ""
              : ` <button data-cmd="makeDefault" data-id="${id}" data-name="${name}">Make default</button>`)
          : `<button data-cmd="attach" data-id="${id}" data-name="${name}">Attach</button>`;
        return `<li><span class="name">${name}</span>${badge}<span class="actions">${actions}</span></li>`;
      })
      .join("\n");

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
<ul>${rows.length > 0 ? rows : "<li>No lakehouses found in this workspace.</li>"}</ul>
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
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}
