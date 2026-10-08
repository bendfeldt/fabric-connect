/**
 * Repo view (Fabric side bar): the repo's Fabric items, inside the folders
 * that lead to them on disk. An item folder (`<name>.<Type>/` holding a
 * `.platform`) is one node by display name with its own files under it;
 * folders without items and loose files are not shown. A Notebook item
 * opens in the Fabric notebook editor and lists its attached Lakehouses
 * (default first); notebooks and Spark Job Definitions run on Fabric
 * through the existing run commands.
 *
 * The view lists folders lazily. Its only write is Edit Item Metadata,
 * which changes an item's `.platform` (display name, description) as an
 * undoable edit. Display rules live in `src/core/repoTree.ts`.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { FabricConnectError } from "../core/errors";
import {
  type LocalItem,
  parsePlatform,
  updatePlatform,
} from "../core/localItemIndex";
import {
  type DirEntry,
  type RunKind,
  PLATFORM_FILE,
  foldersWithItems,
  hiddenNames,
  isItemFolder,
  itemRunKind,
  notebookContentFile,
  relativeKey,
  visibleEntries,
} from "../core/repoTree";
import {
  type AttachmentSources,
  notebookTypeOf,
  readAttachments,
} from "./lakehouseAttachments";
import {
  type LakehouseNode,
  type UnboundDefaultNode,
  attachedNodes,
  lakehouseTreeItem,
  unboundDefaultTreeItem,
} from "./lakehousesView";

export type RepoNode =
  | { kind: "folder"; uri: vscode.Uri; insideItem: boolean }
  | {
      kind: "item";
      uri: vscode.Uri;
      item: LocalItem;
      /** The notebook file a Notebook item opens, if it has one. */
      content?: vscode.Uri;
    }
  /** Only inside an item: loose files elsewhere are not shown. */
  | { kind: "file"; uri: vscode.Uri }
  | LakehouseNode
  | UnboundDefaultNode
  | { kind: "message"; label: string };

/** Icons for common item types; anything else gets a generic one. */
const ITEM_ICONS: Record<string, string> = {
  Notebook: "notebook",
  SparkJobDefinition: "rocket",
  Lakehouse: "database",
  Warehouse: "database",
  Environment: "package",
  DataPipeline: "type-hierarchy",
  SemanticModel: "graph",
  Report: "graph-line",
};

const REFRESH_DELAY_MS = 300;

export class RepoView
  implements vscode.TreeDataProvider<RepoNode>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<RepoNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private pending: ReturnType<typeof setTimeout> | undefined;
  /** Item folders and their ancestors; rebuilt after each refresh. */
  private itemFolders: Promise<Set<string>> | undefined;

  constructor(
    private readonly workspaceRoot: string | undefined,
    /** A Lakehouse's listed name, for attachments that only carry an ID. */
    private readonly lakehouseName: (id: string) => string | undefined,
    /** Logical IDs from the repo and this machine's bindings. */
    private readonly sources?: AttachmentSources,
  ) {
    if (workspaceRoot !== undefined) {
      // Created, deleted or renamed files and edited .platform files.
      const all = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, "**/*"),
        false,
        true,
        false,
      );
      const platform = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, `**/${PLATFORM_FILE}`),
        true,
        false,
        true,
      );
      this.disposables.push(
        all,
        platform,
        all.onDidCreate(() => this.refreshSoon()),
        all.onDidDelete(() => this.refreshSoon()),
        platform.onDidChange(() => this.refreshSoon()),
        // Attachments are notebook metadata: saved through the editor.
        vscode.workspace.onDidSaveNotebookDocument(() => this.refreshSoon()),
        vscode.workspace.onDidChangeConfiguration((e) => {
          if (e.affectsConfiguration("files.exclude")) {
            this.refresh();
          }
        }),
      );
    }
  }

  dispose(): void {
    clearTimeout(this.pending);
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  refresh(): void {
    this.itemFolders = undefined;
    this.changed.fire(undefined);
  }

  /** Coalesces bursts of file events (a git checkout, a pull) into one. */
  private refreshSoon(): void {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.refresh(), REFRESH_DELAY_MS);
  }

  getTreeItem(node: RepoNode): vscode.TreeItem {
    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const none = vscode.TreeItemCollapsibleState.None;
    switch (node.kind) {
      case "message":
        return new vscode.TreeItem(node.label, none);
      case "lakehouse":
        return lakehouseTreeItem(
          node,
          this.lakehouseName(node.lakehouse.id),
          true,
        );
      case "unboundDefault":
        return unboundDefaultTreeItem(node, true);
      case "folder": {
        const item = new vscode.TreeItem(node.uri, collapsed);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = "fabricRepoFolder";
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(node.uri, none);
        item.iconPath = vscode.ThemeIcon.File;
        item.command = {
          title: "Open",
          command: "vscode.open",
          arguments: [node.uri],
        };
        item.contextValue = "fabricRepoFile";
        return item;
      }
      case "item": {
        const { item: local } = node;
        const item = new vscode.TreeItem(local.displayName, collapsed);
        item.id = `item:${node.uri.toString()}`;
        const folderName = path.basename(node.uri.fsPath);
        item.description =
          folderName === `${local.displayName}.${local.type}`
            ? local.type
            : `${local.type} · ${folderName}`;
        item.tooltip = new vscode.MarkdownString().appendText(
          [
            `${local.type} ${local.displayName}`,
            local.description,
            this.relative(node.uri),
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        item.iconPath = new vscode.ThemeIcon(
          ITEM_ICONS[local.type] ?? "symbol-misc",
        );
        item.contextValue = [
          "fabricRepoItem",
          itemRunKind(local.type) === undefined ? "" : "runnable",
          `type-${local.type}`,
        ]
          .filter(Boolean)
          .join(" ");
        if (node.content !== undefined) {
          item.command = {
            title: "Open Notebook",
            command: "vscode.openWith",
            arguments: [node.content, notebookTypeOf(node.content)],
          };
        }
        return item;
      }
    }
  }

  async getChildren(node?: RepoNode): Promise<RepoNode[]> {
    if (this.workspaceRoot === undefined) {
      // The view's welcome content asks for a folder.
      return [];
    }
    try {
      if (node === undefined) {
        // No items: an empty list, so the view's welcome content shows.
        return await this.list(vscode.Uri.file(this.workspaceRoot), false);
      }
      if (node.kind === "folder") {
        return await this.list(node.uri, node.insideItem);
      }
      if (node.kind === "item") {
        const files = await this.list(node.uri, true, true);
        const attachments =
          node.content === undefined
            ? undefined
            : await readAttachments(node.content, this.sources);
        return attachments === undefined || node.content === undefined
          ? files
          : [...attachedNodes(node.content, attachments), ...files];
      }
      return [];
    } catch (error) {
      return [
        {
          kind: "message",
          label: `⚠ ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  }

  /** The children of a folder; subfolders holding `.platform` become items. */
  private async list(
    folder: vscode.Uri,
    insideItem: boolean,
    isItem = false,
  ): Promise<RepoNode[]> {
    const hidden = hiddenNames(
      vscode.workspace.getConfiguration("files").get("exclude"),
    );
    let entries = visibleEntries(await readDir(folder), hidden, isItem);
    if (!insideItem && this.workspaceRoot !== undefined) {
      // Outside items: only folders that are, or lead to, an item.
      const root = this.workspaceRoot;
      const keep = await this.foldersWithItems();
      entries = entries.filter((entry) => {
        if (!entry.isDirectory) {
          return false;
        }
        const key = relativeKey(
          root,
          vscode.Uri.joinPath(folder, entry.name).fsPath,
        );
        return key !== undefined && keep.has(key);
      });
    }
    return Promise.all(
      entries.map(async (entry): Promise<RepoNode> => {
        const uri = vscode.Uri.joinPath(folder, entry.name);
        if (!entry.isDirectory) {
          return { kind: "file", uri };
        }
        if (!insideItem) {
          const item = await this.itemAt(uri);
          if (item !== undefined) {
            return item;
          }
        }
        return { kind: "folder", uri, insideItem };
      }),
    );
  }

  /** Every item folder and its ancestors, from the repo's `.platform` files. */
  private foldersWithItems(): Promise<Set<string>> {
    const root = this.workspaceRoot;
    if (root === undefined) {
      return Promise.resolve(new Set());
    }
    this.itemFolders ??= Promise.resolve(
      vscode.workspace.findFiles(
        new vscode.RelativePattern(root, `**/${PLATFORM_FILE}`),
        "**/node_modules/**",
      ),
    ).then((files) =>
      foldersWithItems(
        files.map((uri) => uri.fsPath),
        root,
      ),
    );
    return this.itemFolders;
  }

  /** The item a folder holds, when its `.platform` parses. */
  private async itemAt(folder: vscode.Uri): Promise<RepoNode | undefined> {
    let entries: DirEntry[];
    try {
      entries = await readDir(folder);
    } catch {
      return undefined;
    }
    if (!isItemFolder(entries)) {
      return undefined;
    }
    const item = parsePlatform(
      await readText(vscode.Uri.joinPath(folder, PLATFORM_FILE)),
      folder.fsPath,
    );
    if (item === undefined) {
      // A broken .platform: shown as the plain folder it is.
      return undefined;
    }
    const content =
      item.type === "Notebook" ? notebookContentFile(entries) : undefined;
    return {
      kind: "item",
      uri: folder,
      item,
      ...(content === undefined
        ? {}
        : { content: vscode.Uri.joinPath(folder, content) }),
    };
  }

  /** Runs a node on the connected compute through the existing commands. */
  async run(node: RepoNode): Promise<void> {
    const kind = runKindOf(node);
    // Only items and folders run; Lakehouse rows and messages do not.
    if (
      kind === undefined ||
      (node.kind !== "item" && node.kind !== "folder")
    ) {
      return;
    }
    switch (kind) {
      case "notebook": {
        if (node.kind !== "item" || node.content === undefined) {
          const name = node.kind === "item" ? node.item.displayName : "";
          throw new FabricConnectError(
            `Cannot run notebook '${name}': its folder has no notebook-content file.`,
            {
              operation: "run notebook",
              entity: `notebook ${name}`,
              remediation:
                "Pull the notebook into the repo again, or add notebook-content.ipynb (or .py) to its folder.",
            },
          );
        }
        await vscode.commands.executeCommand(
          "vscode.openWith",
          node.content,
          notebookTypeOf(node.content),
        );
        await vscode.commands.executeCommand("notebook.execute");
        return;
      }
      case "sparkJob":
        await vscode.commands.executeCommand(
          "fabric-connect.runSparkJob",
          node.uri,
        );
        return;
    }
  }

  /** Opens an item's `.platform` file as text. */
  async openPlatform(node: RepoNode): Promise<void> {
    if (node.kind === "item") {
      await vscode.window.showTextDocument(
        vscode.Uri.joinPath(node.uri, PLATFORM_FILE),
      );
    }
  }

  /**
   * Asks for a new display name and description and writes them to the
   * item's `.platform` as a workspace edit (undoable), then saves it. The
   * folder keeps its name; Fabric goes by `displayName`.
   */
  async editItemMetadata(node: RepoNode): Promise<void> {
    if (node.kind !== "item") {
      return;
    }
    const { item } = node;
    const displayName = await vscode.window.showInputBox({
      title: `Edit ${item.type} metadata (1/2)`,
      prompt: "Display name (metadata.displayName in .platform)",
      value: item.displayName,
      ignoreFocusOut: true,
      validateInput: (text) =>
        text.trim().length === 0 ? "Enter a display name" : undefined,
    });
    if (displayName === undefined) {
      return;
    }
    const description = await vscode.window.showInputBox({
      title: `Edit ${item.type} metadata (2/2)`,
      prompt: "Description (empty removes it)",
      value: item.description ?? "",
      ignoreFocusOut: true,
    });
    if (description === undefined) {
      return;
    }
    const uri = vscode.Uri.joinPath(node.uri, PLATFORM_FILE);
    // The open document, so unsaved changes to .platform are kept.
    const document = await vscode.workspace.openTextDocument(uri);
    const before = document.getText();
    const after = updatePlatform(before, { displayName, description });
    if (after === before) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(before.length),
      ),
      after,
    );
    if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save())) {
      throw new FabricConnectError(
        `Cannot edit item metadata: VS Code did not apply or save the change to '${this.relative(uri)}'.`,
        {
          operation: "edit item metadata",
          entity: `file ${this.relative(uri)}`,
          remediation:
            "Check that the file is writable and not open with a conflict, then try again (or edit it with Open .platform).",
        },
      );
    }
    this.refresh();
    void vscode.window.showInformationMessage(
      `Updated ${item.type} '${displayName.trim()}'. The folder '${path.basename(node.uri.fsPath)}' keeps its name; Fabric uses the display name.`,
    );
  }

  private relative(uri: vscode.Uri): string {
    return this.workspaceRoot === undefined
      ? uri.fsPath
      : path.relative(this.workspaceRoot, uri.fsPath);
  }
}

function runKindOf(node: RepoNode): RunKind | undefined {
  switch (node.kind) {
    case "item":
      return itemRunKind(node.item.type);
    default:
      return undefined;
  }
}

async function readDir(folder: vscode.Uri): Promise<DirEntry[]> {
  return (await vscode.workspace.fs.readDirectory(folder)).map(
    ([name, type]) => ({
      name,
      isDirectory: (type & vscode.FileType.Directory) !== 0,
    }),
  );
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}
