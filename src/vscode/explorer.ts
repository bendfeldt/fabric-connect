/**
 * Read-only Fabric explorer (in VS Code's Explorer side bar): capacities →
 * workspaces → items by type; Lakehouses expand into their OneLake `Files`
 * and `Tables`; plus the tenant's connections. Every call is a GET (or the
 * allowlisted getDefinition read); nothing here changes a workspace.
 *
 * Actions: copy ID / name / OneLake path / SQL connection string, preview a
 * table (on the connected compute) or a file, pull an item into the repo,
 * open it in the Fabric portal.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ComputeProfile } from "../core/computeProfile";
import { extractDisplays } from "../core/displayProtocol";
import { ExplorerError } from "../core/errors";
import {
  type CapacityInfo,
  type WorkspaceInfo,
  listAll,
  listCapacities,
  listWorkspaces,
} from "../core/fabricCatalog";
import { getItemDefinition, itemFolderName } from "../core/itemDefinition";
import type { ILivySessionManager } from "../core/livySessionManager";
import type { NameCache } from "../core/nameCache";
import { type OneLakeClient, abfssUri } from "../core/oneLakeClient";
import type { IFabricApiClient } from "../core/types";
import type { ResultsPanel } from "./resultsPanel";

interface ItemInfo {
  readonly id: string;
  readonly displayName: string;
  readonly type: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
}

type Node =
  | { kind: "message"; label: string; command?: vscode.Command }
  | { kind: "group"; group: "capacities" | "unassigned" | "connections" }
  | { kind: "capacity"; capacity: CapacityInfo }
  | { kind: "workspace"; workspace: WorkspaceInfo }
  | {
      kind: "typeGroup";
      workspace: WorkspaceInfo;
      type: string;
      items: ItemInfo[];
    }
  | { kind: "item"; item: ItemInfo }
  | {
      kind: "onelake";
      item: ItemInfo;
      path: string;
      isDirectory: boolean;
      isTable: boolean;
    }
  | { kind: "connection"; label: string; description: string; id: string };

/** Item types that expand into OneLake Files/Tables. */
const ONELAKE_ITEMS = new Set(["Lakehouse"]);
/** Item types with a SQL connection string. */
const SQL_ITEMS = new Set(["Lakehouse", "Warehouse", "SQLEndpoint"]);
const PREVIEW_BYTES = 64 * 1024;

export class FabricExplorer
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private workspaces: WorkspaceInfo[] | undefined;
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
  ) {}

  dispose(): void {
    this.changed.dispose();
  }

  refresh(): void {
    this.workspaces = undefined;
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
        const item = new vscode.TreeItem(node.capacity.displayName, collapsed);
        item.description = [
          node.capacity.sku,
          node.capacity.region,
          node.capacity.state,
        ]
          .filter(Boolean)
          .join(" · ");
        item.iconPath = new vscode.ThemeIcon(
          node.capacity.state === "Active"
            ? "server-environment"
            : "debug-pause",
        );
        item.contextValue = "fabricCapacity";
        return item;
      }
      case "workspace": {
        const item = new vscode.TreeItem(node.workspace.displayName, collapsed);
        item.iconPath = new vscode.ThemeIcon("folder-library");
        item.contextValue = "fabricWorkspace";
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
      case "onelake": {
        const name = node.path.split("/").pop() ?? node.path;
        // Table folders stay expandable: in schema-enabled Lakehouses the
        // first level under Tables/ is a schema that holds the tables.
        const item = new vscode.TreeItem(
          name,
          node.isDirectory ? collapsed : none,
        );
        item.iconPath = new vscode.ThemeIcon(
          node.isTable ? "table" : node.isDirectory ? "folder" : "file",
        );
        item.contextValue = node.isTable
          ? "fabricTable"
          : node.isDirectory
            ? "fabricFolder"
            : "fabricFile";
        return item;
      }
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
      return [
        { kind: "group", group: "capacities" },
        { kind: "group", group: "unassigned" },
        { kind: "group", group: "connections" },
      ];
    }
    const tenantId = await this.tenant();
    if (tenantId === undefined) {
      return [];
    }
    switch (node.kind) {
      case "group": {
        if (node.group === "capacities") {
          const capacities = await listCapacities(this.api, tenantId);
          for (const c of capacities) {
            this.names.remember(c.id, {
              kind: "capacity",
              displayName: c.displayName,
              type: c.sku,
            });
          }
          return capacities.map((capacity) => ({ kind: "capacity", capacity }));
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
          .map((workspace) => ({ kind: "workspace", workspace }));
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
        return ONELAKE_ITEMS.has(node.item.type)
          ? [
              {
                kind: "onelake",
                item: node.item,
                path: "Files",
                isDirectory: true,
                isTable: false,
              },
              {
                kind: "onelake",
                item: node.item,
                path: "Tables",
                isDirectory: true,
                isTable: false,
              },
            ]
          : [];
      case "onelake": {
        const entries = await this.oneLake.list(
          {
            tenantId,
            workspaceId: node.item.workspaceId,
            itemId: node.item.id,
          },
          node.path,
        );
        const underTables =
          node.path === "Tables" || node.path.startsWith("Tables/");
        return entries
          .sort((a, b) =>
            a.isDirectory === b.isDirectory
              ? a.path.localeCompare(b.path)
              : a.isDirectory
                ? -1
                : 1,
          )
          .map((entry) => ({
            kind: "onelake",
            item: node.item,
            path: entry.path,
            isDirectory: entry.isDirectory,
            // Directories under Tables/ get the preview action; a schema
            // folder simply fails to read as Delta and says so.
            isTable:
              underTables &&
              entry.isDirectory &&
              !entry.path.split("/").some((part) => part.startsWith("_")),
          }));
      }
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
    const compute = await this.compute();
    if (compute === undefined) {
      throw new ExplorerError(
        "Cannot preview the table: no compute is connected.",
        {
          operation: "preview table",
          entity: `table ${node.path}`,
          remediation:
            "Run 'Fabric: Connect to Compute' first; previews run on its Spark session.",
        },
      );
    }
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
