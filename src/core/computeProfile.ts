/**
 * Compute profile: the Fabric compute a repo is "connected" to, the way a
 * Databricks Connect project is connected to a cluster. It names a capacity
 * (the SKU that is billed), a workspace on that capacity, and the Lakehouse
 * that hosts Livy sessions — plus an optional Environment.
 *
 * The profile lives under `"compute"` in the gitignored `.fabric/local.json`
 * next to the per-target workspace IDs: it identifies client capacities and
 * workspaces, so it must never be committed. Display names are stored only
 * so the status bar can show them without an API call.
 *
 * Pure functions over text: reading validates loudly (a malformed profile
 * must never silently run against the wrong workspace), writing preserves
 * every other key in the file.
 */

import { TargetConfigError } from "./errors";
import { LOCAL_OVERRIDE_FILE } from "./targetResolver";

export interface ComputeProfile {
  readonly tenantId: string;
  readonly capacityId: string;
  readonly workspaceId: string;
  readonly lakehouseId: string;
  readonly environmentId?: string;
  readonly capacityName?: string;
  readonly sku?: string;
  readonly workspaceName?: string;
  readonly lakehouseName?: string;
  readonly environmentName?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED_IDS = [
  "tenantId",
  "capacityId",
  "workspaceId",
  "lakehouseId",
] as const;
const OPTIONAL_NAMES = [
  "capacityName",
  "sku",
  "workspaceName",
  "lakehouseName",
  "environmentName",
] as const;

/**
 * Returns the compute profile from `.fabric/local.json` text, `undefined`
 * when the file or its `"compute"` section is absent, and throws a
 * `TargetConfigError` naming the bad field when it is present but invalid.
 */
export function readComputeProfile(
  localText: string | undefined,
): ComputeProfile | undefined {
  if (localText === undefined) {
    return undefined;
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
  const compute = parsed["compute"];
  if (compute === undefined) {
    return undefined;
  }
  if (!isRecord(compute)) {
    throw invalid('"compute" must be an object');
  }
  const profile: Record<string, string> = {};
  for (const key of REQUIRED_IDS) {
    const value = compute[key];
    if (typeof value !== "string" || !GUID.test(value)) {
      throw invalid(`"compute.${key}" must be a GUID`);
    }
    profile[key] = value;
  }
  const environmentId = compute["environmentId"];
  if (environmentId !== undefined) {
    if (typeof environmentId !== "string" || !GUID.test(environmentId)) {
      throw invalid('"compute.environmentId" must be a GUID when present');
    }
    profile["environmentId"] = environmentId;
  }
  for (const key of OPTIONAL_NAMES) {
    const value = compute[key];
    if (typeof value === "string") {
      profile[key] = value;
    }
  }
  return profile as unknown as ComputeProfile;
}

/**
 * Returns new `.fabric/local.json` text with the `"compute"` section set
 * (or removed, for `undefined`), keeping every other key as it was.
 */
export function writeComputeProfile(
  localText: string | undefined,
  profile: ComputeProfile | undefined,
): string {
  let root: Record<string, unknown> = {};
  if (localText !== undefined && localText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(localText);
    } catch (cause) {
      throw invalid(
        "the file is not valid JSON, so the compute connection cannot be saved without losing its contents",
        cause,
      );
    }
    if (!isRecord(parsed)) {
      throw invalid("the root must be an object");
    }
    root = parsed;
  }
  if (profile === undefined) {
    delete root["compute"];
  } else {
    root["compute"] = { ...profile };
  }
  return JSON.stringify(root, undefined, 2) + "\n";
}

/** A short human label for the status bar and messages; never shows IDs. */
export function describeCompute(profile: ComputeProfile): string {
  const capacity = [profile.capacityName, profile.sku]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" ");
  const place = `${profile.workspaceName ?? "workspace"} / ${profile.lakehouseName ?? "lakehouse"}`;
  return capacity.length > 0 ? `${capacity} · ${place}` : place;
}

function invalid(why: string, cause?: unknown): TargetConfigError {
  return new TargetConfigError(
    `The compute connection in '${LOCAL_OVERRIDE_FILE}' is invalid: ${why}.`,
    {
      operation: "read compute connection",
      entity: `file ${LOCAL_OVERRIDE_FILE}`,
      remediation:
        "Run 'Fabric: Connect to Compute' to write a fresh connection, or fix the \"compute\" section by hand.",
      cause,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
