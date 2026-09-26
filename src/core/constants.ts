/**
 * Explicit API constants. The Fabric REST API version is a stated constant,
 * never inferred from response shape.
 */

export const FABRIC_API_BASE_URL = "https://api.fabric.microsoft.com/v1";

/** Livy API version segment used by Fabric Lakehouse Livy endpoints. */
export const LIVY_API_VERSION = "2023-12-01";

/**
 * Least-privilege delegated scope for the Fabric REST + Livy APIs. We
 * deliberately do not request broad Graph or management scopes.
 */
export const FABRIC_SCOPES: readonly string[] = [
  "https://api.fabric.microsoft.com/.default",
];

/** Power BI REST API (DAX queries against semantic models). */
export const POWERBI_API_BASE_URL = "https://api.powerbi.com";

export const POWERBI_SCOPES: readonly string[] = [
  "https://analysis.windows.net/powerbi/api/.default",
];

/** Kusto (Eventhouse / KQL database) queries; the generic Kusto audience. */
export const KUSTO_SCOPES: readonly string[] = [
  "https://kusto.kusto.windows.net/.default",
];

/** OneLake DFS endpoint (ADLS Gen2-compatible). */
export const ONELAKE_BASE_URL = "https://onelake.dfs.fabric.microsoft.com";

/** ADLS Gen2 REST API version sent as `x-ms-version`. */
export const ONELAKE_API_VERSION = "2023-11-03";

/** Delegated scope for OneLake (Azure Storage audience). */
export const STORAGE_SCOPES: readonly string[] = [
  "https://storage.azure.com/.default",
];
