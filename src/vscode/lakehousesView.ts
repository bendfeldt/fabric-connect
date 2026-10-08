/**
 * Lakehouses view (Fabric side bar): attach Lakehouses to a notebook the
 * way the Fabric portal does. The target notebook is the active Fabric
 * notebook editor, or the notebook last selected in the Repo view.
 *
 * - Attached: the notebook's Lakehouses, the default first (starred).
 * - One group per workspace on the connected capacity, each listing its
 *   Lakehouses with Attach / Set as Default / Detach. Not connected → a
 *   prompt to connect instead of a list.
 *
 * Every action edits the notebook file's metadata (and saves it); the
 * extension never creates a Lakehouse (decision D3).
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { LakehouseError } from "../core/errors";
import {
  type NamedItem,
  type WorkspaceInfo,
  listLakehouses,
  listWorkspaces,
  findLakehousesByName,
  type LakehouseInWorkspace,
} from "../core/fabricCatalog";
import {
  type LakehouseAttachment,
  attachLakehouse,
  detachLakehouse,
} from "../core/notebookCodec";
import type { IFabricApiClient } from "../core/types";
import {
  type NotebookAttachments,
  type AttachmentSources,
  editAndSaveAttachments,
  readAttachments,
} from "./lakehouseAttachments";
import type { LakehouseBinding } from "../core/lakehouseBindings";
import type { LakehouseBindingStore } from "./lakehouseBindingStore";
import { isFabricNotebook } from "./notebookSerializer";
import { activeFabricNotebookUri } from "./activeNotebook";
import { isNotebookSourcePath } from "./notebookCellLens";
import { type OneLakeClient, browsableLakehouse } from "../core/oneLakeClient";
import {
  type ItemInfo,
  type OneLakeNode,
  listOneLakeChildren,
  oneLakeRoots,
  oneLakeTreeItem,
} from "./oneLakeNodes";

/** A Lakehouse row; the Repo view's notebook children have this shape too. */
export interface LakehouseNode {
  readonly kind: "lakehouse";
  readonly notebook: vscode.Uri;
  readonly lakehouse: LakehouseAttachment;
  readonly attached: boolean;
  readonly isDefault: boolean;
}

/** A notebook's declared default Lakehouse whose IDs are placeholders. */
export interface UnboundDefaultNode {
  readonly kind: "unboundDefault";
  readonly notebook: vscode.Uri;
  readonly name?: string;
  /** This machine's binding for it, when bound locally. */
  readonly binding?: LakehouseBinding;
}

type Node =
  | LakehouseNode
  | UnboundDefaultNode
  | OneLakeNode
  | { kind: "attachedGroup"; attachments: NotebookAttachments }
  | { kind: "workspace"; workspace: WorkspaceInfo; notebook: vscode.Uri }
  | { kind: "message"; label: string; command?: vscode.Command };

/** Name and workspace of a Lakehouse, as last listed. */
interface Known {
  readonly name: string;
  readonly workspaceId: string;
}

export class LakehousesView
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private target: vscode.Uri | undefined;
  /** Lakehouse ID (lower case) → name and workspace, from listings. */
  private readonly known = new Map<string, Known>();
  /** The last "Attached to this notebook" node shown, to refresh it alone. */
  private attachedGroup: Node | undefined;
  private readonly targetChanged = new vscode.EventEmitter<
    vscode.Uri | undefined
  >();
  /** Fires when the notebook the view edits changes. */
  readonly onDidChangeTarget = this.targetChanged.event;

  constructor(
    private readonly api: IFabricApiClient,
    private readonly tenant: () => Promise<string | undefined>,
    private readonly selectedCapacity: () => Promise<string | undefined>,
    private readonly bindings: LakehouseBindingStore,
    /** Logical IDs from the repo and this machine's bindings. */
    private readonly sources?: AttachmentSources,
    /** Lists a Lakehouse's Tables and Files when a row is expanded. */
    private readonly oneLake?: OneLakeClient,
  ) {
    this.disposables.push(
      this.targetChanged,
      vscode.window.onDidChangeActiveNotebookEditor((editor) => {
        if (editor !== undefined && isFabricNotebook(editor.notebook)) {
          this.setTarget(editor.notebook.uri);
        }
      }),
      // A notebook open as text (Open as Text).
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const uri = editor?.document.uri;
        if (
          uri !== undefined &&
          uri.scheme === "file" &&
          isNotebookSourcePath(uri.fsPath)
        ) {
          this.setTarget(uri);
        }
      }),
      // Its metadata saved from the text editor (or pulled from git).
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.toString() === this.target?.toString()) {
          this.refresh();
        }
      }),
      // Attachments edited elsewhere (the panel, undo, a save).
      vscode.workspace.onDidChangeNotebookDocument((e) => {
        if (
          e.metadata !== undefined &&
          e.notebook.uri.toString() === this.target?.toString()
        ) {
          this.refresh();
        }
      }),
    );
    this.target = activeFabricNotebookUri();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** The notebook the view edits. */
  currentTarget(): vscode.Uri | undefined {
    return this.target;
  }

  setTarget(notebook: vscode.Uri | undefined): void {
    if (notebook?.toString() === this.target?.toString()) {
      return;
    }
    this.target = notebook;
    this.targetChanged.fire(notebook);
    this.refresh();
  }

  /** The connected capacity; an invalid local.json connects none. */
  private async selectedCapacityOrNone(): Promise<string | undefined> {
    try {
      return await this.selectedCapacity();
    } catch {
      // The status bar and Configuration view report the invalid file.
      return undefined;
    }
  }

  /**
   * The Lakehouse as an item whose Tables and Files can be browsed, when
   * its workspace is known (older metadata may not name it).
   */
  private browsable(node: LakehouseNode): ItemInfo | undefined {
    return this.oneLake === undefined
      ? undefined
      : browsableLakehouse(
          node.lakehouse,
          this.known.get(node.lakehouse.id.toLowerCase()),
        );
  }

  /** The listed name of a Lakehouse, if this view has seen it. */
  nameOf(id: string): string | undefined {
    return this.known.get(id.toLowerCase())?.name;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const none = vscode.TreeItemCollapsibleState.None;
    switch (node.kind) {
      case "message": {
        const item = new vscode.TreeItem(node.label, none);
        item.command = node.command;
        return item;
      }
      case "attachedGroup": {
        const count = node.attachments.known.length;
        const item = new vscode.TreeItem(
          "Attached to this notebook",
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.description = count === 0 ? "none" : String(count);
        item.iconPath = new vscode.ThemeIcon("pinned");
        return item;
      }
      case "workspace": {
        const item = new vscode.TreeItem(
          node.workspace.displayName,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon("folder-library");
        return item;
      }
      case "lakehouse":
        return lakehouseTreeItem(
          node,
          this.nameOf(node.lakehouse.id),
          false,
          this.browsable(node) !== undefined,
        );
      case "onelake":
        return oneLakeTreeItem(node);
      case "unboundDefault":
        return unboundDefaultTreeItem(node, false);
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    try {
      return await this.children(node);
    } catch (error) {
      return [
        {
          kind: "message",
          label: `⚠ ${error instanceof Error ? error.message.split(" Next step:")[0] : String(error)}`,
        },
      ];
    }
  }

  private async children(node?: Node): Promise<Node[]> {
    const notebook = this.target;
    if (node === undefined) {
      if (notebook === undefined) {
        return [
          {
            kind: "message",
            label: "Open a Fabric notebook, or select one in Repo",
          },
        ];
      }
      const attachments = (await readAttachments(notebook, this.sources)) ?? {
        known: [],
      };
      const group: Node = { kind: "attachedGroup", attachments };
      this.attachedGroup = group;
      const nodes: Node[] = [group];
      const tenantId = await this.tenant();
      if (tenantId === undefined) {
        nodes.push({
          kind: "message",
          label: "Sign in to browse Lakehouses",
          command: { title: "Sign In", command: "fabric-connect.signIn" },
        });
        return nodes;
      }
      const capacityId = await this.selectedCapacityOrNone();
      if (capacityId === undefined) {
        nodes.push({
          kind: "message",
          label: "Connect to a capacity to see its Lakehouses",
          command: {
            title: "Connect to Compute",
            command: "fabric-connect.connectCompute",
          },
        });
        return nodes;
      }
      const workspaces = await listWorkspaces(this.api, tenantId, capacityId);
      if (workspaces.length === 0) {
        nodes.push({
          kind: "message",
          label: "No workspaces you can access are on the connected capacity",
        });
      }
      return [
        ...nodes,
        ...workspaces
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
          .map((workspace) => ({
            kind: "workspace" as const,
            workspace,
            notebook,
          })),
      ];
    }
    if (notebook === undefined) {
      return [];
    }
    if (node.kind === "attachedGroup") {
      return attachedNodes(notebook, node.attachments);
    }
    if (node.kind === "lakehouse") {
      const item = this.browsable(node);
      return item === undefined ? [] : oneLakeRoots(item);
    }
    if (node.kind === "onelake") {
      const tenantId = await this.tenant();
      return tenantId === undefined || this.oneLake === undefined
        ? []
        : listOneLakeChildren(this.oneLake, tenantId, node);
    }
    if (node.kind === "workspace") {
      const tenantId = await this.tenant();
      if (tenantId === undefined) {
        return [];
      }
      const [lakehouses, attachments] = await Promise.all([
        listLakehouses(this.api, tenantId, node.workspace.id),
        readAttachments(notebook, this.sources),
      ]);
      this.remember(lakehouses, node.workspace.id);
      if (lakehouses.length === 0) {
        return [{ kind: "message", label: "No Lakehouses in this workspace" }];
      }
      const attached = new Set(
        (attachments?.known ?? []).map((k) => k.id.toLowerCase()),
      );
      const defaultId = attachments?.defaultLakehouse?.id.toLowerCase();
      return lakehouses
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((lh) => ({
          kind: "lakehouse",
          notebook,
          lakehouse: {
            id: lh.id,
            name: lh.displayName,
            workspaceId: node.workspace.id,
          },
          attached:
            attached.has(lh.id.toLowerCase()) ||
            lh.id.toLowerCase() === defaultId,
          isDefault: lh.id.toLowerCase() === defaultId,
        }));
    }
    return [];
  }

  // --- actions -------------------------------------------------------------

  async attach(node: LakehouseNode): Promise<void> {
    const lakehouse = await this.complete(node.lakehouse);
    await editAndSaveAttachments(node.notebook, (root) =>
      attachLakehouse(root, lakehouse, false),
    );
    await this.dropBindingIfDefaultSet(node.notebook);
    this.refresh();
  }

  async setDefault(node: LakehouseNode): Promise<void> {
    const lakehouse = await this.complete(node.lakehouse);
    await editAndSaveAttachments(node.notebook, (root) =>
      attachLakehouse(root, lakehouse, true),
    );
    await this.dropBindingIfDefaultSet(node.notebook);
    this.refresh();
  }

  /**
   * Once the notebook's own metadata names a real default (a deliberate,
   * committed choice), this machine's binding for it is dropped, so the
   * notebook runs on what its file says.
   */
  private async dropBindingIfDefaultSet(notebook: vscode.Uri): Promise<void> {
    const binding = await this.bindings.get(notebook);
    if (binding === undefined) {
      return;
    }
    const attachments = await readAttachments(notebook, this.sources);
    if (attachments?.defaultLakehouse !== undefined) {
      await this.bindings.set(notebook, undefined);
      void vscode.window.showInformationMessage(
        `'${notebookName(notebook)}' now has its own default Lakehouse, so its binding on this machine ('${binding.lakehouseName ?? binding.lakehouseId}') was removed.`,
      );
    }
  }

  /**
   * Binds a notebook's unbound default Lakehouse by the name its metadata
   * keeps (as Fabric's Lakehouse auto-binding does): looks for Lakehouses
   * with that name in the connected capacity's workspaces and saves the one
   * picked as this notebook's binding on this machine (`.fabric/local.json`).
   * The notebook file is not changed, so binding causes no git diff and
   * Fabric's logical IDs stay in place. Never creates a Lakehouse.
   */
  async bindDefault(notebook?: vscode.Uri): Promise<void> {
    const target = notebook ?? this.target;
    if (target === undefined) {
      void vscode.window.showInformationMessage(
        "Open a Fabric notebook (or select one in Repo) first, then bind its Lakehouse.",
      );
      return;
    }
    const name = (await readAttachments(target, this.sources))?.unboundDefault
      ?.name;
    if (name === undefined) {
      void vscode.window.showInformationMessage(
        `'${notebookName(target)}' has no unbound default Lakehouse with a name to bind by. Pick a Lakehouse in the Lakehouses view.`,
      );
      return;
    }
    const tenantId = await this.tenant();
    const capacityId = await this.selectedCapacityOrNone();
    if (tenantId === undefined || capacityId === undefined) {
      throw new LakehouseError(
        `Cannot bind Lakehouse '${name}': no capacity is connected, so there are no workspaces to search.`,
        {
          operation: "bind default lakehouse",
          entity: `notebook ${notebookName(target)}`,
          remediation:
            "Connect to a capacity (Configuration → Compute), then try again.",
        },
      );
    }
    const matches = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Looking for Lakehouse '${name}'…`,
      },
      () => this.lakehousesNamed(tenantId, capacityId, name),
    );
    if (matches.length === 0) {
      void vscode.window.showWarningMessage(
        `No Lakehouse named '${name}' is in a workspace on the connected capacity. Pick another Lakehouse in the Lakehouses view, or connect the capacity that holds it.`,
      );
      return;
    }
    let chosen: LakehouseInWorkspace | undefined;
    if (matches.length === 1) {
      const bind = "Bind";
      const answer = await vscode.window.showInformationMessage(
        `Bind '${notebookName(target)}' to Lakehouse '${matches[0].lakehouse.displayName}' in workspace '${matches[0].workspace.displayName}'? Saved on this machine only (.fabric/local.json); the notebook file is not changed.`,
        { modal: true },
        bind,
      );
      chosen = answer === bind ? matches[0] : undefined;
    } else {
      chosen = (
        await vscode.window.showQuickPick(
          matches.map((m) => ({
            label: m.lakehouse.displayName,
            description: m.workspace.displayName,
            match: m,
          })),
          {
            title: `${matches.length} Lakehouses are named '${name}'`,
            placeHolder: "Pick the workspace whose Lakehouse to bind",
            ignoreFocusOut: true,
          },
        )
      )?.match;
    }
    if (chosen === undefined) {
      return;
    }
    await this.bindings.set(target, {
      lakehouseId: chosen.lakehouse.id,
      workspaceId: chosen.workspace.id,
      lakehouseName: chosen.lakehouse.displayName,
      workspaceName: chosen.workspace.displayName,
    });
    this.refresh();
  }

  /** Removes this machine's binding for the notebook. */
  async unbindDefault(notebook?: vscode.Uri): Promise<void> {
    const target = notebook ?? this.target;
    if (
      target === undefined ||
      (await this.bindings.get(target)) === undefined
    ) {
      return;
    }
    await this.bindings.set(target, undefined);
    this.refresh();
  }

  /** Lakehouses with this name in the capacity's workspaces. */
  private async lakehousesNamed(
    tenantId: string,
    capacityId: string,
    name: string,
  ): Promise<LakehouseInWorkspace[]> {
    const workspaces = await listWorkspaces(this.api, tenantId, capacityId);
    const lists = await Promise.all(
      workspaces.map((w) => listLakehouses(this.api, tenantId, w.id)),
    );
    const candidates = workspaces.flatMap((workspace, i) => {
      this.remember(lists[i], workspace.id);
      return lists[i].map((lakehouse) => ({ lakehouse, workspace }));
    });
    return findLakehousesByName(name, candidates);
  }

  async detach(node: LakehouseNode): Promise<void> {
    await editAndSaveAttachments(node.notebook, (root) =>
      detachLakehouse(root, node.lakehouse.id),
    );
    this.refresh();
    if (node.isDefault) {
      void vscode.window.showInformationMessage(
        `Detached the default Lakehouse from '${notebookName(node.notebook)}'. Set another attached Lakehouse as default; until then the notebook runs on the connected compute's Lakehouse.`,
      );
    }
  }

  /**
   * Adds the name and workspace a default needs (Fabric writes both). An
   * attached Lakehouse only carries its ID, so it is looked up in the
   * listings, then in every workspace on the connected capacity.
   */
  private async complete(
    lakehouse: LakehouseAttachment,
  ): Promise<LakehouseAttachment> {
    if (lakehouse.name !== undefined && lakehouse.workspaceId !== undefined) {
      return lakehouse;
    }
    const id = lakehouse.id.toLowerCase();
    let known = this.known.get(id);
    const tenantId = await this.tenant();
    const capacityId = await this.selectedCapacityOrNone();
    if (
      known === undefined &&
      tenantId !== undefined &&
      capacityId !== undefined
    ) {
      for (const workspace of await listWorkspaces(
        this.api,
        tenantId,
        capacityId,
      )) {
        this.remember(
          await listLakehouses(this.api, tenantId, workspace.id),
          workspace.id,
        );
        known = this.known.get(id);
        if (known !== undefined) {
          break;
        }
      }
    }
    if (known === undefined) {
      throw new LakehouseError(
        "Cannot set the default Lakehouse: it is not in any workspace on the connected capacity.",
        {
          operation: "set default lakehouse",
          entity: `lakehouse ${lakehouse.id}`,
          remediation:
            "Connect the capacity whose workspace holds it, or detach it and attach a Lakehouse listed in the Lakehouses view.",
        },
      );
    }
    return {
      id: lakehouse.id,
      name: known.name,
      workspaceId: known.workspaceId,
    };
  }

  private remember(lakehouses: NamedItem[], workspaceId: string): void {
    const group = this.attachedGroup;
    const attachments =
      group?.kind === "attachedGroup" ? group.attachments : undefined;
    const attached = new Set(
      [
        ...(attachments?.known ?? []),
        ...(attachments?.defaultLakehouse === undefined
          ? []
          : [attachments.defaultLakehouse]),
      ].map((lakehouse) => lakehouse.id.toLowerCase()),
    );
    let learned = false;
    for (const lh of lakehouses) {
      const id = lh.id.toLowerCase();
      learned ||= attached.has(id) && !this.known.has(id);
      this.known.set(id, { name: lh.displayName, workspaceId });
    }
    if (learned) {
      // Attached rows whose workspace the metadata does not name become
      // browsable now: refresh just that group, not the expanded workspace.
      this.changed.fire(group);
    }
  }
}

/**
 * The attached Lakehouses of a notebook, the default first; an unbound
 * default (placeholder IDs) comes first as a warning row.
 */
export function attachedNodes(
  notebook: vscode.Uri,
  attachments: NotebookAttachments,
): Array<LakehouseNode | UnboundDefaultNode> {
  const defaultId = attachments.defaultLakehouse?.id.toLowerCase();
  const nodes: Array<LakehouseNode | UnboundDefaultNode> = [];
  // A local binding is what runs, so it is shown even if the notebook's
  // metadata changed underneath it (e.g. after a git pull).
  if (
    attachments.unboundDefault !== undefined ||
    attachments.localBinding !== undefined
  ) {
    const name =
      attachments.unboundDefault?.name ??
      attachments.localBinding?.lakehouseName;
    nodes.push({
      kind: "unboundDefault",
      notebook,
      ...(name === undefined ? {} : { name }),
      ...(attachments.localBinding === undefined
        ? {}
        : { binding: attachments.localBinding }),
    });
  }
  if (attachments.defaultLakehouse !== undefined) {
    nodes.push({
      kind: "lakehouse",
      notebook,
      lakehouse: attachments.defaultLakehouse,
      attached: true,
      isDefault: true,
    });
  }
  for (const known of attachments.known) {
    if (known.id.toLowerCase() !== defaultId) {
      nodes.push({
        kind: "lakehouse",
        notebook,
        lakehouse: known,
        attached: true,
        isDefault: false,
      });
    }
  }
  return nodes;
}

/**
 * A Lakehouse row: starred when default, checked when attached. Read-only
 * rows (Repo) show the state without actions; changes happen in the
 * Lakehouses view.
 */
export function lakehouseTreeItem(
  node: LakehouseNode,
  listedName: string | undefined,
  readOnly = false,
  /** Expands into its OneLake Tables and Files (Lakehouses view only). */
  expandable = false,
): vscode.TreeItem {
  const name =
    node.lakehouse.name ??
    listedName ??
    `Lakehouse ${node.lakehouse.id.slice(0, 8)}`;
  const item = new vscode.TreeItem(
    name,
    expandable
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
  );
  item.description = node.isDefault
    ? "default"
    : node.attached
      ? "attached"
      : undefined;
  item.iconPath = node.isDefault
    ? new vscode.ThemeIcon("star-full", new vscode.ThemeColor("charts.yellow"))
    : node.attached
      ? new vscode.ThemeIcon("check")
      : new vscode.ThemeIcon("database");
  item.tooltip = node.isDefault
    ? `Default Lakehouse of ${notebookName(node.notebook)}: Spark SQL and relative paths resolve against it.`
    : node.attached
      ? `Attached to ${notebookName(node.notebook)}.`
      : `Not attached to ${notebookName(node.notebook)}.`;
  if (readOnly) {
    item.tooltip += " Manage it in the Lakehouses view.";
    item.contextValue = "fabricRepoLakehouse";
    return item;
  }
  item.contextValue = [
    "fabricLakehouse",
    node.attached ? "attached" : "",
    node.isDefault ? "default" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return item;
}

/** A warning row: the notebook's default Lakehouse is not bound here. */
export function unboundDefaultTreeItem(
  node: UnboundDefaultNode,
  inRepo: boolean,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.name ?? "Default Lakehouse",
    vscode.TreeItemCollapsibleState.None,
  );
  if (node.binding !== undefined) {
    const where = node.binding.workspaceName ?? node.binding.workspaceId;
    item.description = `default · bound on this machine · ${where}`;
    item.iconPath = new vscode.ThemeIcon(
      "link",
      new vscode.ThemeColor("charts.green"),
    );
    item.tooltip = `${notebookName(node.notebook)} runs on Lakehouse '${node.binding.lakehouseName ?? node.binding.lakehouseId}' in workspace '${where}' on this machine. The binding is saved in .fabric/local.json (gitignored); the notebook file is unchanged.${inRepo ? "" : " Unbind it with the button."}`;
    item.contextValue = "fabricBoundLakehouse";
    return item;
  }
  item.description = inRepo
    ? "default · not bound"
    : "default · not bound — bind it (link button) or set a default below";
  item.iconPath = new vscode.ThemeIcon(
    "warning",
    new vscode.ThemeColor("list.warningForeground"),
  );
  item.tooltip = `${notebookName(node.notebook)} declares this default Lakehouse with placeholder IDs, as Fabric stores attached Lakehouses in git. It cannot run until bound: Bind Lakehouse… finds it by name on the connected capacity and binds it on this machine only (no change to the notebook file); Set as Default writes a Lakehouse into the notebook instead.`;
  item.contextValue = "fabricUnboundLakehouse";
  return item;
}

/** The notebook's item folder name (`Bronze.Notebook`), else its file name. */
function notebookName(uri: vscode.Uri): string {
  const folder = path.basename(path.dirname(uri.fsPath));
  return folder.endsWith(".Notebook") ? folder : path.basename(uri.fsPath);
}
