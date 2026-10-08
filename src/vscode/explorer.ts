/**
 * Read-only Fabric explorer: capacities → workspaces → items by type;
 * capacities include those only known from a workspace's `capacityId`
 * (see `capacitiesFromWorkspaces`), and the connected capacity is checked,
 * expanded and its workspaces highlighted;
 * Lakehouses expand into their OneLake `Files` and `Tables`; plus the
 * tenant's connections. Every call is a GET (or the allowlisted
 * getDefinition read); nothing here changes a workspace.
 *
 * The whole tree is the "Fabric" view in VS Code's Explorer side bar; the
 * Fabric Activity Bar container shows its parts as separate views (see
 * `ExplorerRoot`).
 *
 * Actions: copy ID / name / OneLake path / SQL connection string, preview a
 * table (on the connected compute) or a file, pull an item into the repo,
 * open it in the Fabric portal.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ComputeProfile, HostedCompute } from "../core/computeProfile";
import { extractDisplays } from "../core/displayProtocol";
import { ExplorerError } from "../core/errors";
import {
  type CapacityInfo,
  type WorkspaceInfo,
  capacitiesFromWorkspaces,
  listAll,
  listCapacities,
  listPowerBiCapacities,
  listWorkspaces,
  mergeCapacities,
} from "../core/fabricCatalog";
import { getItemDefinition, itemFolderName } from "../core/itemDefinition";
import type { ILivySessionManager } from "../core/livySessionManager";
import type { NameCache } from "../core/nameCache";
import { type OneLakeClient, abfssUri } from "../core/oneLakeClient";
import type { IFabricApiClient } from "../core/types";
import {
  type ItemInfo,
  ONELAKE_ITEMS,
  type OneLakeNode,
  listOneLakeChildren,
  oneLakeRoots,
  oneLakeTreeItem,
} from "./oneLakeNodes";
import type { ResultsPanel } from "./resultsPanel";

type Node =
  | { kind: "message"; label: string; command?: vscode.Command }
  | { kind: "group"; group: "capacities" | "unassigned" | "connections" }
  | { kind: "capacity"; capacity: CapacityInfo; selected: boolean }
  | {
      kind: "workspace";
      workspace: WorkspaceInfo;
      /** On the connected capacity. */
      onSelected?: boolean;
    }
  | {
      kind: "typeGroup";
      workspace: WorkspaceInfo;
      type: string;
      items: ItemInfo[];
    }
  | { kind: "item"; item: ItemInfo }
  | OneLakeNode
  | { kind: "connection"; label: string; description: string; id: string };

/**
 * What a view shows at the top: the whole tree, or just the connections.
 */
export type ExplorerRoot = "all" | "connections";

/** Item types with a SQL connection string. */
const SQL_ITEMS = new Set(["Lakehouse", "Warehouse", "SQLEndpoint"]);
const PREVIEW_BYTES = 64 * 1024;

export class FabricExplorer
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private workspaces: WorkspaceInfo[] | undefined;
  private capacities: CapacityInfo[] | undefined;
  private tenantId: string | undefined;

  constructor(
    private readonly api: IFabricApiClient,
    private readonly oneLake: OneLakeClient,
    private readonly livy: ILivySessionManager,
    private readonly compute: () => Promise<ComputeProfile | undefined>,
    /** The tenant the user selected with 'Fabric: Sign In', if any. */
    private readonly selectedTenant: () => string | undefined,
    private readonly names: NameCache,
    private readonly results: ResultsPanel,
    private readonly workspaceRoot: string | undefined,
    /** The connected capacity, if any. */
    private readonly selectedCapacity: () => Promise<string | undefined>,
    /** The compute with its host Lakehouse, asked for when missing. */
    private readonly requireHost: () => Promise<HostedCompute>,
    private readonly root: ExplorerRoot = "all",
  ) {}

  dispose(): void {
    this.changed.dispose();
  }

  refresh(): void {
    this.workspaces = undefined;
    this.capacities = undefined;
    this.tenantId = undefined;
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const none = vscode.TreeItemCollapsibleState.None;
    switch (node.kind) {
      case "message": {
        const item = new vscode.TreeItem(node.label, none);
        item.command = node.command;
        return item;
      }
      case "group": {
        const labels = {
          capacities: "Capacities",
          unassigned: "Workspaces without a capacity",
          connections: "Connections",
        };
        return new vscode.TreeItem(labels[node.group], collapsed);
      }
      case "capacity": {
        const { capacity } = node;
        const item = new vscode.TreeItem(
          capacity.displayName,
          node.selected ? vscode.TreeItemCollapsibleState.Expanded : collapsed,
        );
        // A new id when selection changes, so the expanded state applies.
        item.id = `capacity:${capacity.id}:${node.selected ? "selected" : ""}`;
        const unknown = capacity.state === "Unknown";
        item.description = [
          capacity.sku,
          capacity.region,
          unknown ? "details not visible to you" : capacity.state,
          node.selected ? "connected" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        item.tooltip = unknown
          ? "Your workspaces run on this capacity. Its SKU, region and state need rights on the capacity itself."
          : undefined;
        item.iconPath = node.selected
          ? new vscode.ThemeIcon(
              "pass-filled",
              new vscode.ThemeColor("charts.green"),
            )
          : new vscode.ThemeIcon(
              capacity.state === "Active" || unknown
                ? "server-environment"
                : "debug-pause",
            );
        item.contextValue = node.selected
          ? "fabricCapacity selected"
          : "fabricCapacity";
        return item;
      }
      case "workspace": {
        const item = new vscode.TreeItem(node.workspace.displayName, collapsed);
        item.description = node.onSelected
          ? "on connected capacity"
          : undefined;
        item.iconPath = node.onSelected
          ? new vscode.ThemeIcon(
              "folder-library",
              new vscode.ThemeColor("charts.green"),
            )
          : new vscode.ThemeIcon("folder-library");
        item.contextValue =
          node.workspace.capacityId === undefined
            ? "fabricWorkspace"
            : "fabricWorkspace onCapacity";
        return item;
      }
      case "typeGroup": {
        const item = new vscode.TreeItem(node.type, collapsed);
        item.description = String(node.items.length);
        return item;
      }
      case "item": {
        const item = new vscode.TreeItem(
          node.item.displayName,
          ONELAKE_ITEMS.has(node.item.type) ? collapsed : none,
        );
        item.description = node.item.type;
        item.tooltip = `${node.item.type} in ${node.item.workspaceName}`;
        item.iconPath = new vscode.ThemeIcon(iconFor(node.item.type));
        item.contextValue = [
          "fabricItem",
          SQL_ITEMS.has(node.item.type) ? "sql" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return item;
      }
      case "onelake":
        return oneLakeTreeItem(node);
      case "connection": {
        const item = new vscode.TreeItem(node.label, none);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon("plug");
        item.contextValue = "fabricConnection";
        return item;
      }
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
    if (node === undefined) {
      const tenantId = await this.tenant();
      if (tenantId === undefined) {
        return [
          {
            kind: "message",
            label: "Sign in to browse Fabric",
            command: {
              title: "Sign In",
              command: "fabric-connect.signIn",
            },
          },
        ];
      }
      switch (this.root) {
        case "all":
          return [
            { kind: "group", group: "capacities" },
            { kind: "group", group: "unassigned" },
            { kind: "group", group: "connections" },
          ];
        default:
          return this.children({ kind: "group", group: this.root });
      }
    }
    const tenantId = await this.tenant();
    if (tenantId === undefined) {
      return [];
    }
    switch (node.kind) {
      case "group": {
        if (node.group === "capacities") {
          // Fetched on every expand, so a paused or resumed capacity shows
          // its current state.
          const capacities = await this.allCapacities(tenantId, true);
          const selected = await this.selectedCapacityLower();
          return capacities.map((capacity) => ({
            kind: "capacity",
            capacity,
            selected: capacity.id.toLowerCase() === selected,
          }));
        }
        if (node.group === "unassigned") {
          return (await this.allWorkspaces(tenantId))
            .filter((w) => w.capacityId === undefined)
            .map((workspace) => ({ kind: "workspace", workspace }));
        }
        const connections = await listAll<Record<string, unknown>>(
          this.api,
          tenantId,
          "/connections",
        );
        return connections.map((c) => {
          const details = (c["connectionDetails"] ?? {}) as Record<
            string,
            unknown
          >;
          return {
            kind: "connection" as const,
            id: String(c["id"] ?? ""),
            label: String(c["displayName"] ?? c["id"] ?? "connection"),
            description: [c["connectivityType"], details["type"]]
              .filter((v) => typeof v === "string")
              .join(" · "),
          };
        });
      }
      case "capacity":
        return (await this.allWorkspaces(tenantId))
          .filter(
            (w) =>
              w.capacityId?.toLowerCase() === node.capacity.id.toLowerCase(),
          )
          .map((workspace) => ({
            kind: "workspace",
            workspace,
            onSelected: node.selected,
          }));
      case "workspace": {
        const raw = await listAll<Record<string, unknown>>(
          this.api,
          tenantId,
          `/workspaces/${node.workspace.id}/items`,
        );
        const items: ItemInfo[] = raw.flatMap((i) =>
          typeof i["id"] === "string" && typeof i["type"] === "string"
            ? [
                {
                  id: i["id"],
                  displayName:
                    typeof i["displayName"] === "string"
                      ? i["displayName"]
                      : i["id"],
                  type: i["type"],
                  workspaceId: node.workspace.id,
                  workspaceName: node.workspace.displayName,
                },
              ]
            : [],
        );
        const byType = new Map<string, ItemInfo[]>();
        for (const item of items) {
          this.names.remember(item.id, {
            kind: "item",
            displayName: item.displayName,
            type: item.type,
            workspaceName: item.workspaceName,
          });
          byType.set(item.type, [...(byType.get(item.type) ?? []), item]);
        }
        return [...byType.keys()].sort().map((type) => ({
          kind: "typeGroup",
          workspace: node.workspace,
          type,
          items: (byType.get(type) ?? []).sort((a, b) =>
            a.displayName.localeCompare(b.displayName),
          ),
        }));
      }
      case "typeGroup":
        return node.items.map((item) => ({ kind: "item", item }));
      case "item":
        return ONELAKE_ITEMS.has(node.item.type) ? oneLakeRoots(node.item) : [];
      case "onelake":
        return listOneLakeChildren(this.oneLake, tenantId, node);
      default:
        return [];
    }
  }

  // --- actions -------------------------------------------------------------

  async copyId(node: Node): Promise<void> {
    const id =
      node.kind === "item"
        ? node.item.id
        : node.kind === "workspace"
          ? node.workspace.id
          : node.kind === "capacity"
            ? node.capacity.id
            : node.kind === "connection"
              ? node.id
              : undefined;
    if (id !== undefined) {
      await vscode.env.clipboard.writeText(id);
    }
  }

  async copyName(node: Node): Promise<void> {
    const item = this.getTreeItem(node);
    await vscode.env.clipboard.writeText(String(item.label ?? ""));
  }

  async copyOneLakePath(node: Node): Promise<void> {
    if (node.kind === "onelake") {
      await vscode.env.clipboard.writeText(
        abfssUri(node.item.workspaceId, node.item.id, node.path),
      );
    } else if (node.kind === "item") {
      await vscode.env.clipboard.writeText(
        abfssUri(node.item.workspaceId, node.item.id, ""),
      );
    }
  }

  async copySqlConnectionString(node: Node): Promise<void> {
    if (node.kind !== "item" || !SQL_ITEMS.has(node.item.type)) {
      return;
    }
    const tenantId = await this.requireTenant();
    const collection =
      node.item.type === "Lakehouse"
        ? "lakehouses"
        : node.item.type === "Warehouse"
          ? "warehouses"
          : "sqlEndpoints";
    const response = await this.api.request<{
      properties?: Record<string, unknown>;
    }>({
      method: "GET",
      path: `/workspaces/${node.item.workspaceId}/${collection}/${node.item.id}`,
      tenantId,
    });
    const properties = response.body?.properties ?? {};
    const sql = properties["sqlEndpointProperties"] as
      | Record<string, unknown>
      | undefined;
    const connection =
      properties["connectionString"] ?? sql?.["connectionString"];
    if (typeof connection !== "string") {
      throw new ExplorerError(
        `No SQL connection string is available for '${node.item.displayName}'.`,
        {
          operation: "copy SQL connection string",
          entity: `${node.item.type} ${node.item.displayName}`,
          remediation:
            "The SQL endpoint may still be provisioning; try again in a minute.",
        },
      );
    }
    await vscode.env.clipboard.writeText(connection);
    void vscode.window.showInformationMessage(
      `Copied the SQL connection string of '${node.item.displayName}'. Use it with the mssql extension (database: ${node.item.displayName}).`,
    );
  }

  async openInFabric(node: Node): Promise<void> {
    const workspaceId =
      node.kind === "item"
        ? node.item.workspaceId
        : node.kind === "workspace"
          ? node.workspace.id
          : undefined;
    if (workspaceId !== undefined) {
      await vscode.env.openExternal(
        vscode.Uri.parse(
          `https://app.fabric.microsoft.com/groups/${workspaceId}`,
        ),
      );
    }
  }

  /** Shows the first rows of a Delta table, read on the connected compute. */
  async previewTable(node: Node): Promise<void> {
    if (node.kind !== "onelake" || !node.isTable) {
      return;
    }
    // Previews run on the connected capacity's host Lakehouse; one is
    // asked for when none is picked yet.
    const compute = await this.requireHost();
    const uri = abfssUri(node.item.workspaceId, node.item.id, node.path);
    const code = `display(spark.read.format("delta").load(${JSON.stringify(uri)}).limit(100))`;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Reading ${node.path}…`,
        cancellable: true,
      },
      (_p, token) =>
        this.livy.execute(
          {
            tenantId: compute.tenantId,
            workspaceId: compute.workspaceId,
            lakehouseId: compute.lakehouseId,
            ...(compute.environmentId === undefined
              ? {}
              : { environmentId: compute.environmentId }),
          },
          code,
          "pyspark",
          token,
        ),
    );
    if (result.status === "error") {
      throw new ExplorerError(
        `Reading '${node.path}' failed: ${result.errorName ?? "Error"}: ${result.errorValue ?? ""}`,
        {
          operation: "preview table",
          entity: `table ${node.path}`,
          remediation:
            "Check that the connected compute can read this Lakehouse.",
        },
      );
    }
    if (result.status === "cancelled") {
      return;
    }
    const plain = result.data?.["text/plain"];
    const { tables } = extractDisplays(typeof plain === "string" ? plain : "");
    this.results.show(
      node.path.split("/").pop() ?? node.path,
      `${node.item.displayName} · first 100 rows`,
      tables,
    );
  }

  /** Opens the start of a OneLake file as an untitled, read-only preview. */
  async previewFile(node: Node): Promise<void> {
    if (node.kind !== "onelake" || node.isDirectory) {
      return;
    }
    const tenantId = await this.requireTenant();
    const data = await this.oneLake.readHead(
      { tenantId, workspaceId: node.item.workspaceId, itemId: node.item.id },
      node.path,
      PREVIEW_BYTES,
    );
    if (data.subarray(0, 4096).includes(0)) {
      void vscode.window.showInformationMessage(
        `'${node.path}' is a binary file; preview it with Spark (e.g. a notebook cell) instead.`,
      );
      return;
    }
    const document = await vscode.workspace.openTextDocument({
      content: new TextDecoder().decode(data),
    });
    await vscode.window.showTextDocument(document, { preview: true });
    if (data.length >= PREVIEW_BYTES) {
      void vscode.window.showInformationMessage(
        `Showing the first ${PREVIEW_BYTES / 1024} KB of '${node.path}'.`,
      );
    }
  }

  /** Clones an item's definition into the repo; never overwrites. */
  async pullItem(node: Node): Promise<void> {
    if (node.kind !== "item") {
      return;
    }
    const tenantId = await this.requireTenant();
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Pull here",
      ...(this.workspaceRoot === undefined
        ? {}
        : { defaultUri: vscode.Uri.file(this.workspaceRoot) }),
    });
    const parent = picked?.[0]?.fsPath;
    if (parent === undefined) {
      return;
    }
    const folder = path.join(
      parent,
      itemFolderName(node.item.displayName, node.item.type),
    );
    if (await exists(folder)) {
      throw new ExplorerError(
        `Cannot pull '${node.item.displayName}': '${path.basename(folder)}' already exists here.`,
        {
          operation: "pull item",
          entity: `folder ${folder}`,
          remediation:
            "Local is the source of truth: pick another folder, or delete/rename the existing one first.",
        },
      );
    }
    const parts = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pulling ${node.item.displayName}…`,
      },
      () =>
        getItemDefinition(
          this.api,
          tenantId,
          node.item.workspaceId,
          node.item.id,
        ),
    );
    await fs.mkdir(folder, { recursive: true });
    for (const part of parts) {
      const target = path.join(folder, ...part.path.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, part.data);
    }
    if (!parts.some((p) => p.path === ".platform")) {
      await fs.writeFile(
        path.join(folder, ".platform"),
        JSON.stringify(
          {
            $schema:
              "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
            metadata: {
              type: node.item.type,
              displayName: node.item.displayName,
            },
            config: { version: "2.0", logicalId: crypto.randomUUID() },
          },
          undefined,
          2,
        ) + "\n",
      );
    }
    void vscode.window.showInformationMessage(
      `Pulled '${node.item.displayName}' into ${path.relative(this.workspaceRoot ?? parent, folder) || folder} (${parts.length} file${parts.length === 1 ? "" : "s"}). It is local now; nothing syncs back.`,
    );
  }

  // --- helpers -----------------------------------------------------------------

  private async tenant(): Promise<string | undefined> {
    if (this.tenantId === undefined) {
      // The tenant the user selected wins; the compute connection's tenant
      // is the fallback before anything has been selected.
      this.tenantId = this.selectedTenant() ?? (await this.compute())?.tenantId;
    }
    return this.tenantId;
  }

  private async requireTenant(): Promise<string> {
    const tenantId = await this.tenant();
    if (tenantId === undefined) {
      throw new ExplorerError("No tenant is signed in.", {
        operation: "browse Fabric",
        remediation: "Run 'Fabric: Sign In' or 'Fabric: Connect to Compute'.",
      });
    }
    return tenantId;
  }

  /**
   * Listed capacities (Fabric and Power BI) plus those behind the user's
   * workspaces. Not being
   * allowed to list capacities is normal for workspace members: those
   * capacities then come from the workspaces alone.
   */
  private async allCapacities(
    tenantId: string,
    fresh = false,
  ): Promise<CapacityInfo[]> {
    if (this.capacities === undefined || fresh) {
      const none = (): CapacityInfo[] => [];
      const [fabric, powerBi, workspaces] = await Promise.all([
        listCapacities(this.api, tenantId).catch(none),
        listPowerBiCapacities(this.api, tenantId).catch(none),
        this.allWorkspaces(tenantId),
      ]);
      this.capacities = capacitiesFromWorkspaces(
        workspaces,
        mergeCapacities(fabric, powerBi),
      );
      for (const c of this.capacities) {
        this.names.remember(c.id, {
          kind: "capacity",
          displayName: c.displayName,
          type: c.sku,
        });
      }
    }
    return this.capacities;
  }

  /** The connected capacity's ID in lower case; an invalid local.json connects none. */
  private async selectedCapacityLower(): Promise<string | undefined> {
    try {
      return (await this.selectedCapacity())?.toLowerCase();
    } catch {
      // The Configuration view and status bar report the invalid file.
      return undefined;
    }
  }

  /**
   * The capacity a node stands for: the capacity itself, or the one a
   * workspace runs on.
   */
  async capacityOf(node: Node): Promise<CapacityInfo | undefined> {
    if (node.kind === "capacity") {
      return node.capacity;
    }
    const id =
      node.kind === "workspace"
        ? node.workspace.capacityId?.toLowerCase()
        : undefined;
    const tenantId = await this.tenant();
    if (id === undefined || tenantId === undefined) {
      return undefined;
    }
    return (await this.allCapacities(tenantId)).find(
      (c) => c.id.toLowerCase() === id,
    );
  }

  private async allWorkspaces(tenantId: string): Promise<WorkspaceInfo[]> {
    if (this.workspaces === undefined) {
      this.workspaces = await listWorkspaces(this.api, tenantId);
      for (const w of this.workspaces) {
        this.names.remember(w.id, {
          kind: "workspace",
          displayName: w.displayName,
        });
      }
    }
    return this.workspaces;
  }
}

function iconFor(type: string): string {
  switch (type) {
    case "Notebook":
      return "notebook";
    case "Lakehouse":
      return "database";
    case "Warehouse":
    case "SQLEndpoint":
    case "SQLDatabase":
      return "server";
    case "SemanticModel":
      return "graph";
    case "Report":
      return "graph-line";
    case "DataPipeline":
      return "workflow";
    case "Environment":
      return "settings";
    case "SparkJobDefinition":
      return "run-all";
    case "KQLDatabase":
    case "Eventhouse":
      return "pulse";
    default:
      return "symbol-misc";
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}
