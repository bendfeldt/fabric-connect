/**
 * Auth Module: multi-tenant, user-delegated Entra ID auth built on VS Code's
 * stable `vscode.authentication` API with the built-in Microsoft provider.
 * The provider handles interactive login, token caching, and refresh, and
 * persists credentials through VS Code's SecretStorage — tokens never touch
 * disk through this extension and are never logged.
 *
 * Sessions are requested per tenant (scoped with the provider's
 * `VSCODE_TENANT:` scope), so a token from one tenant can never be used
 * against another: there is no shared cache entry to overlap. Once the repo
 * has signed in (see `SignInManager`), every token is requested for that
 * Microsoft account, so a repo never picks up another account's session.
 */

import * as vscode from "vscode";
import { FABRIC_SCOPES, HOME_TENANT } from "../core/constants";
import { AuthError } from "../core/errors";
import type { IAuthProvider } from "../core/types";

const MICROSOFT_AUTH_PROVIDER = "microsoft";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccountInfo = vscode.AuthenticationSessionAccountInformation;

/** How an interactive sign-in picks the account. */
export type AccountChoice =
  | { readonly kind: "existing"; readonly account: AccountInfo }
  | { readonly kind: "new" };

export class EntraAuthProvider implements IAuthProvider {
  private account: AccountInfo | undefined;

  /** The account every later token is requested for (`undefined`: any). */
  useAccount(account: AccountInfo | undefined): void {
    this.account = account;
  }

  /** Microsoft accounts signed in to VS Code. */
  async accounts(): Promise<readonly AccountInfo[]> {
    return vscode.authentication.getAccounts(MICROSOFT_AUTH_PROVIDER);
  }

  /**
   * Interactive sign-in to the account's home tenant: an account already
   * signed in to VS Code, or a new Microsoft login in the browser. Returns
   * the account and a Fabric token (which names the tenant).
   */
  async signIn(
    choice: AccountChoice,
  ): Promise<{ account: AccountInfo; accessToken: string }> {
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession(
        MICROSOFT_AUTH_PROVIDER,
        [...FABRIC_SCOPES],
        choice.kind === "existing"
          ? { createIfNone: true, account: choice.account }
          : {
              forceNewSession: {
                detail:
                  "Sign in with the Microsoft account Fabric Connect should use for this repo.",
              },
            },
      );
    } catch (cause) {
      throw signInError("your Microsoft account", cause);
    }
    if (session === undefined) {
      throw new AuthError("Sign-in did not return a session.", {
        operation: "sign in",
        entity: "your Microsoft account",
        remediation: "Run 'Fabric: Sign In' again and complete the sign-in.",
      });
    }
    return { account: session.account, accessToken: session.accessToken };
  }

  /**
   * `tenantId` is a tenant GUID, or `HOME_TENANT` for the account's home
   * tenant (used only to list the tenants the account belongs to).
   */
  async getToken(tenantId: string, scopes: readonly string[]): Promise<string> {
    const home = tenantId === HOME_TENANT;
    if (!home && !GUID.test(tenantId)) {
      throw new AuthError(
        `Cannot acquire a token: '${tenantId}' is not a valid tenant ID (expected a GUID).`,
        {
          operation: "acquire token",
          entity: `tenant ${tenantId}`,
          remediation:
            "Fix the tenantId in '.fabric/targets.json' (copy it from Entra admin center → Overview).",
        },
      );
    }
    // Without a VSCODE_TENANT scope the provider signs in to the home tenant.
    const fullScopes = home
      ? [...scopes]
      : [...scopes, `VSCODE_TENANT:${tenantId}`];
    const who = home ? "your home tenant" : `tenant ${tenantId}`;
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession(
        MICROSOFT_AUTH_PROVIDER,
        fullScopes,
        { createIfNone: true, account: this.account },
      );
    } catch (cause) {
      throw signInError(who, cause);
    }
    if (session === undefined) {
      throw new AuthError(`No authentication session exists for ${who}.`, {
        operation: "acquire token",
        entity: who,
        remediation: "Run 'Fabric: Sign In' to authenticate this tenant.",
      });
    }
    return session.accessToken;
  }
}

function signInError(who: string, cause: unknown): AuthError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const declined = /cancel|consent|denied/i.test(message);
  return new AuthError(
    declined
      ? `Sign-in to ${who} was cancelled or consent was declined.`
      : `Failed to acquire a token for ${who}.`,
    {
      operation: "acquire token",
      entity: who,
      remediation: declined
        ? "Run 'Fabric: Sign In' again and complete the sign-in prompt."
        : "Check your network connection, then run 'Fabric: Sign In' to re-authenticate.",
      cause,
    },
  );
}
