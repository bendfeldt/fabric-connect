/**
 * Lakehouses are infrastructure (decision D3): created only when a run needs
 * one and none fits, and only with a `UserConfirmation` the VS Code layer
 * mints after an explicit modal. This is the single item-create path in the
 * extension; the write policy rejects it without that confirmation, and the
 * extension never updates or deletes a Lakehouse.
 */

import { LakehouseError } from "./errors";
import { type NamedItem, listLakehouses } from "./fabricCatalog";
import type { IFabricApiClient } from "./types";
import type { UserConfirmation } from "./writePolicy";

/** Fabric Lakehouse naming rule: a letter, then letters, digits or '_'. */
const LAKEHOUSE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,255}$/;

/** Returns why a name is invalid, or undefined when it is acceptable. */
export function validateLakehouseName(name: string): string | undefined {
  return LAKEHOUSE_NAME.test(name)
    ? undefined
    : "Use a letter first, then only letters, digits or underscores (max 256 characters).";
}

export interface CreateLakehouseOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export async function createLakehouse(
  api: IFabricApiClient,
  tenantId: string,
  workspaceId: string,
  displayName: string,
  confirmation: UserConfirmation,
  options: CreateLakehouseOptions = {},
): Promise<NamedItem> {
  const invalid = validateLakehouseName(displayName);
  if (invalid !== undefined) {
    throw new LakehouseError(
      `Cannot create Lakehouse '${displayName}': the name is not valid.`,
      {
        operation: "create lakehouse",
        entity: `lakehouse ${displayName}`,
        remediation: invalid,
      },
    );
  }
  const existing = await listLakehouses(api, tenantId, workspaceId);
  if (existing.some((l) => l.displayName === displayName)) {
    throw new LakehouseError(
      `Cannot create Lakehouse '${displayName}': a Lakehouse with that name already exists in the workspace.`,
      {
        operation: "create lakehouse",
        entity: `lakehouse ${displayName}`,
        remediation:
          "Pick the existing Lakehouse instead, or choose another name.",
      },
    );
  }

  let response;
  try {
    response = await api.request<Record<string, unknown> | undefined>({
      method: "POST",
      path: `/workspaces/${workspaceId}/lakehouses`,
      tenantId,
      body: { displayName },
      confirmation,
    });
  } catch (cause) {
    throw new LakehouseError(`Failed to create Lakehouse '${displayName}'.`, {
      operation: "create lakehouse",
      entity: `lakehouse ${displayName}`,
      remediation:
        "Check that you are a Contributor (or higher) on the workspace and that its capacity is running, then try again.",
      cause,
    });
  }

  const id = response.body?.["id"];
  if (response.status === 201 && typeof id === "string") {
    return { id, displayName };
  }
  // 202: provisioning continues server side; wait until it is listed.
  return waitUntilListed(api, tenantId, workspaceId, displayName, options);
}

async function waitUntilListed(
  api: IFabricApiClient,
  tenantId: string,
  workspaceId: string,
  displayName: string,
  options: CreateLakehouseOptions,
): Promise<NamedItem> {
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const interval = options.pollIntervalMs ?? 2000;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  for (;;) {
    const found = (await listLakehouses(api, tenantId, workspaceId)).find(
      (l) => l.displayName === displayName,
    );
    if (found !== undefined) {
      return found;
    }
    if (Date.now() >= deadline) {
      throw new LakehouseError(
        `Lakehouse '${displayName}' was accepted for creation but did not appear in the workspace in time.`,
        {
          operation: "create lakehouse",
          entity: `lakehouse ${displayName}`,
          remediation:
            "Wait a minute, then run 'Fabric: Connect to Compute' again and pick it from the list.",
        },
      );
    }
    await sleep(interval);
  }
}
