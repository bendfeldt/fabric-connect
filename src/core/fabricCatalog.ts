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

/**
 * The capacities behind the user's workspaces, plus any others they can
 * list. Workspace members usually cannot list `/capacities` (it needs
 * admin or contributor rights on the capacity), yet every workspace names
 * its `capacityId`; such capacities appear as `Capacity <id prefix>` with
 * state "Unknown", so they can still be seen and selected.
 */
export function capacitiesFromWorkspaces(
  workspaces: readonly WorkspaceInfo[],
  listed: readonly CapacityInfo[],
): CapacityInfo[] {
  const capacities = [...listed];
  const known = new Set(listed.map((c) => c.id.toLowerCase()));
  for (const workspace of workspaces) {
    const id = workspace.capacityId;
    if (id === undefined || known.has(id.toLowerCase())) {
      continue;
    }
    known.add(id.toLowerCase());
    capacities.push({
      id,
      displayName: placeholderName(id),
      sku: "",
      region: "",
      state: "Unknown",
    });
  }
  return capacities;
}

/**
 * Capacities from the Power BI REST API (`GET /v1.0/myorg/capacities`), a
 * second source of display names next to Fabric's `/capacities`. Read-only.
 */
export async function listPowerBiCapacities(
  api: IFabricApiClient,
  tenantId: string,
): Promise<CapacityInfo[]> {
  const raw = await wrap("list Power BI capacities", async () => {
    const response = await api.request<Page<Record<string, unknown>>>({
      method: "GET",
      path: "/v1.0/myorg/capacities",
      tenantId,
      service: { kind: "powerbi" },
    });
    return response.body?.value ?? [];
  });
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

/**
 * Merges capacity lists from several sources: one entry per ID (case-
 * insensitive), in first-seen order. A real name beats an ID placeholder;
 * otherwise the earlier source wins, with its gaps filled by later ones.
 */
export function mergeCapacities(
  ...lists: ReadonlyArray<readonly CapacityInfo[]>
): CapacityInfo[] {
  const merged = new Map<string, CapacityInfo>();
  for (const list of lists) {
    for (const capacity of list) {
      const key = capacity.id.toLowerCase();
      const seen = merged.get(key);
      if (seen === undefined) {
        merged.set(key, capacity);
        continue;
      }
      const named = (c: CapacityInfo) =>
        c.displayName !== c.id && !isPlaceholderName(c);
      merged.set(key, {
        id: seen.id,
        displayName:
          named(seen) || !named(capacity)
            ? seen.displayName
            : capacity.displayName,
        sku: seen.sku || capacity.sku,
        region: seen.region || capacity.region,
        state: seen.state === "Unknown" ? capacity.state : seen.state,
      });
    }
  }
  return [...merged.values()];
}

/** True for the `Capacity <id prefix>` name given to capacities not listed. */
export function isPlaceholderName(
  capacity: Pick<CapacityInfo, "id" | "displayName">,
): boolean {
  return capacity.displayName === placeholderName(capacity.id);
}

function placeholderName(id: string): string {
  return `Capacity ${id.slice(0, 8)}`;
}

/**
 * Workspaces and the capacities behind them: Fabric's and Power BI's
 * capacity lists merged, plus those only known from a workspace (see
 * `capacitiesFromWorkspaces`). Not being allowed to list capacities is
 * normal for workspace members; that failure is returned as `listError`
 * (to say why names are missing) instead of thrown. Failing to list
 * workspaces still throws.
 */
export async function listUsableCapacities(
  api: IFabricApiClient,
  tenantId: string,
): Promise<{
  capacities: CapacityInfo[];
  workspaces: WorkspaceInfo[];
  listError?: string;
}> {
  const errors: string[] = [];
  const attempt = (list: Promise<CapacityInfo[]>) =>
    list.catch((error: unknown): CapacityInfo[] => {
      errors.push(error instanceof Error ? error.message : String(error));
      return [];
    });
  const [fabric, powerBi, workspaces] = await Promise.all([
    attempt(listCapacities(api, tenantId)),
    attempt(listPowerBiCapacities(api, tenantId)),
    listWorkspaces(api, tenantId),
  ]);
  return {
    capacities: capacitiesFromWorkspaces(
      workspaces,
      mergeCapacities(fabric, powerBi),
    ),
    workspaces,
    ...(errors.length === 0 ? {} : { listError: errors.join(" ") }),
  };
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

/**
 * The capacity a workspace runs on, as shown next to it: `F64 · prod-cap`,
 * plus the state when it is not running. A capacity the user cannot list
 * (no admin or contributor rights on it) is "unknown capacity".
 */
export function describeWorkspaceCapacity(
  workspace: WorkspaceInfo,
  capacities: readonly CapacityInfo[],
): string {
  if (workspace.capacityId === undefined) {
    return "no capacity";
  }
  const id = workspace.capacityId.toLowerCase();
  const capacity = capacities.find((c) => c.id.toLowerCase() === id);
  if (capacity === undefined) {
    return "unknown capacity";
  }
  return [
    capacity.sku,
    capacity.displayName,
    capacity.state === "Active" || capacity.state === "Unknown"
      ? undefined
      : capacity.state,
  ]
    .filter(Boolean)
    .join(" · ");
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

/** A Lakehouse found in a workspace, for binding by name. */
export interface LakehouseInWorkspace {
  readonly lakehouse: NamedItem;
  readonly workspace: Pick<WorkspaceInfo, "id" | "displayName">;
}

/**
 * The Lakehouses whose display name matches (case-insensitive, trimmed, as
 * Fabric compares item names), sorted by workspace name. Used to bind a
 * notebook's unbound default Lakehouse by the name its metadata keeps.
 */
export function findLakehousesByName(
  name: string,
  candidates: readonly LakehouseInWorkspace[],
): LakehouseInWorkspace[] {
  const wanted = name.trim().toLowerCase();
  return candidates
    .filter((c) => c.lakehouse.displayName.trim().toLowerCase() === wanted)
    .sort((a, b) =>
      a.workspace.displayName.localeCompare(b.workspace.displayName),
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
