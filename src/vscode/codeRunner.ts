/**
 * Run a file, a selection, or a Spark Job Definition from the working tree
 * on the connected compute — the Databricks Connect workflow: edit locally,
 * run remotely, see the result in the editor. Output goes to the
 * "Fabric Connect: Run" output channel (tables rendered as text).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { toStatement } from "../core/cellCode";
import type { ComputeProfile } from "../core/computeProfile";
import {
  extractDisplays,
  livySqlResultToTable,
  renderTableText,
} from "../core/displayProtocol";
import { FabricConnectError } from "../core/errors";
import { type LivyHost, resolveLivyHost } from "../core/livyHost";
import type {
  ILivySessionManager,
  LivyStatementResult,
} from "../core/livySessionManager";
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

const RUNNABLE_LANGUAGES = new Set(["python", "sql", "scala", "r"]);
const NIL_GUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

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
    const host = await this.hostFor(document.uri.fsPath, entity);
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
      async (_progress, token) => {
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
              return;
            }
          }
        }
        const result = await this.livy.execute(host.target, code, kind, token);
        this.print(result, entity);
      },
    );
    this.output.appendLine(
      `■ done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );
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
    const lakehouse = settings.defaultLakehouseArtifactId;
    const environment = settings.environmentArtifactId;
    const host = resolveLivyHost({
      entity: `Spark job ${name}`,
      notebookDefault:
        lakehouse === undefined || NIL_GUID.test(lakehouse)
          ? undefined
          : { id: lakehouse, name: "job's default Lakehouse" },
      notebookEnvironment:
        environment === undefined || NIL_GUID.test(environment)
          ? undefined
          : { id: environment },
      target: await this.targets.resolveTargetIfMapped(path.dirname(folder)),
      compute: await this.compute(),
    });

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

  private print(result: LivyStatementResult, entity: string): void {
    if (result.status === "cancelled") {
      this.output.appendLine("  (cancelled)");
      return;
    }
    if (result.status === "error") {
      this.output.appendLine(
        `✗ ${entity} raised ${result.errorName ?? "Error"}: ${result.errorValue ?? ""}`,
      );
      for (const line of result.traceback ?? []) {
        this.output.append(line.endsWith("\n") ? line : `${line}\n`);
      }
      return;
    }
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
    }
    const sqlTable = livySqlResultToTable(data["application/json"]);
    if (sqlTable !== undefined) {
      this.output.appendLine(renderTableText(sqlTable));
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
