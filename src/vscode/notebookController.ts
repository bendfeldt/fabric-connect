/**
 * Execution/Output Module: the VS Code notebook controller that sends cell
 * code to the Livy Session Manager and renders results (tables, plots,
 * text, errors). Agnostic of how results were produced — it only consumes
 * LivyStatementResult.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { ComputeProfile } from "../core/computeProfile";
import { FabricConnectError, LivyError } from "../core/errors";
import { type LivyHost, resolveLivyHost } from "../core/livyHost";
import type { ILivySessionManager } from "../core/livySessionManager";
import {
  getEnvironmentAttachment,
  getLakehouseAttachments,
} from "../core/notebookCodec";
import type { ITargetResolver } from "../core/types";
import { NOTEBOOK_TYPE, fabricRootOf } from "./notebookSerializer";

const RENDERABLE_MIME_TYPES = new Set([
  "text/plain",
  "text/html",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "application/json",
]);

const LANGUAGE_TO_LIVY_KIND: Record<string, string> = {
  python: "pyspark",
  scala: "spark",
  sql: "sql",
  r: "sparkr",
};

/**
 * Which Lakehouse hosts a notebook's Livy session: its own default
 * Lakehouse, else the connected compute (see core/livyHost.ts).
 */
export async function resolveNotebookHost(
  notebook: vscode.NotebookDocument,
  targets: ITargetResolver,
  compute: () => Promise<ComputeProfile | undefined>,
): Promise<LivyHost> {
  const root = fabricRootOf(notebook);
  return resolveLivyHost({
    entity: `notebook ${path.basename(notebook.uri.fsPath)}`,
    notebookDefault:
      root === undefined
        ? undefined
        : getLakehouseAttachments(root).defaultLakehouse,
    notebookEnvironment:
      root === undefined ? undefined : getEnvironmentAttachment(root),
    target: await targets.resolveTargetIfMapped(
      path.dirname(notebook.uri.fsPath),
    ),
    compute: await compute(),
  });
}

export class FabricNotebookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private readonly hostStatus: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly livy: ILivySessionManager,
    private readonly targets: ITargetResolver,
    private readonly compute: () => Promise<ComputeProfile | undefined>,
  ) {
    this.controller = vscode.notebooks.createNotebookController(
      "fabric-connect-livy",
      NOTEBOOK_TYPE,
      "Fabric Livy",
    );
    this.controller.supportedLanguages = Object.keys(LANGUAGE_TO_LIVY_KIND);
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) =>
      this.executeCells(cells, notebook);

    this.hostStatus = vscode.window.createStatusBarItem(
      "fabric-connect.livyHost",
      vscode.StatusBarAlignment.Left,
      49,
    );
    this.hostStatus.name = "Fabric Livy Host";
    this.subscriptions.push(
      vscode.window.onDidChangeActiveNotebookEditor(() => {
        void this.refreshHostStatus();
      }),
      vscode.workspace.onDidChangeNotebookDocument((event) => {
        if (event.metadata !== undefined) {
          void this.refreshHostStatus();
        }
      }),
    );
    void this.refreshHostStatus();
  }

  dispose(): void {
    this.controller.dispose();
    this.hostStatus.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  /** Shows, for the active Fabric notebook, which Lakehouse its cells run on. */
  async refreshHostStatus(): Promise<void> {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    if (notebook === undefined || notebook.notebookType !== NOTEBOOK_TYPE) {
      this.hostStatus.hide();
      return;
    }
    try {
      const host = await resolveNotebookHost(
        notebook,
        this.targets,
        this.compute,
      );
      this.hostStatus.text = `$(database) Livy: ${host.label}`;
      this.hostStatus.tooltip =
        host.source === "notebook"
          ? "Cells run on the notebook's default Lakehouse; relative paths (Files/…) and unqualified tables resolve there."
          : "The notebook has no default Lakehouse, so cells run on the connected compute's Lakehouse; relative paths resolve there.";
    } catch (error) {
      this.hostStatus.text = "$(warning) Livy: no host";
      this.hostStatus.tooltip =
        error instanceof Error ? error.message : String(error);
    }
    this.hostStatus.show();
  }

  private async executeCells(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    // The Livy manager queues per session; iterating here keeps cell order.
    for (const cell of cells) {
      await this.executeCell(cell, notebook);
    }
  }

  private async executeCell(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    try {
      const { target } = await resolveNotebookHost(
        notebook,
        this.targets,
        this.compute,
      );
      const kind = LANGUAGE_TO_LIVY_KIND[cell.document.languageId] ?? "pyspark";
      const result = await this.livy.execute(
        target,
        cell.document.getText(),
        kind,
        execution.token,
      );

      if (result.status === "cancelled") {
        await execution.clearOutput();
        execution.end(undefined, Date.now());
        return;
      }
      if (result.status === "error") {
        // The cell's own exception: shown as the notebook's traceback,
        // exactly as the portal would show it — not an extension error.
        const error = new Error(
          `${result.errorName ?? "Error"}: ${result.errorValue ?? ""}`,
        );
        error.stack = (result.traceback ?? []).join("\n");
        await execution.replaceOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.error(error),
          ]),
        );
        execution.end(false, Date.now());
        return;
      }

      await execution.replaceOutput(this.renderData(result.data ?? {}));
      execution.end(true, Date.now());
    } catch (error) {
      if (error instanceof LivyError && error.kind === "cancelled") {
        // Cancelled while still queued: same clean outcome as a running
        // cell that was cancelled, not a red error output.
        await execution.clearOutput();
        execution.end(undefined, Date.now());
        return;
      }
      await execution.replaceOutput(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error(toDisplayError(error)),
        ]),
      );
      execution.end(false, Date.now());
    }
  }

  private renderData(data: Record<string, unknown>): vscode.NotebookCellOutput {
    const items: vscode.NotebookCellOutputItem[] = [];
    for (const [mime, value] of Object.entries(data)) {
      if (!RENDERABLE_MIME_TYPES.has(mime)) {
        // Unsupported MIME type: degrade gracefully with an inline warning
        // on this one output — never fail the whole notebook's rendering.
        items.push(
          vscode.NotebookCellOutputItem.text(
            `[fabric-connect] Output of type '${mime}' is not supported yet and was not rendered.`,
            "text/plain",
          ),
        );
        continue;
      }
      if (mime === "image/png" || mime === "image/jpeg") {
        items.push(
          new vscode.NotebookCellOutputItem(
            Buffer.from(String(value), "base64"),
            mime,
          ),
        );
      } else if (mime === "application/json") {
        items.push(vscode.NotebookCellOutputItem.json(value, mime));
      } else {
        items.push(vscode.NotebookCellOutputItem.text(String(value), mime));
      }
    }
    if (items.length === 0) {
      items.push(vscode.NotebookCellOutputItem.text("", "text/plain"));
    }
    return new vscode.NotebookCellOutput(items);
  }

  private executionOrder = 0;
}

function toDisplayError(error: unknown): Error {
  if (error instanceof FabricConnectError) {
    return error;
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
