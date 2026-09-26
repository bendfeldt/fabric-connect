/**
 * Read-only catalog of the Fabric compute a repo can connect to:
 * capacities (the SKUs), the workspaces assigned to one, and the Lakehouses
 * and Environments inside a workspace. All calls are GETs through the shared
 * API client; list endpoints are followed through their continuation tokens.
 */

import { ComputeError } from "./errors";
import type { IFabricApiClient } from "./types";

export interface CapacityInfo {
  readonly id: string;
  readonly displayName: string;
  readonly sku: string;
  readonly region: string;
  /** "Active" when running; anything else (e.g. "Inactive") cannot run Spark. */
  readonly state: string;
}

export interface WorkspaceInfo {
  readonly id: string;
  readonly displayName: string;
  readonly type: string;
  readonly capacityId?: string;
}

export interface NamedItem {
  readonly id: string;
  readonly displayName: string;
}

interface Page<T> {
  value?: T[];
  continuationToken?: string;
}

/** Hard stop against a service that keeps returning continuation tokens. */
const MAX_PAGES = 100;

/** Follows `continuationToken` until the list is complete. */
export async function listAll<T>(
  api: IFabricApiClient,
  tenantId: string,
  path: string,
): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const pagePath =
      token === undefined
        ? path
        : `${path}${separator}continuationToken=${encodeURIComponent(token)}`;
    const response = await api.request<Page<T>>({
      method: "GET",
      path: pagePath,
      tenantId,
    });
    items.push(...(response.body?.value ?? []));
    token = response.body?.continuationToken ?? undefined;
    if (token === undefined || token.length === 0) {
      return items;
    }
  }
  throw new ComputeError(
    `Listing '${path.split("?")[0].replace(/[0-9a-f-]{36}/gi, "<id>")}' did not finish after ${MAX_PAGES} pages.`,
    {
      operation: "list Fabric resources",
      remediation:
        "Retry; if it persists, narrow the listing or report it as a service issue.",
    },
  );
}

export async function listCapacities(
  api: IFabricApiClient,
  tenantId: string,
): Promise<CapacityInfo[]> {
  const raw = await wrap("list capacities", () =>
    listAll<Record<string, unknown>>(api, tenantId, "/capacities"),
  );
  return raw.flatMap((c) => {
    const id = str(c["id"]);
    return id === undefined
      ? []
      : [
          {
            id,
            displayName: str(c["displayName"]) ?? id,
            sku: str(c["sku"]) ?? "",
            region: str(c["region"]) ?? "",
            state: str(c["state"]) ?? "Unknown",
          },
        ];
  });
}

/** Workspaces visible to the user; filtered to one capacity when given. */
export async function listWorkspaces(
  api: IFabricApiClient,
  tenantId: string,
  capacityId?: string,
): Promise<WorkspaceInfo[]> {
  const raw = await wrap("list workspaces", () =>
    listAll<Record<string, unknown>>(api, tenantId, "/workspaces"),
  );
  return raw
    .flatMap((w) => {
      const id = str(w["id"]);
      return id === undefined
        ? []
        : [
            {
              id,
              displayName: str(w["displayName"]) ?? id,
              type: str(w["type"]) ?? "Workspace",
              capacityId: str(w["capacityId"]),
            },
          ];
    })
    .filter(
      (w) =>
        capacityId === undefined ||
        w.capacityId?.toLowerCase() === capacityId.toLowerCase(),
    );
}

export function listLakehouses(
  api: IFabricApiClient,
  tenantId: string,
  workspaceId: string,
): Promise<NamedItem[]> {
  return listNamed(
    api,
    tenantId,
    `/workspaces/${workspaceId}/lakehouses`,
    "list lakehouses",
  );
}

export function listEnvironments(
  api: IFabricApiClient,
  tenantId: string,
  workspaceId: string,
): Promise<NamedItem[]> {
  return listNamed(
    api,
    tenantId,
    `/workspaces/${workspaceId}/environments`,
    "list environments",
  );
}

async function listNamed(
  api: IFabricApiClient,
  tenantId: string,
  path: string,
  operation: string,
): Promise<NamedItem[]> {
  const raw = await wrap(operation, () =>
    listAll<Record<string, unknown>>(api, tenantId, path),
  );
  return raw.flatMap((item) => {
    const id = str(item["id"]);
    return id === undefined
      ? []
      : [{ id, displayName: str(item["displayName"]) ?? id }];
  });
}

async function wrap<T>(
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    if (cause instanceof ComputeError) {
      throw cause;
    }
    throw new ComputeError(`Failed to ${operation}.`, {
      operation,
      entity: "signed-in tenant",
      remediation:
        "Check that you are signed in to the right tenant ('Fabric: Sign In') and have access, then retry.",
      cause,
    });
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
