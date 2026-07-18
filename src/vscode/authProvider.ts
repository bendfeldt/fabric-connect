/**
 * Auth Module: multi-tenant, user-delegated Entra ID auth built on VS Code's
 * stable `vscode.authentication` API with the built-in Microsoft provider.
 * The provider handles interactive login, token caching, and refresh, and
 * persists credentials through VS Code's SecretStorage — tokens never touch
 * disk through this extension and are never logged.
 *
 * Sessions are requested per tenant (scoped with the provider's
 * `VSCODE_TENANT:` scope), so a token from one tenant can never be used
 * against another: there is no shared cache entry to overlap.
 */

import * as vscode from 'vscode';
import { AuthError } from '../core/errors';
import type { IAuthProvider } from '../core/types';

const MICROSOFT_AUTH_PROVIDER = 'microsoft';

export class EntraAuthProvider implements IAuthProvider {
  async getToken(tenantId: string, scopes: readonly string[]): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
      throw new AuthError(
        `Cannot acquire a token: '${tenantId}' is not a valid tenant ID (expected a GUID).`,
        {
          operation: 'acquire token',
          entity: `tenant ${tenantId}`,
          remediation:
            "Fix the tenantId in '.fabric/targets.json' (copy it from Entra admin center → Overview).",
        },
      );
    }
    const fullScopes = [...scopes, `VSCODE_TENANT:${tenantId}`];
    let session: vscode.AuthenticationSession | undefined;
    try {
      session = await vscode.authentication.getSession(
        MICROSOFT_AUTH_PROVIDER,
        fullScopes,
        { createIfNone: true },
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const declined = /cancel|consent|denied/i.test(message);
      throw new AuthError(
        declined
          ? `Sign-in to tenant ${tenantId} was cancelled or consent was declined.`
          : `Failed to acquire a token for tenant ${tenantId}.`,
        {
          operation: 'acquire token',
          entity: `tenant ${tenantId}`,
          remediation: declined
            ? "Run 'Fabric: Sign In' again and complete the sign-in prompt."
            : "Check your network connection, then run 'Fabric: Sign In' to re-authenticate.",
          cause,
        },
      );
    }
    if (session === undefined) {
      throw new AuthError(`No authentication session exists for tenant ${tenantId}.`, {
        operation: 'acquire token',
        entity: `tenant ${tenantId}`,
        remediation: "Run 'Fabric: Sign In' to authenticate this tenant.",
      });
    }
    return session.accessToken;
  }
}
