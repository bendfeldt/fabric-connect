/**
 * A Lakehouse's OneLake `Files` and `Tables` as tree nodes, shared by the
 * Fabric explorer and the Lakehouses view. Folders list lazily, one GET per
 * expanded folder; table and file rows carry the context values the
 * explorer's Preview Table / Preview File / Copy OneLake Path act on.
 */

import * as vscode from "vscode";
import {
  type OneLakeClient,
  type OneLakeItem,
  oneLakeChildEntries,
} from "../core/oneLakeClient";

/** The Fabric item whose OneLake is browsed. */
export type ItemInfo = OneLakeItem;

export interface OneLakeNode {
  readonly kind: "onelake";
  readonly item: ItemInfo;
  readonly path: string;
  readonly isDirectory: boolean;
  readonly isTable: boolean;
}

/** Item types that expand into OneLake Files/Tables. */
export const ONELAKE_ITEMS = new Set(["Lakehouse"]);

/** The `Files` and `Tables` folders of an item. */
export function oneLakeRoots(item: ItemInfo): OneLakeNode[] {
  return ["Files", "Tables"].map((path) => ({
    kind: "onelake",
    item,
    path,
    isDirectory: true,
    isTable: false,
  }));
}

export function oneLakeTreeItem(node: OneLakeNode): vscode.TreeItem {
  const name = node.path.split("/").pop() ?? node.path;
  // Table folders stay expandable: in schema-enabled Lakehouses the
  // first level under Tables/ is a schema that holds the tables.
  const item = new vscode.TreeItem(
    name,
    node.isDirectory
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
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

/** One folder's entries; directories under Tables/ get the preview action. */
export async function listOneLakeChildren(
  oneLake: OneLakeClient,
  tenantId: string,
  node: OneLakeNode,
): Promise<OneLakeNode[]> {
  const entries = await oneLake.list(
    { tenantId, workspaceId: node.item.workspaceId, itemId: node.item.id },
    node.path,
  );
  // A schema folder simply fails to read as Delta when previewed, and says so.
  return oneLakeChildEntries(entries, node.path).map((entry) => ({
    kind: "onelake",
    item: node.item,
    path: entry.path,
    isDirectory: entry.isDirectory,
    isTable: entry.isTable,
  }));
}
