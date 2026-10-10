/**
 * Compute profile: the Fabric capacity a repo is "connected" to, the way a
 * Databricks Connect project is connected to a cluster. Connecting names
 * only the capacity (the SKU that is billed). Code without a Lakehouse of
 * its own also needs a host Lakehouse for its Livy session: a workspace on
 * that capacity and a Lakehouse in it (plus an optional Environment),
 * picked the first time such code runs and saved alongside.
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
import { isRecord } from "./types";

export interface ComputeProfile {
  readonly tenantId: string;
  readonly capacityId: string;
  /** Host Lakehouse: `workspaceId` and `lakehouseId` are set together. */
  readonly workspaceId?: string;
  readonly lakehouseId?: string;
  /** Only with a host. */
  readonly environmentId?: string;
  readonly capacityName?: string;
  /**
   * A name the user gave the capacity when its real name is not visible to
   * them (no rights on the capacity itself); shown instead of `capacityName`.
   */
  readonly capacityLabel?: string;
  readonly sku?: string;
  readonly workspaceName?: string;
  readonly lakehouseName?: string;
  readonly environmentName?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED_IDS = ["tenantId", "capacityId"] as const;
const HOST_IDS = ["workspaceId", "lakehouseId"] as const;
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
  const present = HOST_IDS.filter((key) => compute[key] !== undefined);
  if (present.length === 1) {
    throw invalid(
      '"compute.workspaceId" and "compute.lakehouseId" name the host Lakehouse together: set both or neither',
    );
  }
  for (const key of present) {
    const value = compute[key];
    if (typeof value !== "string" || !GUID.test(value)) {
      throw invalid(`"compute.${key}" must be a GUID when present`);
    }
    profile[key] = value;
  }
  const environmentId = compute["environmentId"];
  if (environmentId !== undefined) {
    if (typeof environmentId !== "string" || !GUID.test(environmentId)) {
      throw invalid('"compute.environmentId" must be a GUID when present');
    }
    if (present.length === 0) {
      throw invalid(
        '"compute.environmentId" needs a host Lakehouse ("workspaceId" and "lakehouseId")',
      );
    }
    profile["environmentId"] = environmentId;
  }
  for (const key of OPTIONAL_NAMES) {
    const value = compute[key];
    if (typeof value === "string") {
      profile[key] = value;
    }
  }
  const label = compute["capacityLabel"];
  if (label !== undefined) {
    if (!isValidCapacityLabel(label)) {
      throw invalid(
        `"compute.capacityLabel" must be a non-empty name of at most ${MAX_LABEL} characters`,
      );
    }
    profile["capacityLabel"] = label.trim();
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
  const root = parseForWrite(localText);
  if (profile === undefined) {
    delete root["compute"];
  } else {
    root["compute"] = { ...profile };
  }
  return JSON.stringify(root, undefined, 2) + "\n";
}

/** The root object of existing local.json text, ready to be changed. */
function parseForWrite(localText: string | undefined): Record<string, unknown> {
  if (localText === undefined || localText.trim().length === 0) {
    return {};
  }
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
  return parsed;
}

/** A short human label for the status bar and messages; never shows IDs. */
export function describeCompute(profile: ComputeProfile): string {
  const capacity =
    [capacityDisplayName(profile), profile.sku]
      .filter((part) => part !== undefined && part.length > 0)
      .join(" ") || "capacity";
  if (hostOf(profile) === undefined) {
    return capacity;
  }
  return `${capacity} · ${profile.workspaceName ?? "workspace"} / ${profile.lakehouseName ?? "lakehouse"}`;
}

const MAX_LABEL = 100;

/** True for a usable capacity label: a non-blank string of ≤ 100 chars. */
export function isValidCapacityLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_LABEL
  );
}

/** The capacity's name as shown: the user's label, else the listed name. */
export function capacityDisplayName(
  profile: ComputeProfile,
): string | undefined {
  return profile.capacityLabel ?? profile.capacityName;
}

/** A compute profile whose host Lakehouse is set. */
export type HostedCompute = ComputeProfile & {
  readonly workspaceId: string;
  readonly lakehouseId: string;
};

/** The profile, typed as hosted, when its host Lakehouse is set. */
export function hostOf(profile: ComputeProfile): HostedCompute | undefined {
  return profile.workspaceId !== undefined && profile.lakehouseId !== undefined
    ? (profile as HostedCompute)
    : undefined;
}

/** The profile without its host Lakehouse (and Environment). */
export function withoutHost(profile: ComputeProfile): ComputeProfile {
  const {
    workspaceId: _w,
    lakehouseId: _l,
    environmentId: _e,
    workspaceName: _wn,
    lakehouseName: _ln,
    environmentName: _en,
    ...rest
  } = profile;
  return rest;
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
