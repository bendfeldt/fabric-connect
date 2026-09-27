/**
 * Tenant Picker: how the user selects the Entra tenant to work in. Shows
 * recently used tenants (by name), finds every tenant the account belongs
 * to on request, and accepts a tenant ID or domain typed by hand. The
 * selection is remembered and becomes the tenant the explorer and API
 * notebooks use; compute and query prompts go through the same picker.
 */

import * as vscode from "vscode";
import {
  isTenantId,
  label,
  listAccountTenants,
  mergeTenantChoices,
  parseTenantInput,
  resolveTenantDomain,
  type TenantInfo,
} from "../core/tenantDirectory";
import type { IFabricApiClient } from "../core/types";

const LAST_TENANT_KEY = "fabric-connect.lastTenantId";
const RECENT_TENANTS_KEY = "fabric-connect.recentTenants";
const MAX_RECENT = 10;

type Choice = vscode.QuickPickItem &
  (
    | { readonly action: "tenant"; readonly tenant: TenantInfo }
    | { readonly action: "find" | "enter" }
  );

export class TenantPicker {
  constructor(
    private readonly api: IFabricApiClient,
    private readonly state: vscode.Memento,
    /** Tenants known from elsewhere, e.g. the saved compute connection. */
    private readonly otherTenants: () => Promise<TenantInfo[]>,
  ) {}

  /** The tenant the user last selected, if any. */
  selected(): string | undefined {
    return this.state.get<string>(LAST_TENANT_KEY);
  }

  /** Asks the user for a tenant; `undefined` when they cancel. */
  async pick(): Promise<TenantInfo | undefined> {
    const current = this.selected();
    const known = mergeTenantChoices(
      this.recent(),
      current === undefined ? [] : [{ id: current }],
      await this.otherTenants(),
    );
    const choices: Choice[] = [
      ...known.map((tenant) => this.tenantChoice(tenant, current)),
      ...(known.length > 0
        ? [{ label: "", kind: vscode.QuickPickItemKind.Separator } as Choice]
        : []),
      {
        action: "find",
        label: "$(search) Find tenants on my account…",
        detail:
          "Lists every tenant your Microsoft account belongs to. The first time, VS Code asks you to allow Azure Resource Manager access.",
      },
      {
        action: "enter",
        label: "$(edit) Enter a tenant ID or domain…",
        detail: "A tenant GUID, or a domain such as contoso.onmicrosoft.com",
      },
    ];
    const picked = await vscode.window.showQuickPick(choices, {
      title: "Select a Fabric tenant",
      placeHolder:
        known.length > 0
          ? "Pick a tenant, find the tenants on your account, or enter one"
          : "Find the tenants on your account, or enter a tenant ID or domain",
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (picked === undefined) {
      return undefined;
    }
    const tenant =
      picked.action === "tenant"
        ? picked.tenant
        : picked.action === "find"
          ? await this.findOnAccount(current)
          : await this.enterByHand();
    if (tenant !== undefined) {
      await this.remember(tenant);
    }
    return tenant;
  }

  private tenantChoice(
    tenant: TenantInfo,
    current: string | undefined,
  ): Choice {
    const name = label(tenant);
    const isCurrent = tenant.id === current?.toLowerCase();
    return {
      action: "tenant",
      tenant,
      label: isCurrent ? `$(check) ${name}` : name,
      description: [
        tenant.defaultDomain !== undefined && tenant.defaultDomain !== name
          ? tenant.defaultDomain
          : undefined,
        isCurrent ? "current" : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" · "),
      detail: name === tenant.id ? undefined : tenant.id,
    };
  }

  private async findOnAccount(
    current: string | undefined,
  ): Promise<TenantInfo | undefined> {
    let tenants: TenantInfo[];
    try {
      tenants = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Finding the tenants on your Microsoft account…",
        },
        () => listAccountTenants(this.api),
      );
    } catch (error) {
      const enter = "Enter Tenant ID or Domain";
      const answer = await vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
        enter,
      );
      return answer === enter ? this.enterByHand() : undefined;
    }
    if (tenants.length === 0) {
      void vscode.window.showWarningMessage(
        "Your account's tenant list came back empty. Enter the tenant ID or domain instead.",
      );
      return this.enterByHand();
    }
    const picked = await vscode.window.showQuickPick(
      tenants.map((tenant) => this.tenantChoice(tenant, current)),
      {
        title: `Select a Fabric tenant (${tenants.length} on your account)`,
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true,
      },
    );
    return picked?.action === "tenant" ? picked.tenant : undefined;
  }

  private async enterByHand(): Promise<TenantInfo | undefined> {
    const value = await vscode.window.showInputBox({
      title: "Select a Fabric tenant",
      prompt:
        "Tenant ID (GUID) or domain, e.g. contoso.onmicrosoft.com. Find the ID in Entra admin center → Overview.",
      ignoreFocusOut: true,
      validateInput: (text) =>
        parseTenantInput(text) === undefined
          ? "Enter a tenant GUID (00000000-0000-0000-0000-000000000000) or a domain (contoso.onmicrosoft.com)"
          : undefined,
    });
    const input = value === undefined ? undefined : parseTenantInput(value);
    if (input === undefined) {
      return undefined;
    }
    if (input.kind === "id") {
      return this.recent().find((t) => t.id === input.id) ?? { id: input.id };
    }
    const id = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Looking up the tenant for ${input.domain}…`,
      },
      () => resolveTenantDomain(input.domain),
    );
    return { id, defaultDomain: input.domain };
  }

  private recent(): TenantInfo[] {
    const stored = this.state.get<unknown>(RECENT_TENANTS_KEY);
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored.filter(
      (t): t is TenantInfo =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as { id?: unknown }).id === "string" &&
        isTenantId((t as { id: string }).id),
    );
  }

  private async remember(tenant: TenantInfo): Promise<void> {
    const recent = mergeTenantChoices([tenant], this.recent()).slice(
      0,
      MAX_RECENT,
    );
    await this.state.update(RECENT_TENANTS_KEY, recent);
    await this.state.update(LAST_TENANT_KEY, tenant.id);
  }
}
