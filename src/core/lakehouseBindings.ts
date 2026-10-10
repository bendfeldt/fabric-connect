/**
 * Local Lakehouse bindings: which deployed Lakehouse a notebook's unbound
 * default Lakehouse (placeholder or logical IDs from git) runs on, on this
 * machine. Kept under `"lakehouseBindings"` in the gitignored
 * `.fabric/local.json`, keyed by the notebook's repo-relative item folder,
 * so binding never changes the committed notebook (no git diff) and leaves
 * Fabric's logical IDs in place for auto-binding in other workspaces.
 *
 * Pure functions over text: reading validates loudly, writing preserves
 * every other key in the file.
 */

import * as path from "node:path";
import { TargetConfigError } from "./errors";
import { LOCAL_OVERRIDE_FILE } from "./targetResolver";
import { isRecord } from "./types";

export interface LakehouseBinding {
  readonly lakehouseId: string;
  readonly workspaceId: string;
  readonly lakehouseName?: string;
  readonly workspaceName?: string;
}

const KEY = "lakehouseBindings";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_GUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/**
 * The binding key of a notebook: its item folder relative to the repo root,
 * with `/` separators (`notebooks/Load.Notebook`). Undefined for a folder
 * outside the repo.
 */
export function notebookKey(
  repoRoot: string,
  notebookFolder: string,
): string | undefined {
  const relative = path
    .relative(repoRoot, notebookFolder)
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .join("/");
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return relative;
}

/**
 * Every binding in `.fabric/local.json` text; empty when the file or the
 * section is absent. Throws a `TargetConfigError` naming the bad entry when
 * the section is present but invalid.
 */
export function readLakehouseBindings(
  localText: string | undefined,
): Map<string, LakehouseBinding> {
  const bindings = new Map<string, LakehouseBinding>();
  if (localText === undefined || localText.trim().length === 0) {
    return bindings;
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
  const section = parsed[KEY];
  if (section === undefined) {
    return bindings;
  }
  if (!isRecord(section)) {
    throw invalid(`"${KEY}" must be an object`);
  }
  for (const [key, value] of Object.entries(section)) {
    bindings.set(key, parseBinding(key, value));
  }
  return bindings;
}

/**
 * Returns new `.fabric/local.json` text with the notebook's binding set,
 * or removed for `undefined` (and the section with it when it empties),
 * keeping every other key as it was.
 */
export function writeLakehouseBinding(
  localText: string | undefined,
  key: string,
  binding: LakehouseBinding | undefined,
): string {
  let root: Record<string, unknown> = {};
  if (localText !== undefined && localText.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(localText);
    } catch (cause) {
      throw invalid(
        "the file is not valid JSON, so the binding cannot be saved without losing its contents",
        cause,
      );
    }
    if (!isRecord(parsed)) {
      throw invalid("the root must be an object");
    }
    root = parsed;
  }
  const existing = root[KEY];
  const section: Record<string, unknown> = isRecord(existing)
    ? { ...existing }
    : {};
  if (binding === undefined) {
    delete section[key];
  } else {
    section[key] = { ...parseBinding(key, binding) };
  }
  if (Object.keys(section).length === 0) {
    delete root[KEY];
  } else {
    root[KEY] = section;
  }
  return JSON.stringify(root, undefined, 2) + "\n";
}

function parseBinding(key: string, value: unknown): LakehouseBinding {
  if (!isRecord(value)) {
    throw invalid(`"${KEY}.${key}" must be an object`);
  }
  for (const field of ["lakehouseId", "workspaceId"] as const) {
    const id = value[field];
    if (typeof id !== "string" || !GUID.test(id) || NIL_GUID.test(id)) {
      throw invalid(`"${KEY}.${key}.${field}" must be a real (non-zero) GUID`);
    }
  }
  const binding: Record<string, string> = {
    lakehouseId: value["lakehouseId"] as string,
    workspaceId: value["workspaceId"] as string,
  };
  for (const field of ["lakehouseName", "workspaceName"] as const) {
    if (typeof value[field] === "string") {
      binding[field] = value[field] as string;
    }
  }
  return binding as unknown as LakehouseBinding;
}

function invalid(why: string, cause?: unknown): TargetConfigError {
  return new TargetConfigError(
    `The Lakehouse bindings in '${LOCAL_OVERRIDE_FILE}' are invalid: ${why}.`,
    {
      operation: "read lakehouse bindings",
      entity: `file ${LOCAL_OVERRIDE_FILE}`,
      remediation:
        'Unbind and bind the notebook\'s Lakehouse again (Lakehouses view), or fix the "lakehouseBindings" section by hand.',
      cause,
    },
  );
}
