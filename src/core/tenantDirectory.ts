/**
 * Tenant Directory: finds the Entra tenants a user can sign in to, so they
 * pick a tenant by name instead of pasting a GUID.
 *
 * - `listAccountTenants` asks Azure Resource Manager (`GET /tenants`, the
 *   only ARM call the write policy allows) for every tenant the signed-in
 *   account belongs to, home and guest.
 * - `resolveTenantDomain` turns a domain such as `contoso.onmicrosoft.com`
 *   into its tenant ID through the public, unauthenticated OpenID discovery
 *   document; no token is sent.
 * - `mergeTenantChoices` combines recent, configured and discovered tenants
 *   into one de-duplicated list for the picker.
 */

import { ARM_TENANTS_API_VERSION, HOME_TENANT } from "./constants";
import { AuthError } from "./errors";
import type { IFabricApiClient } from "./types";

export interface TenantInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly defaultDomain?: string;
}

export type TenantInput =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "domain"; readonly domain: string };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A DNS name with at least one dot, e.g. `contoso.onmicrosoft.com`. */
const DOMAIN =
  /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ARM_ORIGIN = "https://management.azure.com";
const MAX_PAGES = 10;

export function isTenantId(value: string): boolean {
  return GUID.test(value);
}

/** Classifies what the user typed: a tenant GUID, a domain, or neither. */
export function parseTenantInput(value: string): TenantInput | undefined {
  const trimmed = value.trim();
  if (GUID.test(trimmed)) {
    return { kind: "id", id: trimmed.toLowerCase() };
  }
  if (DOMAIN.test(trimmed)) {
    return { kind: "domain", domain: trimmed.toLowerCase() };
  }
  return undefined;
}

interface ArmTenant {
  tenantId?: unknown;
  displayName?: unknown;
  defaultDomain?: unknown;
}

interface ArmTenantPage {
  value?: ArmTenant[];
  nextLink?: unknown;
}

/**
 * Every tenant the signed-in account belongs to, sorted by name. Signs in
 * to the account's home tenant with the Azure Resource Manager scope.
 */
export async function listAccountTenants(
  api: IFabricApiClient,
): Promise<TenantInfo[]> {
  const tenants = new Map<string, TenantInfo>();
  let path: string | undefined =
    `/tenants?api-version=${ARM_TENANTS_API_VERSION}`;
  for (let page = 0; path !== undefined && page < MAX_PAGES; page++) {
    const response: { body: ArmTenantPage } = await api.request<ArmTenantPage>({
      method: "GET",
      path,
      tenantId: HOME_TENANT,
      service: { kind: "arm" },
    });
    for (const entry of response.body?.value ?? []) {
      if (typeof entry.tenantId !== "string" || !isTenantId(entry.tenantId)) {
        continue;
      }
      const id = entry.tenantId.toLowerCase();
      tenants.set(id, {
        id,
        displayName:
          typeof entry.displayName === "string" && entry.displayName !== ""
            ? entry.displayName
            : undefined,
        defaultDomain:
          typeof entry.defaultDomain === "string" && entry.defaultDomain !== ""
            ? entry.defaultDomain
            : undefined,
      });
    }
    path = nextPath(response.body?.nextLink);
  }
  return [...tenants.values()].sort((a, b) => label(a).localeCompare(label(b)));
}

/** A `nextLink` as a path, only if it stays on the ARM origin. */
function nextPath(nextLink: unknown): string | undefined {
  if (typeof nextLink !== "string" || nextLink === "") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    return undefined;
  }
  return url.origin === ARM_ORIGIN ? url.pathname + url.search : undefined;
}

/**
 * The tenant ID for a verified domain, from the public OpenID discovery
 * document at login.microsoftonline.com. Sends no token.
 */
export async function resolveTenantDomain(
  domain: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (!DOMAIN.test(domain)) {
    throw domainError(domain, `'${domain}' is not a domain name.`);
  }
  const url = `https://login.microsoftonline.com/${encodeURIComponent(domain)}/v2.0/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetchFn(url, { method: "GET" });
  } catch (cause) {
    throw domainError(
      domain,
      `Could not reach login.microsoftonline.com to look up '${domain}'.`,
      "Check your network connection, or enter the tenant ID (GUID) instead.",
      cause,
    );
  }
  if (!response.ok) {
    throw domainError(
      domain,
      `No Entra tenant was found for '${domain}' (HTTP ${response.status}).`,
    );
  }
  let issuer: unknown;
  try {
    issuer = ((await response.json()) as { issuer?: unknown }).issuer;
  } catch (cause) {
    throw domainError(
      domain,
      `The tenant lookup for '${domain}' returned an unreadable response.`,
      undefined,
      cause,
    );
  }
  const id =
    typeof issuer === "string"
      ? /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0\/?$/i.exec(
          issuer,
        )?.[1]
      : undefined;
  if (id === undefined || !isTenantId(id)) {
    throw domainError(
      domain,
      `The tenant lookup for '${domain}' did not return a tenant ID.`,
    );
  }
  return id.toLowerCase();
}

function domainError(
  domain: string,
  message: string,
  remediation = "Check the spelling (e.g. contoso.onmicrosoft.com), or enter the tenant ID (GUID) from Entra admin center → Overview.",
  cause?: unknown,
): AuthError {
  return new AuthError(message, {
    operation: "look up tenant",
    entity: `domain ${domain}`,
    remediation,
    cause,
  });
}

/**
 * One list for the picker: earlier sources win on order, and any source
 * that knows a tenant's name or domain fills it in. IDs compare
 * case-insensitively; invalid IDs are dropped.
 */
export function mergeTenantChoices(
  ...sources: ReadonlyArray<readonly TenantInfo[]>
): TenantInfo[] {
  const merged = new Map<string, TenantInfo>();
  for (const source of sources) {
    for (const tenant of source) {
      if (!isTenantId(tenant.id)) {
        continue;
      }
      const id = tenant.id.toLowerCase();
      const known = merged.get(id);
      merged.set(id, {
        id,
        displayName: known?.displayName ?? tenant.displayName,
        defaultDomain: known?.defaultDomain ?? tenant.defaultDomain,
      });
    }
  }
  return [...merged.values()];
}

/** How a tenant is shown: its name, else its domain, else its ID. */
export function label(tenant: TenantInfo): string {
  return tenant.displayName ?? tenant.defaultDomain ?? tenant.id;
}
