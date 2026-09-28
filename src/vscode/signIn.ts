/**
 * Sign-in for a repo, the way Tabular Editor keeps a model's connection in
 * its per-user `.tmuo` file: you sign in once with your Microsoft account,
 * the account and tenant are saved in the gitignored `.fabric/local.json`,
 * and reopening the repo signs you in again without a prompt. Different
 * repos can use different accounts and tenants at the same time.
 *
 * - Sign In: pick an account already signed in to VS Code, or log in with
 *   another one in the browser, then pick the tenant. The account's own
 *   tenant (read from the token) is offered first, so Enter keeps it.
 * - Switch Tenant: for guest access to other organizations — the tenant
 *   picker lists the account's tenants, or takes an ID or domain.
 * - Sign Out: the repo forgets the sign-in; the account itself stays signed
 *   in to VS Code (Accounts menu) for other repos and extensions.
 *
 * The status bar shows who the repo is signed in as; click it for these
 * actions. Tokens are never stored here: only the account name, VS Code's
 * account ID and the tenant.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { FABRIC_SCOPES } from "../core/constants";
import { AuthError } from "../core/errors";
import {
  type SignInProfile,
  describeSignIn,
  readSignInProfile,
  tenantFromToken,
  writeSignInProfile,
} from "../core/signInProfile";
import { LOCAL_OVERRIDE_FILE } from "../core/targetResolver";
import type { TenantInfo } from "../core/tenantDirectory";
import type {
  AccountInfo,
  AccountChoice,
  EntraAuthProvider,
} from "./authProvider";
import type { TenantPicker } from "./tenantPicker";

/** Where the sign-in is kept when no folder is open. */
const NO_FOLDER_KEY = "fabric-connect.signIn";

type AccountAction = vscode.QuickPickItem & { readonly choice: AccountChoice };
type MenuAction = vscode.QuickPickItem & {
  readonly run: () => Promise<unknown>;
};

export class SignInManager implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<
    SignInProfile | undefined
  >();
  /** Fires after the repo signs in, switches tenant or signs out. */
  readonly onDidChange = this.changed.event;
  private profile: SignInProfile | undefined;
  /** False when the saved account is no longer signed in to VS Code. */
  private accountAvailable = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly auth: EntraAuthProvider,
    private readonly tenants: TenantPicker,
    private readonly workspaceRoot: string | undefined,
    private readonly state: vscode.Memento,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      "fabric-connect.account",
      vscode.StatusBarAlignment.Left,
      51,
    );
    this.statusBar.name = "Fabric Account";
    this.statusBar.command = "fabric-connect.accountMenu";
    this.subscriptions.push(
      vscode.authentication.onDidChangeSessions((event) => {
        if (event.provider.id === "microsoft") {
          void this.restore();
        }
      }),
    );
  }

  dispose(): void {
    this.statusBar.dispose();
    this.changed.dispose();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  /** The tenant the repo is signed in to, if it is. */
  tenant(): string | undefined {
    return this.profile?.tenantId;
  }

  /** The repo's tenant, signing in first if the repo is not signed in. */
  async requireTenant(): Promise<string | undefined> {
    return this.profile?.tenantId ?? (await this.signIn())?.tenantId;
  }

  /**
   * Loads the saved sign-in and reuses its account without a prompt. Runs
   * on activation and whenever VS Code's Microsoft accounts change.
   */
  async restore(): Promise<void> {
    let profile: SignInProfile | undefined;
    try {
      profile = await this.load();
    } catch (error) {
      this.profile = undefined;
      this.auth.useAccount(undefined);
      this.show(
        "$(warning) Fabric: invalid sign-in",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const account =
      profile === undefined ? undefined : await this.findAccount(profile);
    const before = JSON.stringify([this.profile, this.accountAvailable]);
    this.profile = profile;
    this.accountAvailable = account !== undefined;
    this.auth.useAccount(account);
    this.refreshStatus();
    // Session events also fire on token refresh; only report real changes.
    if (JSON.stringify([profile, this.accountAvailable]) !== before) {
      this.changed.fire(profile);
    }
  }

  /**
   * Interactive sign-in: pick an account signed in to VS Code, or log in
   * with another one, then the tenant (the account's own is the default).
   */
  async signIn(): Promise<SignInProfile | undefined> {
    const choice = await this.pickAccount();
    if (choice === undefined) {
      return undefined;
    }
    const { account, accessToken } = await this.auth.signIn(choice);
    const homeTenantId = tenantFromToken(accessToken);
    if (homeTenantId === undefined) {
      throw new AuthError(
        "Signed in, but the token did not say which tenant the account belongs to.",
        {
          operation: "sign in",
          entity: `account ${account.label}`,
          remediation:
            "Run 'Fabric: Switch Tenant' and enter your tenant ID or domain.",
        },
      );
    }
    // Finding the account's tenants and checking guest access need tokens
    // for the account just picked; the previous one is back on cancel/error.
    const previous = this.auth.currentAccount();
    this.auth.useAccount(account);
    let tenant: TenantInfo | undefined;
    let chosen = false;
    try {
      tenant = await this.tenants.pick(
        homeTenantId,
        "Sign in to Fabric — pick the tenant",
      );
      if (tenant !== undefined && tenant.id !== homeTenantId) {
        // Sign in to that tenant now, so a missing guest access fails here.
        await this.auth.getToken(tenant.id, FABRIC_SCOPES);
      }
      chosen = tenant !== undefined;
    } finally {
      if (!chosen) {
        this.auth.useAccount(previous);
      }
    }
    if (tenant === undefined) {
      return undefined;
    }
    const profile = profileFor(account.label, account.id, tenant);
    await this.save(profile, account);
    void vscode.window.showInformationMessage(
      `Signed in as ${account.label} to ${describeTenant(tenant)}. This repo will sign in this way from now on.`,
    );
    return profile;
  }

  /** Signs the repo in to another tenant with the same account. */
  async switchTenant(): Promise<SignInProfile | undefined> {
    const current = this.profile ?? (await this.signIn());
    if (current === undefined) {
      return undefined;
    }
    const tenant = await this.tenants.pick(current.tenantId);
    if (tenant === undefined) {
      return undefined;
    }
    // Sign in to that tenant now, so a missing guest access fails here.
    await this.auth.getToken(tenant.id, FABRIC_SCOPES);
    const profile = profileFor(current.account, current.accountId, tenant);
    await this.save(profile, undefined);
    void vscode.window.showInformationMessage(
      `This repo now signs in to ${describeTenant(tenant)} as ${current.account}.`,
    );
    return profile;
  }

  /** Forgets the repo's sign-in; the account stays signed in to VS Code. */
  async signOut(): Promise<void> {
    if (this.profile === undefined) {
      void vscode.window.showInformationMessage(
        "This repo is not signed in to Fabric.",
      );
      return;
    }
    const account = this.profile.account;
    await this.save(undefined, undefined);
    void vscode.window.showInformationMessage(
      `This repo no longer signs in as ${account}. The account stays signed in to VS Code; to remove it everywhere, use the Accounts menu.`,
    );
  }

  /** The status bar menu: sign in, or switch account/tenant, or sign out. */
  async showMenu(): Promise<void> {
    const actions: MenuAction[] =
      this.profile === undefined
        ? [
            {
              label: "$(sign-in) Sign In…",
              detail: "Sign in with your Microsoft account for this repo",
              run: () => this.signIn(),
            },
          ]
        : [
            {
              label: "$(account) Switch Account…",
              detail: `Signed in as ${this.profile.account}`,
              run: () => this.signIn(),
            },
            {
              label: "$(organization) Switch Tenant…",
              detail: `Tenant: ${this.profile.tenantName ?? this.profile.tenantId}`,
              run: () => this.switchTenant(),
            },
            {
              label: "$(sign-out) Sign Out",
              detail: "This repo forgets the sign-in",
              run: () => this.signOut(),
            },
          ];
    const picked = await vscode.window.showQuickPick(actions, {
      title: "Fabric Connect account",
    });
    await picked?.run();
  }

  private async pickAccount(): Promise<AccountChoice | undefined> {
    const accounts = await this.auth.accounts();
    if (accounts.length === 0) {
      return { kind: "new" };
    }
    const items: AccountAction[] = [
      ...accounts.map(
        (account): AccountAction => ({
          label: `$(account) ${account.label}`,
          description:
            account.id === this.profile?.accountId ? "current" : undefined,
          choice: { kind: "existing", account },
        }),
      ),
      {
        label: "$(add) Sign in with another account…",
        detail: "Opens the Microsoft sign-in in your browser",
        choice: { kind: "new" },
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Sign in to Fabric",
      placeHolder: "Pick the Microsoft account this repo signs in with",
      ignoreFocusOut: true,
    });
    return picked?.choice;
  }

  /** The VS Code account for a saved sign-in: by ID, then by name. */
  private async findAccount(
    profile: SignInProfile,
  ): Promise<AccountInfo | undefined> {
    let accounts: readonly AccountInfo[];
    try {
      accounts = await this.auth.accounts();
    } catch {
      return undefined;
    }
    return (
      accounts.find((a) => a.id === profile.accountId) ??
      accounts.find(
        (a) => a.label.toLowerCase() === profile.account.toLowerCase(),
      )
    );
  }

  private refreshStatus(): void {
    const profile = this.profile;
    if (profile === undefined) {
      this.show(
        "$(sign-in) Fabric: sign in",
        "Not signed in. Click to sign in with your Microsoft account for this repo.",
      );
    } else if (!this.accountAvailable) {
      this.show(
        `$(warning) Fabric: ${profile.account}`,
        `This repo signs in as ${profile.account}, but that account is not signed in to VS Code. You will be asked to sign in when Fabric Connect next needs it, or click to sign in now.`,
      );
    } else {
      this.show(
        `$(account) Fabric: ${describeSignIn(profile)}`,
        `This repo signs in as ${profile.account} to tenant ${profile.tenantName ?? profile.tenantId}. Click to switch account or tenant, or sign out.`,
      );
    }
  }

  private show(text: string, tooltip: string): void {
    this.statusBar.text = text;
    this.statusBar.tooltip = tooltip;
    this.statusBar.show();
  }

  private async save(
    profile: SignInProfile | undefined,
    account: AccountInfo | undefined,
  ): Promise<void> {
    if (this.workspaceRoot === undefined) {
      await this.state.update(NO_FOLDER_KEY, profile);
    } else {
      const file = path.join(this.workspaceRoot, LOCAL_OVERRIDE_FILE);
      const text = writeSignInProfile(await this.readLocal(), profile);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, "utf8");
    }
    this.profile = profile;
    if (account !== undefined) {
      this.auth.useAccount(account);
      this.accountAvailable = true;
    } else if (profile === undefined) {
      this.auth.useAccount(undefined);
    }
    this.refreshStatus();
    this.changed.fire(profile);
  }

  private async load(): Promise<SignInProfile | undefined> {
    if (this.workspaceRoot === undefined) {
      const stored = this.state.get<unknown>(NO_FOLDER_KEY);
      return stored === undefined
        ? undefined
        : readSignInProfile(JSON.stringify({ signIn: stored }));
    }
    return readSignInProfile(await this.readLocal());
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

function profileFor(
  account: string,
  accountId: string | undefined,
  tenant: TenantInfo,
): SignInProfile {
  return {
    account,
    ...(accountId === undefined ? {} : { accountId }),
    tenantId: tenant.id,
    ...(tenant.displayName === undefined
      ? {}
      : { tenantName: tenant.displayName }),
  };
}

function describeTenant(tenant: TenantInfo): string {
  return tenant.displayName ?? tenant.defaultDomain ?? tenant.id;
}
