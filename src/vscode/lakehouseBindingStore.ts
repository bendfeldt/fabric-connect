/**
 * This machine's Lakehouse bindings (see `src/core/lakehouseBindings.ts`):
 * reads and writes `"lakehouseBindings"` in the gitignored
 * `.fabric/local.json`, keyed by each notebook's item folder. Binding a
 * notebook here never changes the notebook file.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { LakehouseError } from "../core/errors";
import {
  type LakehouseBinding,
  notebookKey,
  readLakehouseBindings,
  writeLakehouseBinding,
} from "../core/lakehouseBindings";
import { LOCAL_OVERRIDE_FILE } from "../core/targetResolver";
import { warnIfLocalFileNotIgnored } from "./computeConnection";

export class LakehouseBindingStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after a binding is saved or removed. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly workspaceRoot: string | undefined) {}

  dispose(): void {
    this.changed.dispose();
  }

  /** The binding of the notebook whose content file this is, if any. */
  async get(notebook: vscode.Uri): Promise<LakehouseBinding | undefined> {
    const key = this.keyOf(notebook);
    if (key === undefined) {
      return undefined;
    }
    return readLakehouseBindings(await this.readLocal()).get(key);
  }

  /** Saves (or, for `undefined`, removes) the notebook's binding. */
  async set(
    notebook: vscode.Uri,
    binding: LakehouseBinding | undefined,
  ): Promise<void> {
    const root = this.workspaceRoot;
    const key = this.keyOf(notebook);
    if (root === undefined || key === undefined) {
      throw new LakehouseError(
        `Cannot bind a Lakehouse for '${path.basename(path.dirname(notebook.fsPath))}': it is not inside the open repo folder.`,
        {
          operation: "bind default lakehouse",
          entity: `notebook ${path.basename(path.dirname(notebook.fsPath))}`,
          remediation:
            "Open the repo folder that contains the notebook (File → Open Folder), then bind again.",
        },
      );
    }
    const file = path.join(root, LOCAL_OVERRIDE_FILE);
    const text = writeLakehouseBinding(await this.readLocal(), key, binding);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
    this.changed.fire();
    if (binding !== undefined) {
      await warnIfLocalFileNotIgnored(root);
    }
  }

  private keyOf(notebook: vscode.Uri): string | undefined {
    return this.workspaceRoot === undefined
      ? undefined
      : notebookKey(this.workspaceRoot, path.dirname(notebook.fsPath));
  }

  private async readLocal(): Promise<string | undefined> {
    if (this.workspaceRoot === undefined) {
      return undefined;
    }
    try {
      return await fs.readFile(
        path.join(this.workspaceRoot, LOCAL_OVERRIDE_FILE),
        "utf8",
      );
    } catch {
      return undefined;
    }
  }
}
