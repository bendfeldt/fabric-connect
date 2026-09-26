/**
 * Execution/Output Module: the VS Code notebook controller that sends cell
 * code to the Livy Session Manager and renders results (tables, plots,
 * text, errors). Agnostic of how results were produced — it only consumes
 * LivyStatementResult.
 *
 * Before a cell is sent, local `%run` lines are expanded from notebooks in
 * the working tree and a leading cell magic (`%%sql`, …) picks the Livy
 * statement kind. `display()` payloads and Livy SQL results come back as
 * tables.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { toStatement, SUPPORTED_LANGUAGES } from "../core/cellCode";
import type { ComputeProfile } from "../core/computeProfile";
import {
  extractDisplays,
  livySqlResultToTable,
  renderTableHtml,
} from "../core/displayProtocol";
import { FabricConnectError, LivyError } from "../core/errors";
import { type LivyHost, resolveLivyHost } from "../core/livyHost";
import type {
  ILivySessionManager,
  LivyStatementResult,
  LivyTarget,
} from "../core/livySessionManager";
import type { LocalItemIndex } from "../core/localItemIndex";
import {
  getEnvironmentAttachment,
  getLakehouseAttachments,
} from "../core/notebookCodec";
import {
  type RunExpansionFileSystem,
  expandRunMagics,
  hasRunMagic,
} from "../core/runExpansion";
import type { ITargetResolver } from "../core/types";
import {
  NOTEBOOK_SOURCE_TYPE,
  NOTEBOOK_TYPE,
  fabricRootOf,
  isFabricNotebook,
} from "./notebookSerializer";

const RENDERABLE_MIME_TYPES = new Set([
  "text/plain",
  "text/html",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "application/json",
]);

/** Where local `%run` finds other notebooks, and how local modules are staged. */
export interface RunContext {
  readonly index: () => Promise<LocalItemIndex>;
  readonly fs: RunExpansionFileSystem;
  /**
   * Python to run before Python code so `import` sees the working tree's
   * modules (undefined when nothing is configured to stage).
   */
  readonly prepare?: (target: LivyTarget) => Promise<string | undefined>;
}

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
    entity: `notebook ${path.basename(path.dirname(notebook.uri.fsPath))}`,
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

/**
 * Cell outputs for a Livy result: text, then one table per `display()`,
 * with SQL results rendered as a table too.
 */
export function toCellOutputs(
  result: LivyStatementResult,
): vscode.NotebookCellOutput[] {
  if (result.status === "error") {
    // The cell's own exception: shown as the notebook's traceback,
    // exactly as the portal would show it — not an extension error.
    const error = new Error(
      `${result.errorName ?? "Error"}: ${result.errorValue ?? ""}`,
    );
    error.stack = (result.traceback ?? []).join("\n");
    return [
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.error(error),
      ]),
    ];
  }
  const data = { ...(result.data ?? {}) };
  const outputs: vscode.NotebookCellOutput[] = [];

  const plain = data["text/plain"];
  if (typeof plain === "string") {
    const { text, tables } = extractDisplays(plain);
    if (tables.length > 0) {
      delete data["text/plain"];
      if (text.trim().length > 0) {
        outputs.push(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(text, "text/plain"),
          ]),
        );
      }
      for (const table of tables) {
        outputs.push(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text(
              renderTableHtml(table),
              "text/html",
            ),
          ]),
        );
      }
    }
  }
  const sqlTable = livySqlResultToTable(data["application/json"]);
  if (sqlTable !== undefined) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          renderTableHtml(sqlTable),
          "text/html",
        ),
        vscode.NotebookCellOutputItem.json(data["application/json"]),
      ]),
    );
    delete data["application/json"];
  }

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
  if (items.length > 0) {
    outputs.unshift(new vscode.NotebookCellOutput(items));
  }
  if (outputs.length === 0) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text("", "text/plain"),
      ]),
    );
  }
  return outputs;
}

export class FabricNotebookController implements vscode.Disposable {
  private readonly controllers: vscode.NotebookController[];
  private readonly hostStatus: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Pure-Python notebooks already told they run on a Spark session. */
  private readonly pythonNoticeShown = new Set<string>();
  private executionOrder = 0;

  constructor(
    private readonly livy: ILivySessionManager,
    private readonly targets: ITargetResolver,
    private readonly compute: () => Promise<ComputeProfile | undefined>,
    private readonly run: RunContext,
  ) {
    this.controllers = [NOTEBOOK_TYPE, NOTEBOOK_SOURCE_TYPE].map((type) => {
      const controller = vscode.notebooks.createNotebookController(
        `fabric-connect-livy-${type}`,
        type,
        "Fabric Livy",
      );
      controller.supportedLanguages = [...SUPPORTED_LANGUAGES];
      controller.supportsExecutionOrder = true;
      controller.executeHandler = (cells, notebook) =>
        this.executeCells(controller, cells, notebook);
      return controller;
    });

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
    for (const controller of this.controllers) {
      controller.dispose();
    }
    this.hostStatus.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  /** Shows, for the active Fabric notebook, which Lakehouse its cells run on. */
  async refreshHostStatus(): Promise<void> {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    if (notebook === undefined || !isFabricNotebook(notebook)) {
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
    controller: vscode.NotebookController,
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    this.noticePurePython(notebook);
    // The Livy manager queues per session; iterating here keeps cell order.
    for (const cell of cells) {
      await this.executeCell(controller, cell, notebook);
    }
  }

  private async executeCell(
    controller: vscode.NotebookController,
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    const execution = controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    try {
      const { target } = await resolveNotebookHost(
        notebook,
        this.targets,
        this.compute,
      );
      const entity = `cell ${cell.index + 1} of ${path.basename(path.dirname(notebook.uri.fsPath))}`;
      let { kind, code } = toStatement(
        cell.document.getText(),
        cell.document.languageId,
        entity,
      );
      if (kind === "pyspark" && hasRunMagic(code)) {
        code = await expandRunMagics(code, await this.run.index(), this.run.fs);
      }
      if (kind === "pyspark") {
        const prelude = await this.run.prepare?.(target);
        if (prelude !== undefined) {
          const staged = await this.livy.execute(
            target,
            prelude,
            "pyspark",
            execution.token,
          );
          if (staged.status !== "ok") {
            // Staging the working tree's modules failed: show why, don't
            // run the cell against stale or missing code.
            if (staged.status === "cancelled") {
              await execution.clearOutput();
              execution.end(undefined, Date.now());
            } else {
              await execution.replaceOutput(toCellOutputs(staged));
              execution.end(false, Date.now());
            }
            return;
          }
        }
      }
      const result = await this.livy.execute(
        target,
        code,
        kind,
        execution.token,
      );

      if (result.status === "cancelled") {
        await execution.clearOutput();
        execution.end(undefined, Date.now());
        return;
      }
      await execution.replaceOutput(toCellOutputs(result));
      execution.end(result.status === "ok", Date.now());
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

  /**
   * Fabric's pure-Python notebooks (no Spark) have no Livy equivalent; they
   * run on a Spark session instead (decision D4). Say so once per notebook.
   */
  private noticePurePython(notebook: vscode.NotebookDocument): void {
    const key = notebook.uri.toString();
    if (this.pythonNoticeShown.has(key) || !isPurePythonNotebook(notebook)) {
      return;
    }
    this.pythonNoticeShown.add(key);
    void vscode.window.showInformationMessage(
      "This is a Fabric Python (non-Spark) notebook. Fabric Connect runs it on a Spark session over Livy, so the runtime can differ slightly from Fabric's Python-only runtime (e.g. preinstalled libraries).",
    );
  }
}

function isPurePythonNotebook(notebook: vscode.NotebookDocument): boolean {
  const root = fabricRootOf(notebook);
  const metadata = root?.["metadata"];
  if (typeof metadata !== "object" || metadata === null) {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  const names = [record["kernel_info"], record["kernelspec"]].map((k) =>
    typeof k === "object" && k !== null
      ? (k as Record<string, unknown>)["name"]
      : undefined,
  );
  return names.some((name) => name === "jupyter" || name === "jupyter_python");
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
