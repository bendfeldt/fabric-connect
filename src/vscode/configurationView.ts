/**
 * Configuration view (top of the Fabric side bar), like the Databricks
 * extension's: what this repo signs in as and where its code runs.
 *
 * - Account: the Microsoft account; switch it or sign out.
 * - Tenant: the tenant the repo signs in to; switch it.
 * - Compute: the connected capacity; connect (change) or disconnect. Its
 *   host Lakehouse (and Environment) for code without a Lakehouse of its
 *   own, or "picked when needed"; change it.
 * - Python modules: whether `import` uses your working tree (Local) or the
 *   Fabric environment's installed packages (Remote); change it. Same
 *   state and text as the status bar item (`ModuleStager`).
 *
 * The rows only show state kept by `SignInManager` and `ComputeConnection`
 * (both in the gitignored `.fabric/local.json`); every action runs their
 * existing commands.
 */

import * as vscode from "vscode";
import {
  type ComputeProfile,
  capacityDisplayName,
  hostOf,
} from "../core/computeProfile";
import type { ModulesDescription } from "../core/moduleStaging";
import type { SignInManager } from "./signIn";

type Node =
  | { kind: "account" }
  | { kind: "tenant" }
  | { kind: "compute"; profile: ComputeProfile | undefined; error?: string }
  | { kind: "modules"; description: ModulesDescription }
  | {
      kind: "detail";
      label: string;
      value: string;
      icon: string;
      contextValue?: string;
      tooltip?: string;
    };

export class ConfigurationView
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly signIn: SignInManager,
    private readonly compute: () => Promise<ComputeProfile | undefined>,
    /** Why the capacity's real name is not shown, when it is not. */
    private readonly nameHiddenReason: (
      profile: ComputeProfile,
    ) => string | undefined,
    /** Python modules mode, as `ModuleStager.describe` reports it. */
    private readonly modules: () => Promise<ModulesDescription>,
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
          item.tooltip = "Pick the capacity your code runs on.";
          item.iconPath = new vscode.ThemeIcon("plug");
          item.command = {
            title: "Connect to Compute",
            command: "fabric-connect.connectCompute",
          };
        } else {
          item.description = [capacityDisplayName(profile), profile.sku]
            .filter(Boolean)
            .join(" · ");
          item.iconPath = new vscode.ThemeIcon("server-environment");
        }
        item.contextValue =
          profile === undefined
            ? "fabricConfigCompute"
            : "fabricConfigCompute connected";
        return item;
      }
      case "modules": {
        const item = new vscode.TreeItem("Python modules", none);
        item.description = node.description.label;
        item.tooltip = node.description.tooltip;
        item.iconPath = new vscode.ThemeIcon(node.description.icon);
        item.contextValue = "fabricConfigModules";
        item.command = {
          title: "Python Modules",
          command: "fabric-connect.pythonModules",
        };
        return item;
      }
      case "detail": {
        const item = new vscode.TreeItem(node.label, none);
        item.description = node.value;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.contextValue = node.contextValue;
        item.tooltip = node.tooltip;
        return item;
      }
    }
  }

  /** Why a capacity shows the name it does, when that needs saying. */
  private capacityTooltip(p: ComputeProfile): string | undefined {
    if (p.capacityLabel !== undefined) {
      return `Your name for this capacity (listed as '${p.capacityName ?? p.capacityId}'). Rename it with the pencil.`;
    }
    const hidden = this.nameHiddenReason(p);
    return hidden === undefined
      ? undefined
      : `${hidden} Give it a name with the pencil (Name This Capacity…).`;
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
      return [
        { kind: "account" },
        { kind: "tenant" },
        compute,
        { kind: "modules", description: await this.modules() },
      ];
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
        value: [capacityDisplayName(p) ?? unnamed, p.sku]
          .filter(Boolean)
          .join(" · "),
        icon: "server",
        contextValue: "fabricConfigCapacity",
        tooltip: this.capacityTooltip(p),
      },
    ];
    const hosted = hostOf(p);
    if (hosted === undefined) {
      details.push({
        kind: "detail",
        label: "Host Lakehouse",
        value: "picked when needed",
        icon: "database",
        contextValue: "fabricConfigHost",
      });
      return details;
    }
    details.push({
      kind: "detail",
      label: "Host Lakehouse",
      value: `${hosted.lakehouseName ?? unnamed} · ${hosted.workspaceName ?? unnamed}`,
      icon: "database",
      contextValue: "fabricConfigHost",
    });
    if (hosted.environmentId !== undefined) {
      details.push({
        kind: "detail",
        label: "Environment",
        value: hosted.environmentName ?? unnamed,
        icon: "package",
      });
    }
    return details;
  }
}
