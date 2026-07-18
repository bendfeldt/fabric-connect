/**
 * Execution/Output Module: the VS Code notebook controller that sends cell
 * code to the Livy Session Manager and renders results (tables, plots,
 * text, errors). Agnostic of how results were produced — it only consumes
 * LivyStatementResult.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { FabricConnectError } from "../core/errors";
import type {
  ILivySessionManager,
  LivyTarget,
} from "../core/livySessionManager";
import type { NotebookModel } from "../core/notebookCodec";
import type { ITargetResolver } from "../core/types";
import { NOTEBOOK_TYPE } from "./notebookSerializer";

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

export class FabricNotebookController implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;

  constructor(
    private readonly livy: ILivySessionManager,
    private readonly targets: ITargetResolver,
    private readonly getModel: (uri: vscode.Uri) => NotebookModel | undefined,
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
  }

  dispose(): void {
    this.controller.dispose();
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
      const target = await this.resolveLivyTarget(notebook);
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

  private async resolveLivyTarget(
    notebook: vscode.NotebookDocument,
  ): Promise<LivyTarget> {
    const folder = path.dirname(notebook.uri.fsPath);
    const resolved = await this.targets.resolveTarget(folder);
    const model = this.getModel(notebook.uri);
    const attachments = model?.getLakehouseAttachments();
    const lakehouse = attachments?.defaultLakehouse;
    if (lakehouse === undefined) {
      throw new FabricConnectError(
        "Cannot run this cell: the notebook has no default Lakehouse attached, so there is no Spark endpoint to execute against.",
        {
          operation: "execute cell",
          entity: `notebook ${path.basename(notebook.uri.fsPath)}`,
          remediation:
            "Run 'Fabric: Manage Lakehouses for Active Notebook' and attach a default Lakehouse.",
        },
      );
    }
    return {
      tenantId: resolved.tenantId,
      workspaceId: resolved.workspaceId,
      lakehouseId: lakehouse.id,
    };
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
