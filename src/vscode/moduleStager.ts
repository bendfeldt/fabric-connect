/**
 * Stages the working tree's Python modules (setting
 * `fabric-connect.sourceRoots`) to the session host before Python code
 * runs, and removes this window's scratch folder when a session stops.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { LivyTarget } from "../core/livySessionManager";
import {
  bundleModules,
  bundlePath,
  moduleImportCode,
  scratchFolder,
  stagedFileName,
} from "../core/moduleStaging";
import { type OneLakeClient, abfssUri } from "../core/oneLakeClient";

export class ModuleStager {
  /** One scratch folder per VS Code window, so windows never collide. */
  readonly runId = `run-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString("hex")}`;
  /** Bundle hashes already uploaded, per host Lakehouse. */
  private readonly uploaded = new Map<string, Set<string>>();

  constructor(
    private readonly oneLake: OneLakeClient,
    private readonly workspaceRoot: string | undefined,
  ) {}

  /**
   * Python to run before the user's code so `import` sees the local
   * sources, or undefined when no source roots are configured.
   */
  async prepare(target: LivyTarget): Promise<string | undefined> {
    const roots = vscode.workspace
      .getConfiguration("fabric-connect")
      .get<string[]>("sourceRoots", []);
    if (this.workspaceRoot === undefined || roots.length === 0) {
      return undefined;
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
