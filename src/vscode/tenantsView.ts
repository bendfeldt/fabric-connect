/**
 * Tenants view (Fabric side bar): the tenants the repo can sign in to, the
 * current one checked. Click a tenant to sign the repo in to it with the
 * same account; the other views follow.
 *
 * Lists the tenants known without a network call (current, recently used,
 * the compute connection's). "Find tenants on my account" asks Azure
 * Resource Manager for the rest only when clicked, because the first ARM
 * call can show a consent prompt.
 */

import * as vscode from "vscode";
import {
  label,
  listAccountTenants,
  mergeTenantChoices,
  type TenantInfo,
} from "../core/tenantDirectory";
import type { IFabricApiClient } from "../core/types";
import type { SignInManager } from "./signIn";
import type { TenantPicker } from "./tenantPicker";

type Node =
  | { kind: "tenant"; tenant: TenantInfo; current: boolean }
  | { kind: "find" }
  | { kind: "message"; label: string };

export class TenantsView
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** Tenants found on the account; undefined until "find" is clicked. */
  private found: TenantInfo[] | undefined;
  private findError: string | undefined;
  /** The account `found` belongs to; another account needs a new find. */
  private foundFor: string | undefined;

  constructor(
    private readonly api: IFabricApiClient,
    private readonly signIn: SignInManager,
    private readonly tenants: TenantPicker,
  ) {}

  dispose(): void {
    this.changed.dispose();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  /** Asks Azure Resource Manager for every tenant on the account. */
  async find(): Promise<void> {
    this.foundFor = accountKey(this.signIn.current());
    try {
      this.found = await vscode.window.withProgress(
        { location: { viewId: "fabricConnect.tenants" } },
        () => listAccountTenants(this.api),
      );
      this.findError = undefined;
    } catch (error) {
      this.findError = error instanceof Error ? error.message : String(error);
    }
    this.refresh();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const none = vscode.TreeItemCollapsibleState.None;
    switch (node.kind) {
      case "tenant": {
        const name = label(node.tenant);
        const item = new vscode.TreeItem(name, none);
        item.description = [
          node.tenant.defaultDomain !== name
            ? node.tenant.defaultDomain
            : undefined,
          node.current ? "current" : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(" · ");
        item.tooltip = `Tenant ${node.tenant.id}`;
        item.iconPath = new vscode.ThemeIcon(
          node.current ? "pass-filled" : "organization",
        );
        item.contextValue = "fabricTenant";
        if (!node.current) {
          item.command = {
            title: "Use Tenant",
            command: "fabric-connect.useTenant",
            arguments: [node.tenant],
          };
        }
        return item;
      }
      case "find": {
        const item = new vscode.TreeItem("Find tenants on my account…", none);
        item.iconPath = new vscode.ThemeIcon("search");
        item.tooltip =
          "Lists every tenant your Microsoft account belongs to. The first time, VS Code asks you to allow Azure Resource Manager access.";
        item.command = {
          title: "Find Tenants",
          command: "fabric-connect.findTenants",
        };
        return item;
      }
      case "message":
        return new vscode.TreeItem(node.label, none);
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const profile = this.signIn.current();
    // Signed out: the view's welcome content offers Sign In.
    if (node !== undefined || profile === undefined) {
      return [];
    }
    // Switching tenant keeps the list; switching account forgets it.
    if (accountKey(profile) !== this.foundFor) {
      this.found = undefined;
      this.findError = undefined;
    }
    const current: TenantInfo = {
      id: profile.tenantId,
      displayName: profile.tenantName,
    };
    const tenants = mergeTenantChoices(
      await this.tenants.known([current]),
      this.found ?? [],
    );
    const nodes: Node[] = tenants.map((tenant) => ({
      kind: "tenant",
      tenant,
      current: tenant.id === current.id.toLowerCase(),
    }));
    if (this.findError !== undefined) {
      nodes.push({
        kind: "message",
        label: `⚠ ${this.findError.split(" Next step:")[0]}`,
      });
    }
    if (this.found === undefined || this.findError !== undefined) {
      nodes.push({ kind: "find" });
    }
    return nodes;
  }
}

function accountKey(
  profile: { account: string; accountId?: string } | undefined,
): string | undefined {
  return profile === undefined
    ? undefined
    : (profile.accountId ?? profile.account.toLowerCase());
}
