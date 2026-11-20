/**
 * Sends the working tree's Python modules to the session before Python
 * code runs (Python modules: Local), and stages Spark job files in this
 * window's OneLake scratch folder. With Python modules: Remote nothing is
 * sent and `import` uses what the Fabric environment has installed.
 */

import * as crypto from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { LivySessionSetup, LivyTarget } from "../core/livySessionManager";
import { StagingError } from "../core/errors";
import {
  bundleModules,
  bundleFileName,
  describeModules,
  failedImportPackage,
  localModuleHint,
  type ModulesDescription,
  moduleImportCode,
  type PythonModuleMode,
  resolveModuleMode,
  scratchFolder,
  sourceRootsFromPyproject,
  stagedFileName,
  wheelChunkCode,
  wheelInitializeCode,
  wheelInstallCode,
} from "../core/moduleStaging";
import { type OneLakeClient, abfssUri } from "../core/oneLakeClient";

export class ModuleStager {
  /** One scratch folder per VS Code window, so windows never collide. */
  readonly runId = `run-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly watchers: vscode.Disposable[] = [];
  /**
   * Fires when the mode or the local packages may have changed (settings,
   * pyproject.toml). The status bar and the Configuration view both follow it.
   */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly oneLake: OneLakeClient,
    private readonly workspaceRoot: string | undefined,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      "fabric-connect.pythonModules",
      vscode.StatusBarAlignment.Left,
      48,
    );
    this.statusBar.name = "Fabric Python Modules";
    this.statusBar.command = "fabric-connect.pythonModules";
    const pyproject =
      vscode.workspace.createFileSystemWatcher("**/pyproject.toml");
    this.watchers.push(
      pyproject,
      pyproject.onDidCreate(() => this.changed.fire()),
      pyproject.onDidChange(() => this.changed.fire()),
      pyproject.onDidDelete(() => this.changed.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("fabric-connect.pythonModules") ||
          e.affectsConfiguration("fabric-connect.sourceRoots") ||
          e.affectsConfiguration("fabric-connect.localWheel")
        ) {
          this.changed.fire();
        }
      }),
      this.onDidChange(() => void this.refreshStatus()),
    );
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.changed.dispose();
    this.statusBar.dispose();
  }

  /** The mode and local packages, as both the status bar and the view show them. */
  async describe(): Promise<ModulesDescription> {
    return describeModules(
      this.mode(),
      [...(await this.localPackages()).keys()],
      this.selectedWheelName(),
    );
  }

  /** Where `import` finds your packages, from the settings. */
  mode(): PythonModuleMode {
    const config = vscode.workspace.getConfiguration("fabric-connect");
    return resolveModuleMode(
      config.get<string>("pythonModules"),
      config.get<string[]>("sourceRoots", []),
    );
  }

  selectedWheelName(): string | undefined {
    const selected = vscode.workspace
      .getConfiguration("fabric-connect")
      .get<string>("localWheel", "");
    return selected.length === 0 ? undefined : path.basename(selected);
  }

  private async prepareWheel(): Promise<LivySessionSetup> {
    if (this.workspaceRoot === undefined) {
      throw new StagingError("Select workspace before using local wheel.", {
        operation: "stage local wheel",
        remediation:
          "Open repository folder, then select wheel with 'Fabric: Python Modules'.",
      });
    }
    const relative = vscode.workspace
      .getConfiguration("fabric-connect")
      .get<string>("localWheel", "");
    if (relative.length === 0) {
      throw new StagingError("No local wheel selected.", {
        operation: "stage local wheel",
        remediation: "Run 'Fabric: Python Modules' and choose 'Local wheel…'.",
      });
    }
    const selectedPath = path.resolve(this.workspaceRoot, relative);
    const files: Array<{
      fileName: string;
      size: number;
      sha256: string;
      path: string;
    }> = [];
    let selectedWheel: string;
    try {
      const workspace = await fs.realpath(this.workspaceRoot);
      const resolvedSelected = await fs.realpath(selectedPath);
      selectedWheel = path.basename(resolvedSelected);
      const siblingDirectory = path.dirname(resolvedSelected);
      const entries = await fs.readdir(siblingDirectory, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.name.toLowerCase().endsWith(".whl")) continue;
        const candidate = await fs.realpath(
          path.join(siblingDirectory, entry.name),
        );
        const workspaceRelative = path.relative(workspace, candidate);
        if (
          workspaceRelative === ".." ||
          workspaceRelative.startsWith(".." + path.sep) ||
          path.isAbsolute(workspaceRelative)
        ) {
          throw new Error(
            "Wheel '" + entry.name + "' resolves outside the workspace.",
          );
        }
        if (!(await fs.stat(candidate)).isFile()) {
          throw new Error("Wheel '" + entry.name + "' is not a regular file.");
        }
        await fs.access(candidate, fsConstants.R_OK);
        const digest = crypto.createHash("sha256");
        let size = 0;
        for await (const chunk of createReadStream(candidate, {
          highWaterMark: 256 * 1024,
        })) {
          size += chunk.length;
          digest.update(chunk);
        }
        files.push({
          fileName: entry.name,
          size,
          sha256: digest.digest("hex"),
          path: candidate,
        });
      }
      if (!files.some((file) => file.fileName === selectedWheel)) {
        throw new Error(
          "The selected wheel is not a direct sibling in its wheelhouse.",
        );
      }
    } catch (cause) {
      throw new StagingError("Cannot read selected wheel '" + relative + "'.", {
        operation: "stage local wheel",
        entity: relative,
        remediation:
          "Restore readable .whl files inside the workspace, then select the wheel again.",
        cause,
      });
    }
    files.sort((left, right) =>
      left.fileName < right.fileName
        ? -1
        : left.fileName > right.fileName
          ? 1
          : 0,
    );
    const manifest = files.map(({ fileName, size, sha256 }) => ({
      fileName,
      size,
      sha256,
    }));
    const hashInput = JSON.stringify([
      selectedWheel,
      ...manifest.map((file) => [file.fileName, file.sha256]),
    ]);
    const contentHash = crypto
      .createHash("sha256")
      .update(hashInput)
      .digest("hex");
    return {
      key: "wheel:" + contentHash,
      requiresFreshSession: true,
      createStatements: async function* () {
        yield {
          code: wheelInitializeCode(contentHash, manifest),
          kind: "pyspark",
        };
        for (const file of files) {
          let offset = 0;
          for await (const chunk of createReadStream(file.path, {
            highWaterMark: 256 * 1024,
          })) {
            yield {
              code: wheelChunkCode(
                contentHash,
                file.fileName,
                offset,
                chunk.toString("base64"),
              ),
              kind: "pyspark",
            };
            offset += chunk.length;
          }
        }
        yield {
          code: wheelInstallCode(selectedWheel, contentHash, manifest),
          kind: "pyspark",
        };
      },
    };
  }

  private async validateWheelSelection(file: string): Promise<string> {
    if (this.workspaceRoot === undefined) {
      throw new StagingError("The selected wheel must be inside a workspace.", {
        operation: "select local wheel",
        remediation:
          "Open the repository folder, then choose a wheel inside it.",
      });
    }
    try {
      const root = await fs.realpath(this.workspaceRoot);
      const resolved = await fs.realpath(file);
      const relative = path.relative(root, resolved);
      if (
        relative.length === 0 ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error("The wheel must be a file inside the workspace.");
      }
      if (path.extname(resolved).toLowerCase() !== ".whl") {
        throw new Error("Choose a file with the .whl extension.");
      }
      if (!(await fs.stat(resolved)).isFile()) {
        throw new Error("The selected wheel is not a regular file.");
      }
      await fs.access(resolved, fs.constants.R_OK);
      return relative.split(path.sep).join("/");
    } catch (cause) {
      throw new StagingError(`Cannot use '${file}' as a local wheel.`, {
        operation: "select local wheel",
        entity: file,
        remediation:
          "Choose a readable .whl file inside the workspace. The selected file is stored as a workspace-relative path.",
        cause,
      });
    }
  }

  /**
   * Python to run before the user's code so `import` sees the local
   * sources, or undefined when Python modules are Remote.
   */
  async prepare(target: LivyTarget): Promise<LivySessionSetup | undefined> {
    const mode = this.mode();
    if (mode === "remote") return undefined;
    if (mode === "wheel") return this.prepareWheel();
    if (this.workspaceRoot === undefined) return undefined;
    const roots = await this.sourceRoots();
    if (roots.length === 0) return undefined;
    const bundle = await bundleModules(
      {
        listFiles: listFilesRecursive,
        readBytes: async (file) => new Uint8Array(await fs.readFile(file)),
      },
      this.workspaceRoot,
      roots,
    );
    if (bundle === undefined) {
      return undefined;
    }
    return {
      key: `local:${bundle.hash}`,
      createStatements: async function* () {
        yield {
          code: moduleImportCode(
            Buffer.from(bundle.zip).toString("base64"),
            bundleFileName(bundle.hash),
            bundle.topLevel,
          ),
          kind: "pyspark",
        };
      },
    };
  }

  /**
   * Source roots to stage: `fabric-connect.sourceRoots` if set, else the
   * folders `pyproject.toml` names, else `src` — only folders that exist.
   */
  async sourceRoots(): Promise<string[]> {
    if (this.workspaceRoot === undefined) {
      return [];
    }
    const configured = vscode.workspace
      .getConfiguration("fabric-connect")
      .get<string[]>("sourceRoots", []);
    if (configured.length > 0) {
      return configured;
    }
    let detected: string[] | undefined;
    try {
      detected = sourceRootsFromPyproject(
        await fs.readFile(
          path.join(this.workspaceRoot, "pyproject.toml"),
          "utf8",
        ),
      );
    } catch {
      // No pyproject.toml: fall back to the common `src` layout.
    }
    const existing: string[] = [];
    for (const root of detected ?? ["src"]) {
      if (await isDirectory(path.join(this.workspaceRoot, root))) {
        existing.push(root);
      }
    }
    return existing;
  }

  /** Local top-level packages and modules, by name, with their repo path. */
  async localPackages(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (this.workspaceRoot === undefined) {
      return found;
    }
    for (const root of await this.sourceRoots()) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(path.join(this.workspaceRoot, root), {
          withFileTypes: true,
        });
      } catch {
        continue; // an unreadable root has no packages to report
      }
      for (const entry of entries) {
        const rel = path.posix.join(root, entry.name);
        if (entry.isFile() && entry.name.endsWith(".py")) {
          found.set(entry.name.slice(0, -3), rel);
        } else if (
          entry.isDirectory() &&
          (await isFile(path.join(this.workspaceRoot, rel, "__init__.py")))
        ) {
          found.set(entry.name, rel);
        }
      }
    }
    return found;
  }

  /**
   * A hint for an import error about a package that is also in the repo
   * while Python modules are Remote; undefined otherwise.
   */
  async importHint(
    errorName: string | undefined,
    errorValue: string | undefined,
  ): Promise<string | undefined> {
    const name = failedImportPackage(errorName, errorValue);
    if (name === undefined || this.mode() === "local") {
      return undefined;
    }
    const local = (await this.localPackages()).get(name);
    return local === undefined ? undefined : localModuleHint(name, local);
  }

  /** Lets you pick a module source; saved in this workspace's settings. */
  async pickMode(): Promise<
    | {
        previous: PythonModuleMode;
        selected: PythonModuleMode;
        wheelChanged?: boolean;
      }
    | undefined
  > {
    const packages = [...(await this.localPackages()).values()];
    const current = this.mode();
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "Local",
          mode: "local" as const,
          description:
            current === "local"
              ? "current"
              : current === "wheel"
                ? "switching resets the active Livy session"
                : undefined,
          detail:
            packages.length > 0
              ? `Import your working tree (${packages.join(", ")}), sent to the session before Python runs.`
              : "No local packages found; local notebook %run still uses the working tree.",
        },
        {
          label: "Remote",
          mode: "remote" as const,
          description:
            current === "remote"
              ? "current"
              : current === "wheel"
                ? "switching resets the active Livy session"
                : undefined,
          detail:
            "Import what the Fabric environment has installed (e.g. your published wheel). Choosing Remote from Local or switching from Wheel replaces a running session and clears its state.",
        },
        {
          label: "Local wheel…",
          mode: "wheel" as const,
          description: current === "wheel" ? "current" : undefined,
          detail:
            "Install a workspace .whl temporarily in each Livy session; choosing it replaces a running session and clears its state.",
        },
      ],
      { title: "Python modules: where should import find your packages?" },
    );
    if (picked === undefined) {
      return undefined;
    }
    const config = vscode.workspace.getConfiguration("fabric-connect");
    const previousWheel = config.get<string>("localWheel", "");
    let selectedWheel = previousWheel;
    if (picked.mode === "wheel") {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { "Python wheels": ["whl"] },
      });
      if (selected === undefined || selected.length === 0) return undefined;
      selectedWheel = await this.validateWheelSelection(selected[0].fsPath);
      if (selectedWheel !== previousWheel) {
        await config.update(
          "localWheel",
          selectedWheel,
          vscode.ConfigurationTarget.Workspace,
        );
      }
    }
    await config.update(
      "pythonModules",
      picked.mode,
      vscode.ConfigurationTarget.Workspace,
    );
    return {
      previous: current,
      selected: picked.mode,
      ...(picked.mode === "wheel"
        ? { wheelChanged: selectedWheel !== previousWheel }
        : {}),
    };
  }

  /** Shows the mode in the status bar when the repo has Python packages. */
  async refreshStatus(): Promise<void> {
    const packages = [...(await this.localPackages()).keys()];
    const shown = describeModules(
      this.mode(),
      packages,
      this.selectedWheelName(),
    );
    if (
      this.workspaceRoot === undefined ||
      (packages.length === 0 && shown.mode === "remote")
    ) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = `$(${shown.icon}) Modules: ${shown.label}`;
    this.statusBar.tooltip = `${shown.tooltip} Click to change.`;
    this.statusBar.show();
  }

  /** The OneLake folder of one staged subfolder of this run. */
  stagedFolder(subfolder: string): string {
    return `${scratchFolder(this.runId)}/${subfolder}`;
  }

  /** Stages extra files (e.g. a Spark job's main file) under this run. */
  async stageFile(
    target: LivyTarget,
    subfolder: string,
    file: string,
  ): Promise<string> {
    const relPath = `${this.stagedFolder(subfolder)}/${stagedFileName(path.basename(file))}`;
    await this.oneLake.uploadFile(
      {
        tenantId: target.tenantId,
        workspaceId: target.workspaceId,
        itemId: target.lakehouseId,
      },
      relPath,
      new Uint8Array(await fs.readFile(file)),
    );
    return abfssUri(target.workspaceId, target.lakehouseId, relPath);
  }

  /** Deletes one staged subfolder of this run (best effort). */
  async deleteStaged(target: LivyTarget, subfolder: string): Promise<void> {
    try {
      await this.oneLake.deleteDirectory(
        {
          tenantId: target.tenantId,
          workspaceId: target.workspaceId,
          itemId: target.lakehouseId,
        },
        this.stagedFolder(subfolder),
      );
    } catch {
      // Best effort: a leftover scratch folder is harmless and small.
    }
  }
}

async function isDirectory(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => undefined))?.isDirectory() === true;
}

async function isFile(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => undefined))?.isFile() === true;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "__pycache__"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}
