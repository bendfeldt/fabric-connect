import { FabricConnectError } from "./errors";
import { getItemDefinition } from "./itemDefinition";
import { isRecord, type IFabricApiClient } from "./types";

const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface VariableLibraryTarget {
  readonly tenantId: string;
  readonly workspaceId: string;
}

export interface VariableLibrary {
  readonly id: string;
  readonly name: string;
}

function invalid(message: string, cause?: unknown): FabricConnectError {
  return new FabricConnectError(message, {
    operation: "list Variable Libraries",
    remediation:
      "Check access to Variable Libraries in the selected Fabric workspace and retry.",
    cause,
  });
}

export async function listVariableLibraries(
  api: IFabricApiClient,
  target: VariableLibraryTarget,
): Promise<VariableLibrary[]> {
  const libraries: VariableLibrary[] = [];
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
    for (const item of response.body.value) {
      if (
        isRecord(item) &&
        item.type === "VariableLibrary" &&
        typeof item.id === "string" &&
        GUID.test(item.id) &&
        typeof item.displayName === "string" &&
        item.displayName.length > 0
      ) {
        libraries.push({ id: item.id, name: item.displayName });
      } else if (isRecord(item) && item.type === "VariableLibrary") {
        throw invalid("Fabric returned a malformed Variable Library item.");
      }
    }
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
  const names = new Set<string>();
  for (const library of libraries) {
    if (names.has(library.name)) {
      throw invalid("Variable Library names are not unique in this workspace.");
    }
    names.add(library.name);
  }
  return libraries;
}

export async function variableLibraryVariableNames(
  api: IFabricApiClient,
  target: VariableLibraryTarget,
  libraryId: string,
): Promise<string[]> {
  if (!GUID.test(libraryId)) {
    throw invalid("Fabric returned an invalid Variable Library ID.");
  }
  const parts = await getItemDefinition(
    api,
    target.tenantId,
    target.workspaceId,
    libraryId,
  );
  const matching = parts.filter(
    (part) => part.path.replace(/\\/g, "/") === "variables.json",
  );
  if (matching.length !== 1) {
    throw invalid(
      "The Variable Library definition has no unique variables.json part.",
    );
  }
  let definition: unknown;
  try {
    definition = JSON.parse(Buffer.from(matching[0].data).toString("utf8"));
  } catch (cause) {
    throw invalid(
      "The Variable Library variables.json part is invalid.",
      cause,
    );
  }
  if (!isRecord(definition) || !Array.isArray(definition.variables)) {
    throw invalid("The Variable Library definition has no variables array.");
  }
  const names = new Set<string>();
  return definition.variables.map((variable: unknown) => {
    if (
      !isRecord(variable) ||
      typeof variable.name !== "string" ||
      !Object.hasOwn(variable, "value") ||
      names.has(variable.name)
    ) {
      throw invalid(
        "The Variable Library contains invalid or duplicate variables.",
      );
    }
    names.add(variable.name);
    return variable.name;
  });
}
