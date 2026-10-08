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
import {
  DefaultLakehouseUnboundError,
  FabricConnectError,
  HostLakehouseNeededError,
  LivyError,
} from "../core/errors";
import {
  ExecutionDiagnostics,
  executionFailureOutcome,
  type ExecutionOutcome,
} from "../core/executionDiagnostics";
import {
  type HostProbe,
  type LivyHost,
  diagnoseLivyHost,
  resolveLivyHost,
} from "../core/livyHost";
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
} from "./notebookSerializer";
import { type AttachmentSources, withSources } from "./lakehouseAttachments";
import { activeFabricNotebookUri, fabricNotebookFor } from "./activeNotebook";

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
  readonly diagnostics?: () => ExecutionDiagnostics;
  readonly index: () => Promise<LocalItemIndex>;
  readonly fs: RunExpansionFileSystem;
  /**
   * Python to run before Python code so `import` sees the working tree's
   * modules (undefined when nothing is configured to stage).
   */
  readonly prepare?: (target: LivyTarget) => Promise<string | undefined>;
  /**
   * A hint for a failed import whose package is also in the repo while
   * Python modules are Remote (undefined when there is nothing to add).
   */
  readonly importHint?: (
    errorName: string | undefined,
    errorValue: string | undefined,
  ) => Promise<string | undefined>;
}

/**
 * Which Lakehouse hosts a notebook's Livy session: its own default
 * Lakehouse, else the connected compute (see core/livyHost.ts).
 */
export async function resolveNotebookHost(
  notebook: vscode.NotebookDocument,
  targets: ITargetResolver,
  compute: () => Promise<ComputeProfile | undefined>,
  signedInTenant: () => string | undefined,
  /**
   * Logical IDs from the repo count as unbound defaults; this machine's
   * binding (`.fabric/local.json`) is the notebook's Lakehouse when set.
   */
  sources?: AttachmentSources,
): Promise<LivyHost> {
  const root = fabricRootOf(notebook);
  const attachments =
    root === undefined
      ? undefined
      : await withSources(notebook.uri, getLakehouseAttachments(root), sources);
  const bound = attachments?.localBinding;
  return resolveLivyHost({
    entity: `notebook ${path.basename(path.dirname(notebook.uri.fsPath))}`,
    notebookDefault:
      bound === undefined
        ? attachments?.defaultLakehouse
        : {
            id: bound.lakehouseId,
            name: bound.lakehouseName,
            workspaceId: bound.workspaceId,
          },
    unboundDefault:
      bound === undefined ? attachments?.unboundDefault : undefined,
    boundLocally: bound !== undefined,
    notebookEnvironment:
      root === undefined ? undefined : getEnvironmentAttachment(root),
    target: await targets.resolveTargetIfMapped(
      path.dirname(notebook.uri.fsPath),
    ),
    signedInTenant: signedInTenant(),
    compute: await compute(),
  });
}

/**
 * Cell outputs for a Livy result: text, then one table per `display()`,
 * with SQL results rendered as a table too.
 */
export function toCellOutputs(
  result: LivyStatementResult,
  hint?: string,
): vscode.NotebookCellOutput[] {
  if (result.status === "error") {
    // The cell's own exception: shown as the notebook's traceback,
    // exactly as the portal would show it — not an extension error.
    const error = new Error(
      `${result.errorName ?? "Error"}: ${result.errorValue ?? ""}`,
    );
    error.stack = (result.traceback ?? []).join("\n");
    const hints = [result.hint, hint].filter((value) => value !== undefined);
    return [
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.error(error),
      ]),
      ...(hints.length === 0
        ? []
        : [
            new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.text(
                hints.map((value) => `[fabric-connect] ${value}`).join("\n\n"),
                "text/plain",
              ),
            ]),
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
    /** The tenant the repo is signed in to, if any. */
    private readonly signedInTenant: () => string | undefined,
    /** Resolves, asking for a host Lakehouse first when one is needed. */
    private readonly runWithHost: <T>(resolve: () => Promise<T>) => Promise<T>,
    /** Reads the host's workspace and Lakehouse to explain a failed start. */
    private readonly probeHost: (target: LivyTarget) => Promise<HostProbe>,
    /** Logical IDs from the repo and this machine's bindings. */
    private readonly sources?: AttachmentSources,
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
      // A notebook open as text (Open as Text) too.
      vscode.window.onDidChangeActiveTextEditor(() => {
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

  /**
   * Shows, for the active Fabric notebook (in the notebook editor or as
   * text), which Lakehouse its cells run on.
   */
  async refreshHostStatus(): Promise<void> {
    const uri = activeFabricNotebookUri();
    if (uri === undefined) {
      this.hostStatus.hide();
      return;
    }
    let notebook: vscode.NotebookDocument;
    try {
      notebook = await fabricNotebookFor(uri);
    } catch (error) {
      this.hostStatus.text = "$(warning) Livy: notebook not readable";
      this.hostStatus.tooltip =
        error instanceof Error ? error.message : String(error);
      this.hostStatus.command = undefined;
      this.hostStatus.show();
      return;
    }
    this.hostStatus.command = undefined;
    try {
      const host = await resolveNotebookHost(
        notebook,
        this.targets,
        this.compute,
        this.signedInTenant,
        this.sources,
      );
      this.hostStatus.text = `$(database) Livy: ${host.label}`;
      this.hostStatus.tooltip =
        host.source === "notebook"
          ? "Cells run on the notebook's default Lakehouse; relative paths (Files/…) and unqualified tables resolve there."
          : "The notebook has no default Lakehouse, so cells run on the connected capacity's host Lakehouse; relative paths resolve there.";
    } catch (error) {
      if (error instanceof DefaultLakehouseUnboundError) {
        this.hostStatus.text = "$(warning) Livy: default Lakehouse not bound";
        this.hostStatus.tooltip = `The notebook's default Lakehouse${error.lakehouseName === undefined ? "" : ` '${error.lakehouseName}'`} has placeholder or logical IDs (as Fabric stores them in git). Click to bind it.`;
        this.hostStatus.command = {
          title: "Bind Lakehouse",
          command: "fabric-connect.bindDefaultLakehouse",
          arguments: [notebook.uri],
        };
        this.hostStatus.show();
        return;
      } else if (error instanceof HostLakehouseNeededError) {
        this.hostStatus.text = "$(database) Livy: host picked on first run";
        this.hostStatus.tooltip =
          "The notebook has no default Lakehouse and no host Lakehouse is picked for the connected capacity: running a cell asks for one. Or set a default Lakehouse in the Lakehouses view.";
      } else {
        this.hostStatus.text = "$(warning) Livy: no host";
        this.hostStatus.tooltip =
          error instanceof Error ? error.message : String(error);
      }
    }
    this.hostStatus.show();
  }

  private async executeCells(
    controller: vscode.NotebookController,
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    this.noticePurePython(notebook);
    const diagnostics = this.run.diagnostics?.() ?? new ExecutionDiagnostics();
    let outcome: ExecutionOutcome = "error";
    // Ask for a host Lakehouse once, up front, when the notebook needs one;
    // a failure here is reported by each cell below, without asking again.
    try {
      await diagnostics.measure("host.resolve", () =>
        this.runWithHost(() =>
          resolveNotebookHost(
            notebook,
            this.targets,
            this.compute,
            this.signedInTenant,
            this.sources,
          ),
        ),
      );
      outcome = "ok";
      void this.refreshHostStatus();
    } catch (error) {
      outcome = executionFailureOutcome(error);
      // Reported per cell; an unbound default also gets a one-click fix,
      // offered once per run (cell outputs cannot hold buttons).
      if (error instanceof DefaultLakehouseUnboundError) {
        void this.offerBind(notebook, error);
      }
    } finally {
      diagnostics.finish(outcome);
    }
    // The Livy manager queues per session; iterating here keeps cell order.
    for (const cell of cells) {
      await this.executeCell(controller, cell, notebook);
    }
  }

  private async offerBind(
    notebook: vscode.NotebookDocument,
    error: DefaultLakehouseUnboundError,
  ): Promise<void> {
    const bind = "Bind Lakehouse…";
    const answer = await vscode.window.showWarningMessage(
      error.lakehouseName === undefined
        ? "This notebook's default Lakehouse is not bound to a Lakehouse here."
        : `This notebook's default Lakehouse '${error.lakehouseName}' is not bound to a Lakehouse here.`,
      bind,
    );
    if (answer === bind) {
      await vscode.commands.executeCommand(
        "fabric-connect.bindDefaultLakehouse",
        notebook.uri,
      );
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
    const diagnostics = this.run.diagnostics?.() ?? new ExecutionDiagnostics();
    let outcome: ExecutionOutcome = "error";
    let host: LivyHost | undefined;
    try {
      host = await diagnostics.measure("host.resolve", () =>
        resolveNotebookHost(
          notebook,
          this.targets,
          this.compute,
          this.signedInTenant,
          this.sources,
        ),
      );
      const { target } = host;
      const entity = `cell ${cell.index + 1} of ${path.basename(path.dirname(notebook.uri.fsPath))}`;
      const { kind, code } = await diagnostics.measure(
        "code.prepare",
        async () => {
          let statement = toStatement(
            cell.document.getText(),
            cell.document.languageId,
            entity,
          );
          if (statement.kind === "pyspark" && hasRunMagic(statement.code)) {
            statement = {
              ...statement,
              code: await expandRunMagics(
                statement.code,
                await this.run.index(),
                this.run.fs,
              ),
            };
          }
          return statement;
        },
      );
      if (kind === "pyspark") {
        const prelude = await diagnostics.measure("modules.prepare", async () =>
          this.run.prepare?.(target),
        );
        if (prelude !== undefined) {
          const staged = await this.livy.execute(
            target,
            prelude,
            "pyspark",
            execution.token,
            diagnostics,
            "module-setup",
          );
          if (staged.status !== "ok") {
            outcome = staged.status;
            // Staging the working tree's modules failed: show why, don't
            // run the cell against stale or missing code.
            if (staged.status === "cancelled") {
              await diagnostics.measure("output.render", () =>
                execution.clearOutput(),
              );
              execution.end(undefined, Date.now());
            } else {
              await diagnostics.measure("output.render", () =>
                execution.replaceOutput(toCellOutputs(staged)),
              );
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
        diagnostics,
      );
      outcome = result.status;

      if (result.status === "cancelled") {
        await diagnostics.measure("output.render", () =>
          execution.clearOutput(),
        );
        execution.end(undefined, Date.now());
        return;
      }
      await diagnostics.measure("output.render", async () => {
        const hint =
          result.status === "error"
            ? await this.run.importHint?.(result.errorName, result.errorValue)
            : undefined;
        await execution.replaceOutput(toCellOutputs(result, hint));
      });
      execution.end(result.status === "ok", Date.now());
    } catch (error) {
      outcome = executionFailureOutcome(error);
      if (error instanceof LivyError && error.kind === "cancelled") {
        // Cancelled while still queued: same clean outcome as a running
        // cell that was cancelled, not a red error output.
        await diagnostics.measure("output.render", () =>
          execution.clearOutput(),
        );
        execution.end(undefined, Date.now());
        return;
      }
      const explained =
        error instanceof LivyError &&
        error.kind === "session-start" &&
        host !== undefined
          ? await this.explainSessionStart(error, host)
          : error;
      await diagnostics.measure("output.render", () =>
        execution.replaceOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.error(toDisplayError(explained)),
          ]),
        ),
      );
      execution.end(false, Date.now());
    } finally {
      diagnostics.finish(outcome);
    }
  }

  /**
   * Adds the likely cause to a failed session start, from a quick read of
   * the host's workspace and Lakehouse; the error as-is when nothing
   * specific is found.
   */
  private async explainSessionStart(
    error: LivyError,
    host: LivyHost,
  ): Promise<LivyError> {
    let diagnosis: ReturnType<typeof diagnoseLivyHost>;
    try {
      diagnosis = diagnoseLivyHost(
        await this.probeHost(host.target),
        host.source,
      );
    } catch {
      return error;
    }
    if (diagnosis === undefined) {
      return error;
    }
    return new LivyError(
      `${error.message.split(" Next step:")[0]} Likely cause: ${diagnosis.why}.`,
      {
        operation: error.operation,
        kind: error.kind,
        remediation: diagnosis.next,
        cause: error,
      },
    );
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
