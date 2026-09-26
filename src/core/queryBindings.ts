/**
 * Which remote item a local query file runs against. A `.kql` file needs a
 * KQL database, a `.dax` file a semantic model, a `.graphql` file a GraphQL
 * API. The binding is picked once per file and kept under
 * `"queryBindings"` in the gitignored `.fabric/local.json` (it holds
 * workspace and item IDs), keyed by the file's workspace-relative path.
 */

import { TargetConfigError } from "./errors";
import type { QueryKind } from "./queryExecutors";
import { LOCAL_OVERRIDE_FILE } from "./targetResolver";

export interface QueryBinding {
  readonly kind: QueryKind;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly itemId: string;
  readonly displayName: string;
  /** KQL only: the database's query service URI. */
  readonly queryServiceUri?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly QueryKind[] = ["kql", "dax", "graphql"];

/** The query kind for a file name, or undefined when it is not a query file. */
export function queryKindOf(fileName: string): QueryKind | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".kql") || lower.endsWith(".csl")) {
    return "kql";
  }
  if (lower.endsWith(".dax")) {
    return "dax";
  }
  if (lower.endsWith(".graphql") || lower.endsWith(".gql")) {
    return "graphql";
  }
  return undefined;
}

export function readQueryBinding(
  localText: string | undefined,
  relPath: string,
): QueryBinding | undefined {
  const root = parseRoot(localText);
  const bindings = root["queryBindings"];
  if (bindings === undefined) {
    return undefined;
  }
  if (!isRecord(bindings)) {
    throw invalid('"queryBindings" must be an object');
  }
  const entry = bindings[normalize(relPath)];
  if (entry === undefined) {
    return undefined;
  }
  if (!isRecord(entry)) {
    throw invalid(`the binding for '${relPath}' must be an object`);
  }
  const kind = entry["kind"];
  if (typeof kind !== "string" || !KINDS.includes(kind as QueryKind)) {
    throw invalid(`the binding for '${relPath}' has no valid "kind"`);
  }
  for (const key of ["tenantId", "workspaceId", "itemId"]) {
    const value = entry[key];
    if (typeof value !== "string" || !GUID.test(value)) {
      throw invalid(`"${key}" of the binding for '${relPath}' must be a GUID`);
    }
  }
  const uri = entry["queryServiceUri"];
  return {
    kind: kind as QueryKind,
    tenantId: entry["tenantId"] as string,
    workspaceId: entry["workspaceId"] as string,
    itemId: entry["itemId"] as string,
    displayName:
      typeof entry["displayName"] === "string" ? entry["displayName"] : "",
    ...(typeof uri === "string" ? { queryServiceUri: uri } : {}),
  };
}

export function writeQueryBinding(
  localText: string | undefined,
  relPath: string,
  binding: QueryBinding,
): string {
  const root = parseRoot(localText);
  const existing = root["queryBindings"];
  const bindings = isRecord(existing) ? existing : {};
  bindings[normalize(relPath)] = { ...binding };
  root["queryBindings"] = bindings;
  return JSON.stringify(root, undefined, 2) + "\n";
}

function normalize(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

function parseRoot(localText: string | undefined): Record<string, unknown> {
  if (localText === undefined || localText.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(localText);
  } catch (cause) {
    throw invalid("the file is not valid JSON", cause);
  }
  if (!isRecord(parsed)) {
    throw invalid("the root must be an object");
  }
  return parsed;
}

function invalid(why: string, cause?: unknown): TargetConfigError {
  return new TargetConfigError(
    `The query bindings in '${LOCAL_OVERRIDE_FILE}' are invalid: ${why}.`,
    {
      operation: "read query binding",
      entity: `file ${LOCAL_OVERRIDE_FILE}`,
      remediation:
        "Run 'Fabric: Change Query Target' to write a fresh binding, or fix \"queryBindings\" by hand.",
      cause,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
