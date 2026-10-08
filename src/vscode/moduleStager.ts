/**
 * Stages the working tree's Python modules to the session host before
 * Python code runs (Python modules: Local), and removes this window's
 * scratch folder when a session stops. With Python modules: Remote nothing
 * is staged and `import` uses what the Fabric environment has installed.
 */

import * as crypto from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { LivyTarget } from "../core/livySessionManager";
import { StagingError } from "../core/errors";
import {
  bundleModules,
  bundlePath,
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
} from "../core/moduleStaging";
import { type OneLakeClient, abfssUri } from "../core/oneLakeClient";

export class ModuleStager {
  /** One scratch folder per VS Code window, so windows never collide. */
  readonly runId = `run-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;
  /** Bundle hashes already uploaded, per host Lakehouse. */
  private readonly uploaded = new Map<string, Set<string>>();
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
          e.affectsConfiguration("fabric-connect.sourceRoots")
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
    return describeModules(this.mode(), [
      ...(await this.localPackages()).keys(),
    ]);
  }

  /** Where `import` finds your packages, from the settings. */
  mode(): PythonModuleMode {
    const config = vscode.workspace.getConfiguration("fabric-connect");
    return resolveModuleMode(
      config.get<string>("pythonModules"),
      config.get<string[]>("sourceRoots", []),
    );
  }

  /**
   * Python to run before the user's code so `import` sees the local
   * sources, or undefined when Python modules are Remote.
   */
  async prepare(target: LivyTarget): Promise<string | undefined> {
    if (this.workspaceRoot === undefined || this.mode() === "remote") {
      return undefined;
    }
    const roots = await this.sourceRoots();
    if (roots.length === 0) {
      throw new StagingError(
        "Cannot stage local modules: no source folder was found in this repo.",
        {
          operation: "stage local modules",
          entity: `workspace folder ${path.basename(this.workspaceRoot)}`,
          remediation:
            "Set 'fabric-connect.sourceRoots' (e.g. [\"src\"]), or run 'Fabric: Python Modules' and pick Remote.",
        },
      );
    }
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
    const relPath = bundlePath(this.runId, bundle.hash);
    const key = hostKey(target);
    const done = this.uploaded.get(key) ?? new Set<string>();
    if (!done.has(bundle.hash)) {
      await this.oneLake.uploadFile(
        {
          tenantId: target.tenantId,
          workspaceId: target.workspaceId,
          itemId: target.lakehouseId,
        },
        relPath,
        bundle.zip,
      );
      done.add(bundle.hash);
      this.uploaded.set(key, done);
    }
    return moduleImportCode(
      abfssUri(target.workspaceId, target.lakehouseId, relPath),
      bundle.topLevel,
    );
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

  /** Lets you pick Local or Remote; saved in this repo's settings. */
  async pickMode(): Promise<void> {
    const packages = [...(await this.localPackages()).values()];
    const current = this.mode();
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "Local",
          mode: "local" as const,
          description: current === "local" ? "current" : undefined,
          detail:
            packages.length > 0
              ? `Import your working tree (${packages.join(", ")}), staged to the session's Lakehouse before Python runs.`
              : "Import your working tree, staged to the session's Lakehouse before Python runs.",
        },
        {
          label: "Remote",
          mode: "remote" as const,
          description: current === "remote" ? "current" : undefined,
          detail:
            "Import what the Fabric environment has installed (e.g. your published wheel). Nothing is staged; a running session keeps code staged earlier until you restart it.",
        },
      ],
      { title: "Python modules: where should import find your packages?" },
    );
    if (picked === undefined) {
      return;
    }
    await vscode.workspace
      .getConfiguration("fabric-connect")
      .update(
        "pythonModules",
        picked.mode,
        vscode.ConfigurationTarget.Workspace,
      );
  }

  /** Shows the mode in the status bar when the repo has Python packages. */
  async refreshStatus(): Promise<void> {
    const packages = [...(await this.localPackages()).keys()];
    const shown = describeModules(this.mode(), packages);
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

  /** Stages extra files (e.g. a Spark job's main file) under this run. */
  async stageFile(
    target: LivyTarget,
    subfolder: string,
    file: string,
  ): Promise<string> {
    const relPath = `${scratchFolder(this.runId)}/${subfolder}/${stagedFileName(path.basename(file))}`;
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
        `${scratchFolder(this.runId)}/${subfolder}`,
      );
    } catch {
      // Best effort: a leftover scratch folder is harmless and small.
    }
  }

  /** Deletes this window's scratch folder on the host (best effort). */
  async cleanup(target: LivyTarget): Promise<void> {
    this.uploaded.delete(hostKey(target));
    try {
      await this.oneLake.deleteDirectory(
        {
          tenantId: target.tenantId,
          workspaceId: target.workspaceId,
          itemId: target.lakehouseId,
        },
        scratchFolder(this.runId),
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

function hostKey(target: LivyTarget): string {
  return `${target.tenantId}/${target.workspaceId}/${target.lakehouseId}`;
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
