/**
 * Configuration view (top of the Fabric side bar), like the Databricks
 * extension's: what this repo signs in as and where its code runs.
 *
 * - Account: the Microsoft account; switch it or sign out.
 * - Tenant: the tenant the repo signs in to; switch it.
 * - Compute: the connected capacity, workspace, host Lakehouse and
 *   Environment; connect (change) or disconnect.
 *
 * The rows only show state kept by `SignInManager` and `ComputeConnection`
 * (both in the gitignored `.fabric/local.json`); every action runs their
 * existing commands.
 */

import * as vscode from "vscode";
import type { ComputeProfile } from "../core/computeProfile";
import type { SignInManager } from "./signIn";

type Node =
  | { kind: "account" }
  | { kind: "tenant" }
  | { kind: "compute"; profile: ComputeProfile | undefined; error?: string }
  | { kind: "detail"; label: string; value: string; icon: string };

export class ConfigurationView
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly signIn: SignInManager,
    private readonly compute: () => Promise<ComputeProfile | undefined>,
  ) {}

  dispose(): void {
    this.changed.dispose();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const none = vscode.TreeItemCollapsibleState.None;
    switch (node.kind) {
      case "account": {
        const profile = this.signIn.current();
        const item = new vscode.TreeItem("Account", none);
        item.description = profile?.account;
        if (this.signIn.accountSignedIn()) {
          item.iconPath = new vscode.ThemeIcon("account");
          item.tooltip = "The Microsoft account this repo signs in with.";
        } else {
          item.iconPath = new vscode.ThemeIcon("warning");
          item.tooltip = `This repo signs in as ${profile?.account ?? "an account"} that is not signed in to VS Code. Sign in again to use it.`;
        }
        item.contextValue = "fabricConfigAccount";
        return item;
      }
      case "tenant": {
        const profile = this.signIn.current();
        const item = new vscode.TreeItem("Tenant", none);
        item.description = profile?.tenantName ?? profile?.tenantId;
        item.tooltip = `Tenant ${profile?.tenantId ?? ""}`;
        item.iconPath = new vscode.ThemeIcon("organization");
        item.contextValue = "fabricConfigTenant";
        return item;
      }
      case "compute": {
        const profile = node.profile;
        const item = new vscode.TreeItem(
          "Compute",
          profile === undefined
            ? none
            : vscode.TreeItemCollapsibleState.Expanded,
        );
        if (node.error !== undefined) {
          item.description = "invalid";
          item.tooltip = node.error;
          item.iconPath = new vscode.ThemeIcon("warning");
        } else if (profile === undefined) {
          item.description = "not connected";
          item.tooltip =
            "Pick the capacity, workspace and Lakehouse your code runs on.";
          item.iconPath = new vscode.ThemeIcon("plug");
          item.command = {
            title: "Connect to Compute",
            command: "fabric-connect.connectCompute",
          };
        } else {
          item.description = profile.workspaceName;
          item.iconPath = new vscode.ThemeIcon("server-environment");
        }
        item.contextValue =
          profile === undefined
            ? "fabricConfigCompute"
            : "fabricConfigCompute connected";
        return item;
      }
      case "detail": {
        const item = new vscode.TreeItem(node.label, none);
        item.description = node.value;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node === undefined) {
      // Signed out: the view's welcome content offers Sign In.
      if (this.signIn.current() === undefined) {
        return [];
      }
      let compute: Node;
      try {
        compute = { kind: "compute", profile: await this.compute() };
      } catch (error) {
        compute = {
          kind: "compute",
          profile: undefined,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return [{ kind: "account" }, { kind: "tenant" }, compute];
    }
    if (node.kind !== "compute" || node.profile === undefined) {
      return [];
    }
    const p = node.profile;
    const unnamed = "(name not saved)";
    const details: Node[] = [
      {
        kind: "detail",
        label: "Capacity",
        value: [p.capacityName ?? unnamed, p.sku].filter(Boolean).join(" · "),
        icon: "server",
      },
      {
        kind: "detail",
        label: "Workspace",
        value: p.workspaceName ?? unnamed,
        icon: "folder-library",
      },
      {
        kind: "detail",
        label: "Lakehouse",
        value: p.lakehouseName ?? unnamed,
        icon: "database",
      },
    ];
    if (p.environmentId !== undefined) {
      details.push({
        kind: "detail",
        label: "Environment",
        value: p.environmentName ?? unnamed,
        icon: "package",
      });
    }
    return details;
  }
}
