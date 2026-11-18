import { FabricConnectError } from "./errors";
import { getItemDefinition } from "./itemDefinition";
import type { LivyTarget } from "./livySessionManager";
import type { PythonModuleMode } from "./moduleStaging";
import { isRecord, type IFabricApiClient } from "./types";

const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function invalid(message: string, cause?: unknown): FabricConnectError {
  return new FabricConnectError(message, {
    operation: "prepare notebook execution context",
    remediation:
      "Check fabric-connect.variableLibraries and access to the selected workspace's active Variable Library. Definition reads require existing item read/write permission; no authentication changes are made.",
    cause,
  });
}

function entries(value: unknown): Array<{ name: string; value: unknown }> {
  if (!Array.isArray(value)) {
    throw invalid("The Variable Library definition has no variables array.");
  }
  const names = new Set<string>();
  return value.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !Object.hasOwn(entry, "value") ||
      names.has(entry.name)
    ) {
      throw invalid(
        "The Variable Library contains invalid or duplicate variables.",
      );
    }
    names.add(entry.name);
    return { name: entry.name, value: entry.value };
  });
}

async function libraryValues(
  api: IFabricApiClient,
  target: LivyTarget,
  name: string,
  selected: readonly string[],
): Promise<unknown> {
  const matches: Record<string, unknown>[] = [];
  let continuation: string | undefined;
  const seen = new Set<string>();
  do {
    const response = await api.request<{
      value?: unknown;
      continuationToken?: unknown;
    }>({
      method: "GET",
      path: `/workspaces/${target.workspaceId}/items?type=VariableLibrary${continuation === undefined ? "" : `&continuationToken=${encodeURIComponent(continuation)}`}`,
      tenantId: target.tenantId,
    });
    if (!Array.isArray(response.body?.value)) {
      throw invalid("Fabric returned an invalid Variable Library listing.");
    }
    matches.push(
      ...response.body.value.filter(
        (item: unknown): item is Record<string, unknown> =>
          isRecord(item) &&
          item.displayName === name &&
          item.type === "VariableLibrary",
      ),
    );
    const next = response.body.continuationToken;
    if (next !== undefined && next !== null && typeof next !== "string") {
      throw invalid(
        "Fabric returned an invalid Variable Library continuation.",
      );
    }
    continuation =
      typeof next === "string" && next.length > 0 ? next : undefined;
    if (continuation !== undefined) {
      if (seen.has(continuation)) {
        throw invalid("Fabric repeated a Variable Library continuation.");
      }
      seen.add(continuation);
    }
  } while (continuation !== undefined);
  const id = matches.length === 1 ? matches[0].id : undefined;
  if (typeof id !== "string" || !GUID.test(id)) {
    throw invalid(`Cannot uniquely resolve Variable Library '${name}'.`);
  }
  const metadata = await api.request<{
    workspaceId?: unknown;
    properties?: { activeValueSetName?: unknown };
  }>({
    method: "GET",
    path: `/workspaces/${target.workspaceId}/variableLibraries/${id}`,
    tenantId: target.tenantId,
  });
  if (metadata.body.workspaceId !== target.workspaceId) {
    throw invalid("The Variable Library belongs to a different workspace.");
  }
  const active = metadata.body.properties?.activeValueSetName;
  if (typeof active !== "string" || active.length === 0) {
    throw invalid("The Variable Library active value set is unavailable.");
  }
  const parts = await getItemDefinition(
    api,
    target.tenantId,
    target.workspaceId,
    id,
  );
  const readPart = (partPath: string): Record<string, unknown> => {
    const matching = parts.filter(
      (part) => part.path.replace(/\\/g, "/") === partPath,
    );
    if (matching.length !== 1) {
      throw invalid(
        "The Variable Library definition has missing or duplicate parts.",
      );
    }
    const value: unknown = JSON.parse(
      Buffer.from(matching[0].data).toString("utf8"),
    );
    if (!isRecord(value)) {
      throw invalid("The Variable Library definition part must be an object.");
    }
    return value;
  };
  const values = new Map(
    entries(readPart("variables.json").variables).map(({ name, value }) => [
      name,
      value,
    ]),
  );
  if (active !== "Default value set") {
    const valueSets = parts.filter((part) =>
      /^valueSets[/\\][^/\\]+\.json$/.test(part.path),
    );
    const matching = valueSets.filter((part) => {
      const value = readPart(part.path.replace(/\\/g, "/"));
      return value.name === active;
    });
    if (matching.length !== 1) {
      throw invalid(
        "The active Variable Library value set cannot be uniquely resolved.",
      );
    }
    for (const { name, value } of entries(
      readPart(matching[0].path.replace(/\\/g, "/")).variableOverrides,
    )) {
      if (!values.has(name)) {
        throw invalid(
          "A Variable Library override names an undefined variable.",
        );
      }
      values.set(name, value);
    }
  }
  const picked = new Map<string, unknown>();
  for (const variable of selected) {
    if (!values.has(variable)) {
      throw invalid(
        `Variable Library '${name}' is missing a selected variable.`,
      );
    }
    picked.set(variable, values.get(variable));
  }
  return {
    workspace_id: target.workspaceId,
    active_value_set: active,
    values: Object.fromEntries(picked),
  };
}

export async function executionContextCode(
  api: IFabricApiClient,
  target: LivyTarget,
  moduleMode: PythonModuleMode,
  configured: unknown,
): Promise<string | undefined> {
  if (target.sessionScope === undefined) {
    return undefined;
  }
  if (!isRecord(configured)) {
    throw invalid(
      "fabric-connect.variableLibraries must map library names to variable lists.",
    );
  }
  if (Object.keys(configured).length > 1) {
    throw invalid("Only one Variable Library can be selected per workspace.");
  }
  const libraries = new Map<string, unknown>();
  try {
    for (const [name, selected] of Object.entries(configured)) {
      if (
        name.length === 0 ||
        !Array.isArray(selected) ||
        selected.length === 0 ||
        !selected.every(
          (value: unknown): value is string => typeof value === "string",
        ) ||
        new Set(selected).size !== selected.length
      ) {
        throw invalid(
          "Each configured Variable Library must have a nonempty variable-name list.",
        );
      }
      libraries.set(name, await libraryValues(api, target, name, selected));
    }
  } catch (cause) {
    throw invalid("Cannot resolve the selected notebook configuration.", cause);
  }
  const descriptor = JSON.stringify({
    schema_version: 1,
    workspace_id: target.workspaceId,
    lakehouse_id: target.lakehouseId,
    session_scope: target.sessionScope,
    module_mode: moduleMode,
    libraries: Object.fromEntries(libraries),
  });
  return [
    "import json as _fc_context_json",
    `_fabric_connect_execution = _fc_context_json.loads(${JSON.stringify(descriptor)})`,
    "del _fc_context_json",
  ].join("\n");
}
