/**
 * Pulling an item into the repo: fetch its definition once
 * (`POST …/items/{id}/getDefinition`, a read despite the verb) and write the
 * parts into `<displayName>.<Type>/` — the layout Fabric's git integration
 * uses. This is a clone, not a sync: there is no push, and an existing
 * folder is never overwritten, because local is the source of truth.
 *
 * getDefinition may answer 202 and finish as a long-running operation;
 * `awaitOperation` follows it through `/operations/{id}`.
 */

import * as path from "node:path";
import { PullError } from "./errors";
import type { FabricResponse, IFabricApiClient } from "./types";

export interface DefinitionPart {
  /** Path inside the item folder, e.g. `notebook-content.py`. */
  readonly path: string;
  readonly data: Uint8Array;
}

export interface OperationOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
}

const OPERATION_ID = /^[0-9A-Za-z-]+$/;

/**
 * Returns the final body of a request that may be long-running: the body
 * itself for a 200/201, or the operation's result after polling for a 202.
 */
export async function awaitOperation<T>(
  api: IFabricApiClient,
  tenantId: string,
  response: FabricResponse<T>,
  what: string,
  options: OperationOptions = {},
): Promise<T> {
  if (response.status !== 202) {
    return response.body;
  }
  const operationId = response.operationId;
  if (operationId === undefined || !OPERATION_ID.test(operationId)) {
    throw new PullError(
      `Fabric accepted the request to ${what} but gave no operation to follow.`,
      {
        operation: what,
        remediation: "Retry in a moment.",
      },
    );
  }
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  let wait = (response.retryAfterSeconds ?? 2) * 1000;
  for (;;) {
    await sleep(wait);
    const state = await api.request<{
      status?: string;
      error?: { message?: string };
    }>({ method: "GET", path: `/operations/${operationId}`, tenantId });
    const status = state.body?.status;
    if (status === "Succeeded") {
      const result = await api.request<T>({
        method: "GET",
        path: `/operations/${operationId}/result`,
        tenantId,
      });
      return result.body;
    }
    if (status === "Failed" || status === "Undefined") {
      throw new PullError(
        `Fabric failed to ${what}: ${state.body?.error?.message ?? "the operation failed"}.`,
        {
          operation: what,
          remediation: "Check your access to the item, then retry.",
        },
      );
    }
    if (Date.now() >= deadline) {
      throw new PullError(`Timed out waiting for Fabric to ${what}.`, {
        operation: what,
        remediation: "Retry later; large items can take several minutes.",
      });
    }
    wait = (state.retryAfterSeconds ?? 2) * 1000;
  }
}

/** Fetches and decodes an item's definition parts. */
export async function getItemDefinition(
  api: IFabricApiClient,
  tenantId: string,
  workspaceId: string,
  itemId: string,
  format?: string,
  options: OperationOptions = {},
): Promise<DefinitionPart[]> {
  const what = "read the item definition";
  let body: {
    definition?: { parts?: Array<Record<string, unknown>> };
  };
  try {
    const response = await api.request<typeof body>({
      method: "POST",
      path: `/workspaces/${workspaceId}/items/${itemId}/getDefinition${format === undefined ? "" : `?format=${encodeURIComponent(format)}`}`,
      tenantId,
    });
    body = await awaitOperation(api, tenantId, response, what, options);
  } catch (cause) {
    if (cause instanceof PullError) {
      throw cause;
    }
    throw new PullError("Failed to read the item definition from Fabric.", {
      operation: what,
      entity: "item",
      remediation:
        "Check that the item type supports definitions and that you have at least Contributor access, then retry.",
      cause,
    });
  }
  const parts = body?.definition?.parts ?? [];
  return parts.map((part, index) => {
    const partPath = part["path"];
    const payload = part["payload"];
    if (typeof partPath !== "string" || typeof payload !== "string") {
      throw new PullError(
        `The item definition from Fabric has a malformed part (#${index}).`,
        {
          operation: what,
          remediation: "Retry; if it persists, report it as a service issue.",
        },
      );
    }
    return {
      path: safePartPath(partPath),
      data: new Uint8Array(Buffer.from(payload, "base64")),
    };
  });
}

/** The folder name Fabric's git integration uses for an item. */
export function itemFolderName(displayName: string, type: string): string {
  const safeName = displayName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  return `${safeName}.${type}`;
}

/**
 * A definition part path, checked to stay inside the item folder (no
 * absolute paths, no `..`), so a malicious or malformed response can never
 * write outside it.
 */
export function safePartPath(partPath: string): string {
  const normalized = path.posix.normalize(partPath.replace(/\\/g, "/"));
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized === "." ||
    normalized.length === 0
  ) {
    throw new PullError(
      `Refusing to write definition part '${partPath}': it points outside the item folder.`,
      {
        operation: "read the item definition",
        remediation: "Report this item; its definition is malformed.",
      },
    );
  }
  return normalized;
}
