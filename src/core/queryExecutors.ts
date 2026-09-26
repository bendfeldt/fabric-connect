/**
 * Query executors for local query files: `.kql` against a KQL database
 * (Eventhouse), `.dax` against a semantic model, `.graphql` against a
 * GraphQL API item. Each runs the file's text against an existing item —
 * reading data, never changing the item — and returns tables for display.
 *
 * T-SQL is deliberately absent (decision D2): use the Microsoft `mssql`
 * extension with the connection string from the explorer.
 */

import type { DisplayTable } from "./displayProtocol";
import { QueryError } from "./errors";
import type { IFabricApiClient } from "./types";

export type QueryKind = "kql" | "dax" | "graphql";

export interface QueryResult {
  readonly tables: DisplayTable[];
  /** The raw response, for "show JSON". */
  readonly raw: unknown;
}

/**
 * The origin of a KQL database's query URI. Which hosts may receive a
 * Kusto token is enforced by the write policy (`serviceOrigin`).
 */
export function kustoOrigin(queryServiceUri: string): string {
  try {
    return new URL(queryServiceUri).origin;
  } catch (cause) {
    throw invalidKusto(queryServiceUri, cause);
  }
}

export async function runKql(
  api: IFabricApiClient,
  tenantId: string,
  queryServiceUri: string,
  database: string,
  query: string,
): Promise<QueryResult> {
  const origin = kustoOrigin(queryServiceUri);
  const response = await wrap("run KQL query", `KQL database ${database}`, () =>
    api.request<{ Tables?: Array<Record<string, unknown>> }>({
      method: "POST",
      path: "/v1/rest/query",
      tenantId,
      service: { kind: "kusto", origin },
      body: { db: database, csl: query },
    }),
  );
  const tables = (response.body?.Tables ?? []).map(kustoTable);
  // v1 responses end with a table of contents naming the real result sets.
  const toc = tables[tables.length - 1];
  const kindAt = toc?.columns.indexOf("Kind") ?? -1;
  const ordinalAt = toc?.columns.indexOf("Ordinal") ?? -1;
  let results = tables.slice(0, 1);
  if (tables.length > 1 && kindAt !== -1 && ordinalAt !== -1) {
    results = toc.rows
      .filter((row) => row[kindAt] === "QueryResult")
      .map((row) => tables[Number(row[ordinalAt])])
      .filter((t): t is DisplayTable => t !== undefined);
  }
  return { tables: results, raw: response.body };
}

export async function runDax(
  api: IFabricApiClient,
  tenantId: string,
  workspaceId: string,
  semanticModelId: string,
  query: string,
): Promise<QueryResult> {
  const response = await wrap("run DAX query", "semantic model", () =>
    api.request<{
      results?: Array<{
        tables?: Array<{ rows?: Array<Record<string, unknown>> }>;
        error?: unknown;
      }>;
      error?: unknown;
    }>({
      method: "POST",
      path: `/v1.0/myorg/groups/${workspaceId}/datasets/${semanticModelId}/executeQueries`,
      tenantId,
      service: { kind: "powerbi" },
      body: {
        queries: [{ query }],
        serializerSettings: { includeNulls: true },
      },
    }),
  );
  const body = response.body ?? {};
  const error = body.error ?? body.results?.[0]?.error;
  if (error !== undefined) {
    throw new QueryError(`The DAX query failed: ${errorText(error)}`, {
      operation: "run DAX query",
      entity: "semantic model",
      remediation:
        "Fix the query (it must start with EVALUATE) and run it again.",
    });
  }
  const tables = (body.results?.[0]?.tables ?? []).map((t) => {
    const rows = t.rows ?? [];
    const columns: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) {
          columns.push(key);
        }
      }
    }
    return {
      columns,
      rows: rows.map((row) => columns.map((c) => row[c] ?? null)),
      truncated: false,
    };
  });
  return { tables, raw: body };
}

export async function runGraphql(
  api: IFabricApiClient,
  tenantId: string,
  workspaceId: string,
  graphqlApiId: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<QueryResult> {
  const response = await wrap("run GraphQL query", "GraphQL API", () =>
    api.request<{ data?: unknown; errors?: unknown[] }>({
      method: "POST",
      path: `/workspaces/${workspaceId}/graphqlapis/${graphqlApiId}/graphql`,
      tenantId,
      body: variables === undefined ? { query } : { query, variables },
    }),
  );
  const body = response.body ?? {};
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new QueryError(
      `The GraphQL query failed: ${body.errors.map(errorText).join("; ")}`,
      {
        operation: "run GraphQL query",
        entity: "GraphQL API",
        remediation: "Fix the query against the API's schema and run it again.",
      },
    );
  }
  return { tables: graphqlTables(body.data), raw: body };
}

/** Tables for every `items` list (Fabric GraphQL's collection shape). */
export function graphqlTables(data: unknown): DisplayTable[] {
  const tables: DisplayTable[] = [];
  if (typeof data !== "object" || data === null) {
    return tables;
  }
  for (const value of Object.values(data as Record<string, unknown>)) {
    const items =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)["items"]
        : undefined;
    if (!Array.isArray(items)) {
      continue;
    }
    const records = items.filter(
      (i): i is Record<string, unknown> =>
        typeof i === "object" && i !== null && !Array.isArray(i),
    );
    const columns: string[] = [];
    for (const record of records) {
      for (const key of Object.keys(record)) {
        if (!columns.includes(key)) {
          columns.push(key);
        }
      }
    }
    tables.push({
      columns,
      rows: records.map((r) => columns.map((c) => r[c] ?? null)),
      truncated: false,
    });
  }
  return tables;
}

/** Splits an optional `# variables: {…}` header line off a GraphQL file. */
export function splitGraphqlVariables(text: string): {
  query: string;
  variables?: Record<string, unknown>;
} {
  const match = /^#\s*variables\s*:(.*)$/m.exec(text);
  if (match === null) {
    return { query: text };
  }
  let variables: unknown;
  try {
    variables = JSON.parse(match[1].trim());
  } catch (cause) {
    throw new QueryError("The '# variables:' line is not valid JSON.", {
      operation: "run GraphQL query",
      remediation: 'Write it as # variables: {"name": "value"}.',
      cause,
    });
  }
  if (
    typeof variables !== "object" ||
    variables === null ||
    Array.isArray(variables)
  ) {
    throw new QueryError("The '# variables:' line must be a JSON object.", {
      operation: "run GraphQL query",
      remediation: 'Write it as # variables: {"name": "value"}.',
    });
  }
  return { query: text, variables: variables as Record<string, unknown> };
}

function kustoTable(table: Record<string, unknown>): DisplayTable {
  const columns = Array.isArray(table["Columns"])
    ? (table["Columns"] as Array<Record<string, unknown>>).map((c) =>
        String(c["ColumnName"] ?? ""),
      )
    : [];
  const rows = Array.isArray(table["Rows"])
    ? (table["Rows"] as unknown[]).filter(Array.isArray)
    : [];
  return { columns, rows: rows as unknown[][], truncated: false };
}

async function wrap<T>(
  operation: string,
  entity: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    throw new QueryError(`Failed to ${operation}.`, {
      operation,
      entity,
      remediation:
        "Check the query and that your account can read the item, then run it again.",
      cause,
    });
  }
}

function errorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const nested = record["error"];
    if (typeof nested === "object" && nested !== null) {
      return errorText(nested);
    }
    const message =
      record["message"] ?? record["details"] ?? record["code"] ?? undefined;
    if (typeof message === "string") {
      return message;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

function invalidKusto(uri: string, cause?: unknown): QueryError {
  return new QueryError(
    "The KQL database's query URI is not a valid URL, so the query was not sent.",
    {
      operation: "run KQL query",
      entity: `query URI ${uri}`,
      remediation:
        "Re-pick the KQL database with 'Fabric: Change Query Target'; its URI must be https://…kusto.fabric.microsoft.com.",
      cause,
    },
  );
}
