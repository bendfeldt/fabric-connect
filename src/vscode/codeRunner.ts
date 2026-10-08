/**
 * Run a file, a selection, a notebook's cells (from its text file), or a
 * Spark Job Definition from the working tree on the connected compute —
 * the Databricks Connect workflow: edit locally, run remotely, see the
 * result in the editor. Output goes to the "Fabric Connect: Run" output
 * channel (tables rendered as text); notebook cells also show their tables
 * in the Fabric Results panel.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { toStatement } from "../core/cellCode";
import type { ComputeProfile } from "../core/computeProfile";
import {
  type DisplayTable,
  extractDisplays,
  livySqlResultToTable,
  renderTableText,
} from "../core/displayProtocol";
import { FabricConnectError, LivyError } from "../core/errors";
import { type LivyHost, resolveLivyHost } from "../core/livyHost";
import { boundId } from "../core/notebookCodec";
import type {
  ILivySessionManager,
  LivyStatementResult,
} from "../core/livySessionManager";
import { sourceCellRanges } from "../core/notebookSourceCodec";
import { expandRunMagics, hasRunMagic } from "../core/runExpansion";
import {
  SJD_SETTINGS_FILE,
  buildBatchRequest,
  locateJobFiles,
  parseSparkJobSettings,
  runBatch,
} from "../core/sparkJob";
import type {
  CancelToken,
  IFabricApiClient,
  ITargetResolver,
} from "../core/types";
import type { ModuleStager } from "./moduleStager";
import type { RunContext } from "./notebookController";
import type { ResultsPanel } from "./resultsPanel";

const RUNNABLE_LANGUAGES = new Set(["python", "sql", "scala", "r"]);

export class CodeRunner implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel(
    "Fabric Connect: Run",
  );

  constructor(
    private readonly api: IFabricApiClient,
    private readonly livy: ILivySessionManager,
    private readonly targets: ITargetResolver,
    private readonly compute: () => Promise<ComputeProfile | undefined>,
    private readonly run: RunContext,
    private readonly stager: ModuleStager,
    /** The tenant the repo is signed in to, if any. */
    private readonly signedInTenant: () => string | undefined,
    /** Resolves, asking for a host Lakehouse first when one is needed. */
    private readonly runWithHost: <T>(resolve: () => Promise<T>) => Promise<T>,
    /** The host a notebook's cells run on: its own Lakehouse, as in the notebook editor. */
    private readonly notebookHost: (uri: vscode.Uri) => Promise<LivyHost>,
    private readonly results: ResultsPanel,
  ) {}

  dispose(): void {
    this.output.dispose();
  }

  async runFile(uri?: vscode.Uri): Promise<void> {
    const document =
      uri === undefined
        ? vscode.window.activeTextEditor?.document
        : await vscode.workspace.openTextDocument(uri);
    if (document === undefined) {
      throw noEditor("run file");
    }
    await this.runCode(
      document.getText(),
      document,
      path.basename(document.uri.fsPath),
    );
  }

  async runSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      throw noEditor("run selection");
    }
    const selection = editor.selection;
    const text = selection.isEmpty
      ? editor.document.lineAt(selection.active.line).text
      : editor.document.getText(selection);
    await this.runCode(
      text,
      editor.document,
      `selection in ${path.basename(editor.document.uri.fsPath)}`,
    );
  }

  /** Resolves the Livy host for a loose file: its folder's target, else compute. */
  async hostFor(filePath: string, entity: string): Promise<LivyHost> {
    return resolveLivyHost({
      entity,
      target: await this.targets.resolveTargetIfMapped(path.dirname(filePath)),
      signedInTenant: this.signedInTenant(),
      compute: await this.compute(),
    });
  }

  private async runCode(
    text: string,
    document: vscode.TextDocument,
    entity: string,
  ): Promise<void> {
    if (!RUNNABLE_LANGUAGES.has(document.languageId)) {
      throw new FabricConnectError(
        `Cannot run ${entity}: files in '${document.languageId}' cannot run on a Spark session.`,
        {
          operation: "run file",
          entity,
          remediation: "Run a Python, SQL, Scala or R file.",
        },
      );
    }
    const host = await this.runWithHost(() =>
      this.hostFor(document.uri.fsPath, entity),
    );
    let { kind, code } = toStatement(text, document.languageId, entity);
    if (kind === "pyspark" && hasRunMagic(code)) {
      code = await expandRunMagics(code, await this.run.index(), this.run.fs);
    }
    this.output.show(true);
    this.output.appendLine(`▶ ${entity} on ${host.label}`);
    const started = Date.now();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running ${entity} on Fabric…`,
        cancellable: true,
      },
      (_progress, token) => this.execute(host, kind, code, entity, token),
    );
    this.output.appendLine(
      `■ done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );
  }

  /**
   * Runs cells of a source-format notebook from its text editor, in order,
   * on the notebook's own host (shared session with the notebook editor).
   * `which` is one cell, every cell up to and including one, or all. Stops
   * at the first cell that fails, as the portal does.
   */
  async runNotebookCells(
    uri: vscode.Uri,
    which: { cell: number; above?: boolean } | "all",
  ): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const name = path
      .basename(path.dirname(uri.fsPath))
      .replace(/\.Notebook$/, "");
    const cells = sourceCellRanges(
      document.getText(),
      path.basename(uri.fsPath),
    ).filter(
      (cell) =>
        cell.kind !== "markdown" &&
        (which === "all" ||
          cell.index === which.cell ||
          (which.above === true && cell.index < which.cell)),
    );
    if (cells.length === 0) {
      throw new FabricConnectError(
        `Cannot run notebook ${name}: there is no code cell to run.`,
        {
          operation: "run notebook cells",
          entity: `notebook ${name}`,
          remediation:
            "Add a '# CELL ********************' block, or click Run Cell on a code cell.",
        },
      );
    }
    const host = await this.runWithHost(() => this.notebookHost(uri));
    this.output.show(true);
    this.output.appendLine(`▶ notebook ${name} on ${host.label}`);
    const started = Date.now();
    const tables: DisplayTable[] = [];
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running ${name} on Fabric…`,
        cancellable: true,
      },
      async (progress, token) => {
        for (const cell of cells) {
          const entity = `cell ${cell.index + 1} of ${name}`;
          progress.report({ message: entity });
          this.output.appendLine(`▶ ${entity}`);
          try {
            let { kind, code } = toStatement(
              cell.source,
              cell.language,
              entity,
            );
            if (kind === "pyspark" && hasRunMagic(code)) {
              code = await expandRunMagics(
                code,
                await this.run.index(),
                this.run.fs,
              );
            }
            const ran = await this.execute(host, kind, code, entity, token);
            tables.push(...ran.tables);
            if (!ran.ok) {
              return; // stop at the first failing (or cancelled) cell
            }
          } catch (error) {
            // Cancelled while queued or while the session started: as clean
            // as a cancel while running. Anything else (an unsupported
            // magic, a %run that cannot be expanded) stops here too, and
            // the cells that ran keep their output.
            this.output.appendLine(
              error instanceof LivyError && error.kind === "cancelled"
                ? "  (cancelled)"
                : `✗ ${entity}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
        }
      },
    );
    if (tables.length > 0) {
      this.results.show(name, host.label, tables);
    }
    this.output.appendLine(
      `■ done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );
  }

  /**
   * Stages local modules (Python), runs one statement on the host and
   * prints its result; `ok` is false when it failed or was cancelled.
   */
  private async execute(
    host: LivyHost,
    kind: ReturnType<typeof toStatement>["kind"],
    code: string,
    entity: string,
    token: vscode.CancellationToken,
  ): Promise<{ ok: boolean; tables: DisplayTable[] }> {
    if (kind === "pyspark") {
      const prelude = await this.run.prepare?.(host.target);
      if (prelude !== undefined) {
        const staged = await this.livy.execute(
          host.target,
          prelude,
          "pyspark",
          token,
        );
        if (staged.status !== "ok") {
          this.print(staged, "staging local modules");
          return { ok: false, tables: [] };
        }
      }
    }
    const result = await this.livy.execute(host.target, code, kind, token);
    const tables = this.print(result, entity);
    if (result.status === "error") {
      const hint = await this.run.importHint?.(
        result.errorName,
        result.errorValue,
      );
      if (hint !== undefined) {
        this.output.appendLine(`  ${hint}`);
      }
    }
    return { ok: result.status === "ok", tables };
  }

  async runSparkJob(uri?: vscode.Uri): Promise<void> {
    const start =
      uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    const folder = start === undefined ? undefined : findJobFolder(start);
    if (folder === undefined) {
      throw new FabricConnectError(
        "Cannot run a Spark job: no Spark Job Definition folder is selected.",
        {
          operation: "run Spark job",
          remediation:
            "Right-click a '*.SparkJobDefinition' folder in the Explorer, or open a file inside one, then run 'Fabric: Run Spark Job Definition'.",
        },
      );
    }
    const name = path.basename(folder).replace(/\.SparkJobDefinition$/, "");
    const readFile = async (file: string) => {
      try {
        return await fs.readFile(file, "utf8");
      } catch {
        return undefined;
      }
    };
    const settings = parseSparkJobSettings(
      await readFile(path.join(folder, SJD_SETTINGS_FILE)),
      folder,
    );
    const files = await locateJobFiles(
      {
        readFile,
        listDir: async (dir) => {
          try {
            return (await fs.readdir(dir, { withFileTypes: true }))
              .filter((e) => e.isFile())
              .map((e) => e.name)
              .sort();
          } catch {
            return [];
          }
        },
      },
      folder,
      settings,
    );
    const lakehouse = boundId(settings.defaultLakehouseArtifactId);
    const environment = boundId(settings.environmentArtifactId);
    const target = await this.targets.resolveTargetIfMapped(
      path.dirname(folder),
    );
    const host = await this.runWithHost(async () =>
      resolveLivyHost({
        entity: `Spark job ${name}`,
        // A job's settings name its Lakehouse but not the workspace: Fabric
        // keeps it in the job's own workspace, i.e. the folder's target.
        notebookDefault:
          lakehouse === undefined
            ? undefined
            : {
                id: lakehouse,
                name: "job's default Lakehouse",
                workspaceId: target?.workspaceId,
              },
        notebookEnvironment:
          environment === undefined ? undefined : { id: environment },
        target,
        signedInTenant: this.signedInTenant(),
        compute: await this.compute(),
      }),
    );

    this.output.show(true);
    this.output.appendLine(`▶ Spark job ${name} on ${host.label}`);
    const subfolder = `job-${name.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}`;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running Spark job ${name}…`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          progress.report({ message: "staging local files" });
          const mainUri = await this.stager.stageFile(
            host.target,
            subfolder,
            files.main,
          );
          const libUris = [...files.remoteLibs];
          for (const lib of files.libs) {
            libUris.push(
              await this.stager.stageFile(host.target, subfolder, lib),
            );
          }
          const request = buildBatchRequest(
            `${name} (Fabric Connect)`,
            settings,
            mainUri,
            libUris,
            host.target.environmentId,
          );
          const state = await runBatch(
            this.api,
            host.target,
            request,
            asCancelToken(token),
            {
              onState: (s) => {
                progress.report({ message: s });
                this.output.appendLine(`  state: ${s}`);
              },
              onLog: (line) => this.output.appendLine(`  ${line}`),
            },
          );
          this.output.appendLine(`■ Spark job ${name}: ${state}\n`);
          if (state === "dead" || state === "killed") {
            void vscode.window.showErrorMessage(
              `Spark job ${name} ended as '${state}'. See the 'Fabric Connect: Run' output and the Fabric monitoring hub for the driver log.`,
            );
          }
        } finally {
          await this.stager.deleteStaged(host.target, subfolder);
        }
      },
    );
  }

  /** Prints a result to the output channel; returns the tables in it. */
  private print(result: LivyStatementResult, entity: string): DisplayTable[] {
    if (result.status === "cancelled") {
      this.output.appendLine("  (cancelled)");
      return [];
    }
    if (result.status === "error") {
      this.output.appendLine(
        `✗ ${entity} raised ${result.errorName ?? "Error"}: ${result.errorValue ?? ""}`,
      );
      for (const line of result.traceback ?? []) {
        this.output.append(line.endsWith("\n") ? line : `${line}\n`);
      }
      return [];
    }
    const found: DisplayTable[] = [];
    const data = result.data ?? {};
    const plain = data["text/plain"];
    if (typeof plain === "string") {
      const { text, tables } = extractDisplays(plain);
      if (text.length > 0) {
        this.output.append(text.endsWith("\n") ? text : `${text}\n`);
      }
      for (const table of tables) {
        this.output.appendLine(renderTableText(table));
      }
      found.push(...tables);
    }
    const sqlTable = livySqlResultToTable(data["application/json"]);
    if (sqlTable !== undefined) {
      this.output.appendLine(renderTableText(sqlTable));
      found.push(sqlTable);
    }
    const other = Object.keys(data).filter(
      (mime) =>
        mime !== "text/plain" &&
        !(mime === "application/json" && sqlTable !== undefined),
    );
    if (other.length > 0) {
      this.output.appendLine(
        `  (${other.join(", ")} output not shown here — run the code in a Fabric notebook to see it)`,
      );
    }
    return found;
  }
}

function findJobFolder(start: string): string | undefined {
  let current = start;
  for (;;) {
    if (current.endsWith(".SparkJobDefinition")) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function asCancelToken(token: vscode.CancellationToken): CancelToken {
  return token;
}

function noEditor(operation: string): FabricConnectError {
  return new FabricConnectError(`Cannot ${operation}: no editor is active.`, {
    operation,
    remediation: "Open the file you want to run, then try again.",
  });
}
